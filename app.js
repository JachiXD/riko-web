// Riko, in the browser. Free end to end: the browser recognizes speech and speaks for her.
// The avatar and the mouth movement are the same approach as the original client/index.html.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

/* ───────────────────────── 3D: her body ───────────────────────── */

const host = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 20);
const light = new THREE.DirectionalLight(0xffffff, Math.PI);
light.position.set(1, 1, 1);
scene.add(light);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let vrm = null;
let vrmReady = false; // set once the model is on screen
let voiceSettled = false; // set once voice preparation has finished, either way
let brainSettled = false; // set once the conversation model has been checked
let brainNote = 'unknown'; // 'ready' | 'unreachable' | 'nokey'
let controls = null;
let rig = null; // bones we animate, with their rest rotation remembered
let hasBlink = false;
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

try {
  const gltf = await loader.loadAsync('./riko.vrm');
  vrm = gltf.userData.vrm;
  VRMUtils.rotateVRM0(vrm); // older VRM 0.x models face away without this
  scene.add(vrm.scene);

  // Arms down, as in the original. VRM 0.x models are mirrored on this axis.
  const arm = vrm.meta?.metaVersion === '0' ? -1.3 : 1.3;
  vrm.humanoid.getNormalizedBoneNode('leftUpperArm').rotation.z = -arm;
  vrm.humanoid.getNormalizedBoneNode('rightUpperArm').rotation.z = arm;

  // Frame the camera by her body size, so short and tall models look the same.
  // Measuring the bounding box is more reliable than bone heights: models differ in scale
  // and some put the hips or head at an offset that a single bone reading gets wrong.
  vrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const span = box.max.y - box.min.y;
  const height = span > 0.3 && span < 20 ? span : 1.6; // guard against odd bounds
  const chestY = box.min.y + height * 0.74; // she is framed from the waist up
  camera.position.set(0, chestY + height * 0.06, height * 1.24);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, chestY, 0);
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.minDistance = height * 0.4;
  controls.maxDistance = height * 3.2;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  vrmReady = true;
  maybeFinishBoot();

  // Capture the rest pose so the idle and talking motion can add to it rather than
  // fight the arm pose set above.
  rig = {};
  for (const name of ['hips', 'spine', 'chest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm']) {
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    if (node) rig[name] = { node, base: node.rotation.clone() };
  }
  hasBlink = !!vrm.expressionManager?.getExpression?.('blink');
} catch (err) {
  console.error(err);
  document.getElementById('boot').innerHTML =
    '<div>Her model did not load.<small>riko.vrm is missing or blocked — check the console.</small></div>';
}

/* ─────────────────── Lip sync: mouth follows her voice ─────────────────── */

// The original measures the loudness of a playing audio clip. Browser voices do not expose
// their audio, so we synthesize a matching envelope while she speaks. If a real audio clip
// is ever wired in, set `meter` to a function returning 0..1 loudness and it takes over.
let meter = null;
let speaking = false;
let speechRun = 0; // bumped on every new line, so an interrupted line stops mid-sentence
let mouth = 0;
let mouthTarget = 0;
let wobble = 0;

/* ─────────────────── Her body: breathing, sway, talking ─────────────────── */
// Nothing is animated in the model file itself, so she stands frozen. This adds the small
// movements a person makes: breathing, weight shifting, head turning, nodding on words,
// and blinking. Everything scales up when she talks and back down when she stops.

let motionT = 0;
let talkAmount = 0; // 0 = quiet, 1 = mid-sentence, eased so it never snaps
let blinkWait = 2.5;
let blinkPhase = -1;

function animateBody(dt) {
  motionT += dt;
  talkAmount += ((speaking ? 1 : 0) - talkAmount) * Math.min(1, dt * 4);

  if (rig) {
    const set = (name, x, y, z) => {
      const b = rig[name];
      if (b) b.node.rotation.set(b.base.x + x, b.base.y + y, b.base.z + z);
    };

    // Breathing and a slow weight shift through the whole torso — this is what stops her
    // reading as a still image with a moving mouth.
    const breathe = Math.sin(motionT * 1.05) * 0.022;
    set('hips', 0, 0, Math.sin(motionT * 0.23) * 0.045);
    set('spine', breathe * 0.6, Math.sin(motionT * 0.37) * 0.07, Math.sin(motionT * 0.29) * 0.05);
    set('chest', breathe, Math.sin(motionT * 0.37) * 0.035, 0);

    const nod = mouth * 0.075 + Math.abs(Math.sin(motionT * 1.5)) * 0.05 * talkAmount;
    set(
      'head',
      -nod + Math.sin(motionT * 1.15) * 0.03 + Math.sin(motionT * 2.9) * 0.012 * talkAmount,
      Math.sin(motionT * 0.43) * 0.16 + Math.sin(motionT * 1.8) * 0.05 * talkAmount,
      Math.sin(motionT * 0.62) * 0.04,
    );
    set('neck', nod * 0.4, Math.sin(motionT * 0.43) * 0.06, 0);

    // Arms rest with a gentle sway, then lift and bend into a gesture while she speaks —
    // elbows are where a talking pose reads, so the forearms carry most of the movement.
    const swing = Math.sin(motionT * 1.6) * 0.05 + Math.sin(motionT * 2.9) * 0.06 * talkAmount;
    const bend = 0.05 + 0.12 * talkAmount + 0.04 * Math.max(0, Math.sin(motionT * 2.3)) * talkAmount;
    set('leftUpperArm', swing, 0, -0.05 * talkAmount);
    set('rightUpperArm', -swing, 0, 0.05 * talkAmount);
    set('leftLowerArm', 0, 0, -bend);
    set('rightLowerArm', 0, 0, bend);

    // A few millimetres of vertical float, so her whole body reads as breathing.
    if (vrm) vrm.scene.position.y = Math.sin(motionT * 1.05) * 0.014;
  }

  // Blinking: irregular intervals, a fast close and open, not a metronome.
  if (hasBlink && vrm?.expressionManager) {
    blinkWait -= dt;
    if (blinkWait <= 0) { blinkWait = 2 + Math.random() * 4; blinkPhase = 0; }
    if (blinkPhase >= 0) {
      blinkPhase += dt / 0.16;
      const v = blinkPhase >= 1 ? 0 : Math.sin(blinkPhase * Math.PI);
      vrm.expressionManager.setValue('blink', v);
      if (blinkPhase >= 1) blinkPhase = -1;
    }
  }
}

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  wobble += dt * 12.5;

  const env = speaking
    ? Math.min(1, 0.26 + 0.6 * Math.abs(Math.sin(wobble)) + 0.12 * Math.sin(wobble * 2.61))
    : 0;
  mouthTarget += (env - mouthTarget) * 0.42;
  mouth += (mouthTarget - mouth) * 0.34;

  animateBody(dt);

  if (vrm?.expressionManager) {
    vrm.expressionManager.setValue('aa', meter ? meter() : mouth);
    vrm.update(dt);
  }
  controls?.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);

// Preparing the speech model is CPU-heavy. On a weak machine that starves the render loop
// and the two lock each other up, so rendering is parked while the voice gets ready.
function pauseRendering(paused) {
  renderer.setAnimationLoop(paused ? null : frame);
}

/* ───────────────────────────── The page ───────────────────────────── */

const $ = (id) => document.getElementById(id);
const micBtn = $('mic');
const kbBtn = $('kb');
const newTabLink = $('newtab');
const typeForm = $('typeform');
const typed = $('typed');
const statusEl = $('status');
const lineEl = $('line');
const whoEl = $('who');
const textEl = $('text');

const setStatus = (s) => { statusEl.textContent = s; };

// Browsers refuse microphones to a page that is framed inside another page — the prompt
// never appears, so the button looks broken. Offer the way out instead of a dead end.
const inFrame = (() => {
  try { return window.self !== window.top; } catch { return true; }
})();

function offerOwnTab(message) {
  if (newTabLink) newTabLink.hidden = false;
  if (message) setStatus(message);
}

function showLine(who, text) {
  whoEl.textContent = who;
  textEl.textContent = text;
  lineEl.classList.add('show');
}

let state = 'ready';
function setState(next) {
  state = next;
  micBtn.className = '';
  if (next === 'listening') {
    micBtn.classList.add('listening');
    micBtn.textContent = '● Listening… tap to stop';
    setStatus('Go ahead, senpai — I’m listening.');
  } else if (next === 'thinking') {
    micBtn.classList.add('thinking');
    micBtn.textContent = '…';
    setStatus('Thinking…');
  } else if (next === 'speaking') {
    micBtn.textContent = '■ Tap to interrupt';
    setStatus('Riko is talking.');
  } else {
    micBtn.textContent = '🎙 Tap to talk';
    setStatus('Press the mic and say hi.');
  }
}

/* ───────────────────────────── Her ears ───────────────────────────── */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// She listens in the language she answers in, never the browser's.
const SPEECH_LANG = 'en-US';
let rec = null;

function startListening() {
  if (!SR) {
    toggleType(true);
    setStatus('This browser has no speech recognition — type to her instead.');
    return;
  }
  speechRun++;
  stopSpeech();
  speaking = false;

  // Build her voice while you are still talking, so it is ready when she answers.
  warmVoice().catch(() => {});

  rec = new SR();
  // She thinks and answers in English, so she must listen in it too. Following the
  // browser locale meant a French or German machine transcribed in that language and
  // every answer came back unrelated.
  rec.lang = SPEECH_LANG;
  rec.interimResults = true;
  // Keep the microphone open across natural pauses instead of cutting the person off
  // at their first comma.
  rec.continuous = true;
  rec.maxAlternatives = 5;

  let finalText = '';
  let interimText = '';
  let lowestConfidence = 1;
  let silenceTimer = null;

  const armSilence = () => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      try { rec.stop(); } catch { /* already stopping */ }
    }, 2400);
  };

  setState('listening');

  rec.onresult = (event) => {
    interimText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const best = result[0];
      const text = best?.transcript || '';
      if (result.isFinal) {
        finalText += text;
        if (typeof best.confidence === 'number' && best.confidence > 0) {
          lowestConfidence = Math.min(lowestConfidence, best.confidence);
        }
      } else {
        interimText += text;
      }
    }
    const heard = (finalText || interimText).trim();
    if (heard) showLine('You', heard);
    armSilence();
  };

  rec.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setState('ready');
      offerOwnTab('The microphone is blocked here. Give the browser permission, or open her in her own tab.');
      toggleType(true);
    } else if (event.error === 'no-speech') {
      setState('ready');
      setStatus('I didn’t hear anything. Try again?');
    } else if (event.error !== 'aborted') {
      setState('ready');
      setStatus(`Microphone trouble (${event.error}). Typing works too.`);
    }
  };

  rec.onend = () => {
    clearTimeout(silenceTimer);
    const said = finalText.trim();
    const partial = interimText.trim();

    if (said) {
      // A guess that low is usually a misheard word; ask instead of answering the wrong thing.
      if (lowestConfidence < 0.35) {
        setState('ready');
        setStatus('I’m not sure I heard that right — say it again?');
        return;
      }
      handleUser(said);
      return;
    }

    // Heard something, but nothing was confirmed: never send half a sentence to be answered.
    if (partial) {
      setState('ready');
      setStatus('I only caught part of that — say it once more?');
      return;
    }

    if (state === 'listening') {
      setState('ready');
      setStatus('I didn’t hear anything. Try again?');
    }
  };

  try {
    rec.start();
  } catch {
    setState('ready');
    setStatus('Could not start the mic — try again in a second.');
  }
}

function stopListening() {
  try { rec?.stop(); } catch { /* nothing to stop */ }
  if (state === 'listening') setState('ready');
}

micBtn.addEventListener('click', () => {
  ensureAudio(); // unlock sound inside the click, or phones block it later
  if (state === 'speaking') { speechRun++; stopSpeech(); speaking = false; setState('ready'); return; }
  if (state === 'listening') { stopListening(); return; }
  if (state === 'thinking') return;
  startListening();
});

function toggleType(force) {
  const show = force ?? typeForm.hidden;
  typeForm.hidden = !show;
  if (show) {
    typed.focus();
    // Typing is a heads-up that a reply is coming: warm her voice in the background.
    warmVoice().catch(() => {});
  }
}

kbBtn.addEventListener('click', () => toggleType());
typeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  ensureAudio();
  const text = typed.value.trim();
  if (!text) return;
  typed.value = '';
  toggleType(false);
  handleUser(text);
});

/* ───────────────────────────── Her voice ───────────────────────────── */


/* ═════════════════════  HER VOICE ═════════════════════
   Kokoro-82M: an 82-million-parameter neural speech model that runs inside this tab. Free,
   no account, no key, nothing leaves the device. The model is fetched once (about 88 MB),
   stored by the browser's Cache API, and reused on later visits.

   The whole engine is prepared during the loading screen — model, audio output, and a
   pre-rendered greeting — so her first word costs nothing. If preparation fails she says
   so instead of silently dropping to a system voice, and text still works. */

const VOICE_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE_NAME = 'af_heart'; // softest and warmest of her voices
const VOICE_SPEED = 0.94; // a little under real time: warmer and less clipped than 1.0
const GREETING = 'Oh — you actually showed up. I was starting to narrate the wall.';

const voice = {
  model: null,
  state: 'idle', // idle → preparing → prepared → ready | failed
  task: null,
  modelTask: null,
  error: null,
  cache: new Map(), // synthesised lines, so a repeated line is instant
  sources: new Set(),
};

let audioCtx = null;
let analyser = null;
let levelData = null;

function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    levelData = new Uint8Array(analyser.fftSize);
    analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Her mouth follows the real loudness of her own audio.
function startMeter() {
  if (!analyser) return;
  meter = () => {
    analyser.getByteTimeDomainData(levelData);
    let sum = 0;
    for (let i = 0; i < levelData.length; i++) {
      const x = (levelData[i] - 128) / 128;
      sum += x * x;
    }
    return Math.min(1, Math.sqrt(sum / levelData.length) * 5);
  };
}

/* ── Loading screen hooks ── */
const bootMsgEl = document.getElementById('bootmsg');
const bootBarEl = document.getElementById('bootbar');
const bootFillEl = document.getElementById('bootfill');
const bootRetryEl = document.getElementById('bootretry');

function bootStatus(text) {
  if (bootMsgEl) bootMsgEl.textContent = text;
}
function bootProgress(ratio) {
  if (!bootBarEl) return;
  bootBarEl.hidden = false;
  bootFillEl.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}
function bootClearProgress() {
  if (!bootBarEl) return;
  bootBarEl.hidden = true;
  bootFillEl.style.width = '0%';
}

/* ── Boot sequence: the page does not call itself ready until the voice is ── */
const bootEl = document.getElementById('boot');
const unmuteBtn = document.getElementById('unmute');

function maybeFinishBoot() {
  // Her body, her voice and her brain all have to be ready before the screen lifts.
  if (!vrmReady || !voiceSettled || !brainSettled) return;
  bootEl.classList.add('gone');

  if (brainNote === 'nokey') setStatus('Add a Gemini key in ⚙ so she can think — then say hi.');
  else if (brainNote === 'unreachable') setStatus('I could not reach Gemini — check the key in ⚙.');
  else setStatus('Press the mic and say hi.');

  // She says hello in writing straight away. Her voice is only built when there is
  // something you actually asked her to say — building it unprompted at load froze
  // the page in testing.
  showLine('Riko', GREETING);
}

/* Confirm the conversation model before handing the page over, so a bad key shows up on the
   loading screen instead of in the middle of a chat. One cheap request that costs no tokens. */
async function prepareBrain() {
  bootStatus('Checking her brain…');

  if (!apiKey()) {
    brainNote = 'nokey';
    brainSettled = true;
    maybeFinishBoot();
    return;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);

  try {
    const res = await fetch(API_ROOT, { headers: { 'x-goog-api-key': apiKey() }, signal: abort.signal });
    brainNote = res.ok ? 'ready' : 'unreachable';
    if (!res.ok) console.warn('[brain] key check returned', res.status);
  } catch (err) {
    brainNote = 'unreachable';
    console.warn('[brain] key check failed', err);
  } finally {
    clearTimeout(timer);
    brainSettled = true;
    maybeFinishBoot();
  }
}

function startVoice() {
  voiceSettled = false;
  prepareVoice()
    .then(() => {
      bootProgress(1);
      bootStatus('Riko is ready.');
    })
    .catch(() => {
      bootStatus('Her voice could not load — typing still works.');
      if (bootRetryEl) bootRetryEl.hidden = false;
    })
    .finally(() => {
      voiceSettled = true;
      maybeFinishBoot();
    });
}

bootRetryEl?.addEventListener('click', () => {
  bootStatus('Trying her voice again…');
  bootClearProgress();
  startVoice();
});

// Browsers only allow sound after a real interaction; unlock it on the first one.
function unlockAudio() {
  const ctx = ensureAudio();
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}
addEventListener('pointerdown', unlockAudio, { once: true });
addEventListener('keydown', unlockAudio, { once: true });

/* ── Preparation: fetch the voice while the loading screen is up ──
   The weights are pulled down here and land in the browser's cache, which is the slow
   part of a first visit. Building the inference session itself happens on her first
   words: doing that while the 3D scene was still starting froze weaker machines during
   testing, and a download carries none of that risk. */

const MODEL_BASE = `https://huggingface.co/${VOICE_MODEL}/resolve/main/`;
const VOICE_FILES = ['onnx/model_quantized.onnx', 'config.json', 'tokenizer.json', 'tokenizer_config.json'];

function prepareVoice() {
  if (voice.task) return voice.task;
  if (voice.state === 'prepared' || voice.state === 'ready') return Promise.resolve();

  voice.state = 'preparing';
  voice.error = null;
  if (bootRetryEl) bootRetryEl.hidden = true;
  bootStatus('Preparing voice…');
  bootProgress(0);

  voice.task = (async () => {
    bootStatus('Initializing audio…');
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    bootStatus('Loading voice resources…');
    let finished = 0;

    await Promise.all(
      VOICE_FILES.map(async (file) => {
        try {
          const res = await fetch(MODEL_BASE + file);
          if (!res.ok) return;
          const total = Number(res.headers.get('content-length') || 0);
          if (!res.body || !total) {
            await res.arrayBuffer();
          } else {
            const reader = res.body.getReader();
            let loaded = 0;
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              loaded += chunk.value?.length || 0;
              bootProgress((finished + Math.min(1, loaded / total)) / VOICE_FILES.length);
            }
          }
        } catch (err) {
          console.warn('[voice] could not preload', file, err);
        } finally {
          finished += 1;
          bootProgress(finished / VOICE_FILES.length);
        }
      }),
    );

    voice.state = 'prepared';
    bootStatus('Voice resources ready');
  })()
    .catch((err) => {
      console.error('[voice] preparation failed', err);
      voice.state = 'failed';
      voice.error = err;
      throw err;
    })
    .finally(() => {
      voice.task = null;
    });

  return voice.task;
}

/* ── Build the session, once, on her first words ── */
let voiceWarm = null;

function warmVoice() {
  if (!voiceWarm) {
    voiceWarm = ensureModel().catch((err) => {
      voiceWarm = null;
      throw err;
    });
  }
  return voiceWarm;
}

function ensureModel() {
  if (voice.model) return Promise.resolve(voice.model);
  if (voice.modelTask) return voice.modelTask;

  setStatus('Preparing her voice…');
  pauseRendering(true);

  voice.modelTask = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    const load = (device) => KokoroTTS.from_pretrained(VOICE_MODEL, { dtype: 'q8', device });

    const tryGpu = !!navigator.gpu && !voice.gpuBroken;
    try {
      voice.model = await load(tryGpu ? 'webgpu' : 'wasm');
    } catch (err) {
      console.warn('[voice] GPU path unavailable, using CPU', err);
      voice.gpuBroken = tryGpu; // remember, so a retry does not stall on it again
      voice.model = await load('wasm');
    }

    voice.state = 'ready';
    return voice.model;
  })()
    .catch((err) => {
      console.error('[voice] model failed to load', err);
      voice.state = 'failed';
      voice.error = err;
      throw err;
    })
    .finally(() => {
      voice.modelTask = null;
      pauseRendering(false);
    });

  return voice.modelTask;
}

/* ── Speaking ── */
function synth(text, speed = VOICE_SPEED) {
  const key = `${speed.toFixed(2)}|${text}`;
  const cached = voice.cache.get(key);
  if (cached) return Promise.resolve(cached);

  return Promise.resolve(voice.model.generate(text, { voice: VOICE_NAME, speed })).then((audio) => {
    const ctx = ensureAudio();
    const buffer = ctx.createBuffer(1, audio.audio.length, audio.sampling_rate);
    buffer.copyToChannel(audio.audio, 0);
    if (voice.cache.size > 80) voice.cache.clear();
    voice.cache.set(key, buffer);
    return buffer;
  });
}

// Splits a reply into sentences so each one is synthesised on its own. That is what gives
// her somewhere to breathe: separate utterances, separate intonation, real gaps between them.
function sentences(text) {
  const parts = text.match(/[^.!?…]+[.!?…]*/g) || [text];
  return parts
    .flatMap((part) => {
      const clean = part.trim();
      // A long sentence gets a breath at its commas; short ones stay whole.
      if (clean.length > 120) {
        const clauses = clean.split(/,\s+/);
        return clauses.map((clause, i) => (i < clauses.length - 1 ? `${clause},` : clause));
      }
      return clean;
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

// Loanwords spelled the way an English voice reads correctly.
const SPELLING = [
  [/\bsenpai\b/gi, 'sempai'],
  [/\barigatou\b/gi, 'ah-ree-gah-toh'],
  [/\bkonnichiwa\b/gi, 'kon-nee-chee-wah'],
  [/\bsayonara\b/gi, 'sah-yoh-nah-rah'],
  [/\bkawaii\b/gi, 'kah-wah-ee'],
  [/\bonegai\b/gi, 'oh-neh-guy'],
  [/\bitadakimasu\b/gi, 'ee-tah-dah-kee-mahs'],
];

function pronounce(text) {
  return SPELLING.reduce((out, [re, say]) => out.replace(re, say), text);
}

function stopSpeech() {
  meter = null;
  for (const source of voice.sources) {
    try { source.stop(); } catch { /* already finished */ }
  }
  voice.sources.clear();
}

// Speech is fed to her as the model writes it: the first clause is synthesised and starts
// playing while the rest of the answer is still arriving, instead of waiting for the whole
// reply and then the whole first sentence.
function speechBoundary(text, final) {
  const stop = text.match(/[.!?…](\s|$)/);
  if (stop) return stop.index + 1;
  if (text.length > 90) {
    const clause = text.search(/[,;:]\s/);
    if (clause > 20) return clause + 1;
  }
  return final && text.trim() ? text.length : -1;
}

let voiceFailureNoted = false;
function noteVoiceFailed() {
  if (voiceFailureNoted) return;
  voiceFailureNoted = true;
  setStatus('Her voice will not load on this device — she can still answer in text.');
}

function createSpeaker(run) {
  const ctx = ensureAudio();
  let pending = '';
  let chain = Promise.resolve();
  let clock = 0;

  const speakPiece = async (piece) => {
    if (run !== speechRun || !ctx) return;

    try {
      await warmVoice();
    } catch (err) {
      console.warn('[voice] unavailable, answering in text only', err);
      noteVoiceFailed();
      return;
    }

    const buffer = await synth(piece);
    if (run !== speechRun) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    const at = Math.max(clock, ctx.currentTime + 0.03);
    source.start(at);
    voice.sources.add(source);
    source.onended = () => voice.sources.delete(source);

    clock = at + buffer.duration + (piece.trim().endsWith('?') ? 0.3 : 0.18);
  };

  const drain = (final) => {
    for (;;) {
      const cut = speechBoundary(pending, final);
      if (cut < 0) return;
      const piece = pending.slice(0, cut).trim();
      pending = pending.slice(cut);
      if (piece) chain = chain.then(() => speakPiece(piece));
    }
  };

  return {
    push(chunk) {
      pending += chunk;
      drain(false);
    },
    async finish() {
      drain(true);
      await chain;
      if (ctx) {
        // Stay "speaking" until the audio clock has actually run out.
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, (clock - ctx.currentTime) * 1000)));
      }
    },
  };
}

/* ───────────────────────────── Her brain ───────────────────────────── */
// A real language model (Gemini) called straight from the page, with a key that lives only
// in this browser. Her memory is a small list of facts about you, also kept in this browser.

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash'];
const KEY_STORE = 'riko.gemini.key.v1';
const MEM_STORE = 'riko.memory.v1';
const CHAT_STORE = 'riko.chat.v1';
const MAX_TURNS = 14;

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing: nothing persists, but the conversation still works */
  }
}

const apiKey = () => {
  try { return (localStorage.getItem(KEY_STORE) || '').trim(); } catch { return ''; }
};

/* ── Memory: facts worth keeping, never a transcript ── */
let memories = [];

function loadMemories() {
  const saved = readStored(MEM_STORE, []);
  memories = Array.isArray(saved) ? saved.filter((m) => m && typeof m.text === 'string') : [];
  renderMemories();
}

const normalise = (text) => text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function saveMemories() {
  writeStored(MEM_STORE, memories);
  renderMemories();
}

function addMemory(text, source = 'auto') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (clean.length < 3) return false;
  const key = normalise(clean);
  if (!key) return false;
  // Same fact twice, in slightly different words, is still one memory.
  if (memories.some((m) => normalise(m.text) === key)) return false;
  if (memories.some((m) => normalise(m.text).includes(key) || key.includes(normalise(m.text)) ) && key.length > 12) return false;

  memories.unshift({
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    text: clean,
    source,
    at: Date.now(),
  });
  if (memories.length > 60) memories.length = 60;
  saveMemories();
  return true;
}

function editMemory(id, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!clean) return deleteMemory(id);
  const found = memories.find((m) => m.id === id);
  if (found) {
    found.text = clean;
    found.at = Date.now();
    saveMemories();
  }
}

function deleteMemory(id) {
  memories = memories.filter((m) => m.id !== id);
  saveMemories();
}

function clearMemories() {
  memories = [];
  saveMemories();
}

/* ── Conversation: short-term context, kept across a refresh too ── */
let history = [];

function loadHistory() {
  const saved = readStored(CHAT_STORE, []);
  history = Array.isArray(saved) ? saved.filter((t) => t && typeof t.text === 'string').slice(-MAX_TURNS * 2) : [];
}

function rememberTurn(role, text) {
  history.push({ role, text });
  if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);
  writeStored(CHAT_STORE, history);
}

function systemPrompt() {
  const facts = memories.slice(0, 40).map((m) => `- ${m.text}`).join('\n');

  return [
    'You are Riko: a warm, playful, naturally curious girl chatting with someone you are fond of.',
    'How you talk:',
    '- Like a real person in a live conversation, not an assistant writing an essay.',
    '- Everything you write is spoken aloud, so keep it to one to three short sentences. No lists, no markdown, no emoji.',
    '- React to the specific thing they just said, and to what came before in this conversation.',
    '- Be a little teasing and playful sometimes, and genuinely curious other times. Never sound scripted.',
    '- If you are not sure what they meant, say so and ask. Never invent what they said, and never pretend to remember something you were not told.',
    '- If they ask something you do not know, admit it plainly instead of making something up.',
    '- Answer in the language they used.',
    facts
      ? `What you remember about them from previous chats:\n${facts}\nUse these naturally when they matter. Do not recite them or list them.`
      : 'You have no saved memories about them yet. Ask about them when it fits naturally.',
  ].join('\n');
}

async function callGemini(body, model) {
  const res = await fetch(`${API_ROOT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Gemini ${res.status}: ${detail.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

async function streamModel(body, model, onText) {
  const res = await fetch(`${API_ROOT}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Gemini ${res.status}: ${detail.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const json = JSON.parse(payload);
        const parts = json?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((part) => part.text || '').join('');
        if (text) {
          full += text;
          onText(text);
        }
      } catch {
        /* a keep-alive or a split frame: ignore it */
      }
    }
  }

  return full.trim();
}

// Her words arrive as they are written, so she can start answering before finishing.
async function streamRiko(onText) {
  const contents = history
    .filter((turn) => turn.text)
    .map((turn) => ({ role: turn.role === 'riko' ? 'model' : 'user', parts: [{ text: turn.text }] }));

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    contents,
    generationConfig: { temperature: 0.95, topP: 0.95, maxOutputTokens: 160 },
  };

  let lastError;
  for (const model of MODELS) {
    try {
      return await streamModel(body, model, onText);
    } catch (err) {
      lastError = err;
      if (err.status === 404) continue; // model name retired: try the next one
      throw err;
    }
  }
  throw lastError;
}

// After a turn, work out whether anything durable was said about the person. One tiny call,
// and only facts they volunteered — never guesses, never whole messages.
async function learnFrom(userText, replyText) {
  if (!apiKey()) return;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              'A person just talked to Riko. Read the turn below.',
              `Person: ${userText}`,
              `Riko: ${replyText}`,
              '',
              'Return a JSON array of short, durable facts about the person that would be worth remembering in a future conversation:',
              'their name or what they like to be called, preferences, interests, ongoing projects, people or pets they mention, how they like to be spoken to.',
              'Rules: only facts they stated about themselves in this turn. Never guess. Never store small talk, questions, or anything about Riko.',
              'Write each fact as a short third-person sentence, e.g. "Loves Genshin Impact", "Prefers to be called Jay".',
              'Return [] if there is nothing worth keeping.',
            ].join('\n'),
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.1, maxOutputTokens: 220, responseMimeType: 'application/json' },
  };

  try {
    const raw = await callGemini(body, MODELS[0]);
    const facts = JSON.parse(raw);
    if (Array.isArray(facts)) facts.slice(0, 4).forEach((fact) => addMemory(fact, 'auto'));
  } catch (err) {
    console.warn('[memory] could not learn from that turn', err);
  }
}

/* ── The loop ── */
let lastUserText = '';
let lastUserAt = 0;

async function handleUser(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    setStatus('I didn’t catch that — say it again?');
    return;
  }
  // The same utterance arriving twice (a double tap, a repeated final result) is one message.
  if (clean === lastUserText && Date.now() - lastUserAt < 8000) return;
  lastUserText = clean;
  lastUserAt = Date.now();

  showLine('You', clean);

  if (!apiKey()) {
    setState('ready');
    const msg = 'I can’t think yet, senpai — I need a Gemini key. Tap ⚙ and paste one in.';
    showLine('Riko', msg);
    setStatus('No API key set — open ⚙ to add one.');
    openPanel();
    return;
  }

  rememberTurn('user', clean);

  const run = ++speechRun;
  stopSpeech();
  speaking = true;
  setState('thinking');
  startMeter();

  try {
    // Her voice builds in the background; the words do not wait for it.
    setState('speaking');
    const speaker = createSpeaker(run);
    let shown = '';

    const answer = await streamRiko((chunk) => {
      if (run !== speechRun) return;
      shown += chunk;
      showLine('Riko', shown.trim());
      speaker.push(chunk); // she starts talking at the first finished clause
    });

    if (!answer) throw new Error('the model returned nothing');
    await speaker.finish();
    rememberTurn('riko', answer);
    learnFrom(clean, answer); // deliberately not awaited: she has already answered
  } catch (err) {
    console.error('[brain]', err);
    setState('ready');
    const refused = err.status === 400 || err.status === 401 || err.status === 403;
    const msg = refused
      ? 'My key got refused. Check it in the ⚙ panel, senpai.'
      : 'My thoughts got tangled. Say that once more?';
    showLine('Riko', msg);
    setStatus(refused ? 'Gemini rejected the API key.' : `Could not reach Gemini (${err.message.slice(0, 60)}).`);
  }
}

/* ── Settings and memory panel ── */
const panelEl = document.getElementById('panel');
const keyInputEl = document.getElementById('keyinput');
const keyStateEl = document.getElementById('keystate');
const memListEl = document.getElementById('memlist');
const memEmptyEl = document.getElementById('memempty');

function renderMemories() {
  if (!memListEl) return;

  if (!memories.length) {
    memListEl.innerHTML = '';
    if (memEmptyEl) memEmptyEl.hidden = false;
    return;
  }
  if (memEmptyEl) memEmptyEl.hidden = true;

  memListEl.innerHTML = '';
  for (const memory of memories) {
    const item = document.createElement('li');

    const label = document.createElement('span');
    label.textContent = memory.text;

    const edit = document.createElement('button');
    edit.className = 'icon';
    edit.type = 'button';
    edit.title = 'Edit';
    edit.textContent = '✎';
    edit.addEventListener('click', () => {
      const field = document.createElement('input');
      field.value = memory.text;
      item.replaceChildren(field);
      field.focus();
      field.select();
      const commit = () => editMemory(memory.id, field.value);
      field.addEventListener('blur', commit);
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') renderMemories();
      });
    });

    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.type = 'button';
    remove.title = 'Forget this';
    remove.textContent = '✕';
    remove.addEventListener('click', () => deleteMemory(memory.id));

    item.append(label, edit, remove);
    memListEl.append(item);
  }
}

function showKeyState() {
  if (!keyStateEl) return;
  keyStateEl.textContent = apiKey()
    ? 'A key is saved in this browser.'
    : 'No key saved yet — she cannot think without one.';
}

function openPanel() {
  showKeyState();
  renderMemories();
  if (keyInputEl) keyInputEl.value = '';
  panelEl?.classList.add('open');
  panelEl?.setAttribute('aria-hidden', 'false');
}

function closePanel() {
  panelEl?.classList.remove('open');
  panelEl?.setAttribute('aria-hidden', 'true');
}

document.getElementById('settings')?.addEventListener('click', openPanel);
document.getElementById('panelclose')?.addEventListener('click', closePanel);
panelEl?.addEventListener('click', (event) => { if (event.target === panelEl) closePanel(); });

document.getElementById('keysave')?.addEventListener('click', () => {
  const value = (keyInputEl?.value || '').trim();
  if (value.length < 20) {
    if (keyStateEl) keyStateEl.textContent = 'That does not look like a key — it is too short.';
    return;
  }
  try { localStorage.setItem(KEY_STORE, value); } catch { /* private mode */ }
  if (keyInputEl) keyInputEl.value = '';
  showKeyState();
  setStatus('Key saved. Say hi to her.');
});

document.getElementById('memadd')?.addEventListener('click', () => {
  const text = prompt('Something she should remember about you?');
  if (text && addMemory(text, 'manual')) setStatus('Saved to her memory.');
});

document.getElementById('memclear')?.addEventListener('click', () => {
  if (memories.length && confirm('Forget everything she remembers about you?')) clearMemories();
});

loadMemories();
loadHistory();
showKeyState();

/* ── Boot finishes here ── */
setState('ready');
// Start once the first frame has been drawn, or on a timer if frames are paused (a tab in
// the background never runs requestAnimationFrame and would wait here forever).
requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(beginBoot, 250)));
setTimeout(() => beginBoot(), 1200);

// The loading screen walks through every system before she is handed over: her memories,
// her brain, her ears, her voice and her audio.
let bootStarted = false;

async function beginBoot() {
  if (bootStarted) return;
  bootStarted = true;

  bootStatus('Loading your memories…');
  loadMemories();

  bootStatus('Checking her brain…');
  await prepareBrain();

  startVoice(); // downloads and prepares her voice while the screen is still up
}
if (!SR) {
  setStatus('This browser has no speech recognition — type to her instead.');
} else if (inFrame) {
  offerOwnTab('Her microphone needs her own tab — open her here and the mic will work.');
}

