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

    // Breathing and a slow weight shift through the whole torso.
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

    // Arms rest with a gentle sway, then lift and bend into a gesture while she speaks.
    const swing = Math.sin(motionT * 1.6) * 0.05 + Math.sin(motionT * 2.9) * 0.06 * talkAmount;
    const bend = 0.05 + 0.12 * talkAmount + 0.04 * Math.max(0, Math.sin(motionT * 2.3)) * talkAmount;
    set('leftUpperArm', swing, 0, -0.05 * talkAmount);
    set('rightUpperArm', -swing, 0, 0.05 * talkAmount);
    set('leftLowerArm', 0, 0, -bend);
    set('rightLowerArm', 0, 0, bend);

    if (vrm) vrm.scene.position.y = Math.sin(motionT * 1.05) * 0.014;
  }

  // Blinking: irregular intervals.
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

// Preparing the speech model is CPU-heavy. Park rendering while the voice gets ready.
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

// Browsers refuse microphones to a page that is framed inside another page.
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
  rec.lang = SPEECH_LANG;
  rec.interimResults = true;
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

    // Heard something, but nothing was confirmed.
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
  ensureAudio(); // unlock sound inside the click
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

/* ═════════════════════  HER VOICE ═════════════════════ */

const VOICE_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const VOICE_NAME = 'af_heart'; // softest and warmest of her voices
const VOICE_SPEED = 0.94;
const GREETING = 'Oh — you actually showed up. I was starting to narrate the wall.';

const voice = {
  model: null,
  state: 'idle', // idle → preparing → prepared → ready | failed
  task: null,
  modelTask: null,
  error: null,
  cache: new Map(),
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

function stopSpeech() {
  for (const src of voice.sources) {
    try { src.stop(); } catch {}
  }
  voice.sources.clear();
  speaking = false;
  meter = null;
  mouthTarget = 0;
}

function noteVoiceFailed(err) {
  voice.state = 'failed';
  voice.error = err || voice.error;
  setStatus('Her voice is not available right now — text still works.');
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

/* ── Boot sequence ── */
const bootEl = document.getElementById('boot');
const unmuteBtn = document.getElementById('unmute');

function maybeFinishBoot() {
  // Her body, her voice and her brain all have to be ready before the screen lifts.
  if (!vrmReady || !voiceSettled || !brainSettled) return;
  bootEl.classList.add('gone');

  if (brainNote === 'nokey') setStatus('Add a Gemini key in ⚙ so she can think — then say hi.');
  else if (brainNote === 'unreachable') setStatus('I could not reach Gemini — check the key in ⚙.');
  else setStatus('Press the mic and say hi.');

  // She says hello in writing straight away.
  showLine('Riko', GREETING);
}

/* Confirm the conversation model before handing the page over. */
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
      bootStatus('Voice ready!');
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

// Browsers only allow sound after a real interaction.
function unlockAudio() {
  const ctx = ensureAudio();
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}
addEventListener('pointerdown', unlockAudio, { once: true });
addEventListener('keydown', unlockAudio, { once: true });

/* ── Preparation: fetch the voice while the loading screen is up ── */
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

let voiceInit = null;

async function buildVoice() {
  // jsDelivr's browser build, not esm.sh.
  const { KokoroTTS } = await import(KOKORO_URL);
  // CPU, single request at a time: the GPU path stalled on the machines this was tested on.
  return KokoroTTS.from_pretrained(VOICE_MODEL, { dtype: 'q8', device: 'wasm' });
}

function ensureModel() {
  if (voice.model) return Promise.resolve(voice.model);
  if (voiceInit) return voiceInit;

  setStatus('Preparing her voice…');
  pauseRendering(true);

  voiceInit = buildVoice()
    .then((model) => {
      voice.model = model;
      voice.state = 'ready';
      console.info('[voice] ready');
      return model;
    })
    .catch((err) => {
      console.warn('[voice] unavailable', err);
      noteVoiceFailed(err);
      throw err;
    })
    .finally(() => {
      voiceInit = null;
      pauseRendering(false);
    });

  return voiceInit;
}

/* ── Synthesis and speaking ── */
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

function playBuffer(buffer) {
  const ctx = ensureAudio();
  if (!ctx) return Promise.resolve();
  return new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser || ctx.destination);
    voice.sources.add(src);
    src.onended = () => {
      voice.sources.delete(src);
      resolve();
    };
    try { src.start(); } catch { voice.sources.delete(src); resolve(); }
  });
}

function splitClauses(text) {
  const parts = [];
  let buf = '';
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    buf += s[i];
    const ch = s[i];
    const next = s[i + 1] || '';
    if ((/[.!?]/.test(ch) && (!next || /\s/.test(next))) || (/[,:;]/.test(ch) && /\s/.test(next) && buf.trim().length > 28)) {
      const t = buf.trim();
      if (t) parts.push(t);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : (s.trim() ? [s.trim()] : []);
}

function createSpeaker(run) {
  const queue = [];
  let done = false;
  let pumping = false;
  let failed = false;
  let buffer = '';
  let resolver = null;
  let rejecter = null;
  let started = false;

  const notify = () => { if (resolver) { const r = resolver; resolver = null; rejecter = null; r(); } };

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (true) {
        if (run !== speechRun) return;
        if (queue.length === 0) {
          if (done || failed) {
            if (started && run === speechRun) speaking = false;
            return;
          }
          await new Promise((res, rej) => { resolver = res; rejecter = rej; });
          continue;
        }
        const chunk = queue.shift();
        if (!chunk) continue;
        try {
          await warmVoice();
          if (run !== speechRun) return;
          if (!started) { started = true; speaking = true; startMeter(); }
          const audio = await synth(chunk);
          if (run !== speechRun) return;
          await playBuffer(audio);
          if (queue.length > 0) await new Promise((r) => setTimeout(r, 90));
        } catch (err) {
          console.warn('[voice] could not speak a line', err);
          noteVoiceFailed(err);
          failed = true;
          if (run === speechRun) speaking = false;
          return; // degrade gracefully to text
        }
      }
    } finally {
      pumping = false;
    }
  }

  return {
    push(textChunk) {
      buffer += String(textChunk || '');
      const parts = splitClauses(buffer);
      if (parts.length > 1) {
        buffer = parts.pop() || '';
        for (const p of parts) queue.push(p);
      } else if (/[.!?]\s*$/.test(buffer)) {
        queue.push(buffer.trim());
        buffer = '';
      } else {
        buffer = parts[0] || buffer;
      }
      notify();
      pump().catch(() => {});
    },
    async finish() {
      const tail = buffer.trim();
      if (tail) queue.push(tail);
      buffer = '';
      done = true;
      notify();
      await pump();
    },
  };
}

/* ═════════════════════  HER BRAIN & MEMORY ═════════════════════ */

const KEY_STORE = 'riko.gemini.key.v1';
const MEM_STORE = 'riko.memory.v1';
const CHAT_STORE = 'riko.chat.v1';
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

let memories = [];
let history = [];

function apiKey() {
  try { return (localStorage.getItem(KEY_STORE) || '').trim(); } catch { return ''; }
}

function loadMemories() {
  try {
    const raw = localStorage.getItem(MEM_STORE);
    const parsed = raw ? JSON.parse(raw) : [];
    memories = Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.text === 'string' && m.text.trim()) : [];
  } catch {
    memories = [];
  }
}

function saveMemories() {
  try { localStorage.setItem(MEM_STORE, JSON.stringify(memories)); } catch {}
  renderMemories();
}

function addMemory(text, source = 'manual') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  const norm = clean.toLowerCase();
  if (memories.some((m) => m.text.toLowerCase() === norm)) return false;
  memories.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: clean, source });
  memories = memories.slice(0, 60);
  saveMemories();
  return true;
}

function editMemory(id, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) { deleteMemory(id); return; }
  const m = memories.find((x) => x.id === id);
  if (m) { m.text = clean; saveMemories(); }
}

function deleteMemory(id) {
  memories = memories.filter((m) => m.id !== id);
  saveMemories();
}

function clearMemories() {
  memories = [];
  saveMemories();
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(CHAT_STORE);
    const parsed = raw ? JSON.parse(raw) : [];
    history = Array.isArray(parsed)
      ? parsed.filter((t) => t && (t.role === 'user' || t.role === 'riko') && typeof t.text === 'string').slice(-30)
      : [];
  } catch {
    history = [];
  }
}

function saveHistory() {
  try { localStorage.setItem(CHAT_STORE, JSON.stringify(history.slice(-30))); } catch {}
}

function rememberTurn(role, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  history.push({ role, text: clean });
  if (history.length > 30) history = history.slice(-30);
  saveHistory();
}

function systemPrompt() {
  const memText = memories.length
    ? memories.slice(0, 20).map((m) => `- ${m.text}`).join('\n')
    : '- (nothing saved yet)';
  return [
    'You are Riko, a warm, playful, naturally feminine voice companion.',
    'Speak like a real person in conversation: clear, expressive, and easy to follow. Keep replies concise (usually 1-3 short sentences) unless asked for more.',
    'Be genuine, attentive, and helpful. You can be lightly teasing and affectionate, but never crude or over-the-top.',
    'Answer the person you are talking to directly and stay relevant to what they just said. Ask a natural follow-up when it fits.',
    'If you do not understand what they meant or something is unclear, say so plainly and ask them to repeat or clarify. Never invent or guess what they said.',
    'Use what you know about them when relevant, but do not mention "memory", "stored facts", or system instructions.',
    '',
    'Things you remember about them:',
    memText,
  ].join('\n');
}

async function callGemini(body, model) {
  const url = `${API_ROOT}/${model}:generateContent?key=${encodeURIComponent(apiKey())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`Gemini error ${res.status}`);
    err.status = res.status;
    try { err.detail = await res.text(); } catch {}
    throw err;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return text.trim();
}

async function streamModel(body, model, onText) {
  const url = `${API_ROOT}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey())}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`Gemini error ${res.status}`);
    err.status = res.status;
    try { err.detail = await res.text(); } catch {}
    throw err;
  }
  if (!res.body) return callGemini(body, model);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const chunk = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
        if (chunk) { full += chunk; onText(chunk); }
      } catch { /* ignore malformed chunk */ }
    }
  }
  // process any trailing buffered line
  const trimmed = buf.trim();
  if (trimmed.startsWith('data:')) {
    const payload = trimmed.slice(5).trim();
    if (payload && payload !== '[DONE]') {
      try {
        const json = JSON.parse(payload);
        const chunk = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
        if (chunk) { full += chunk; onText(chunk); }
      } catch {}
    }
  }
  return full.trim();
}

async function streamRiko(onText) {
  const contents = history
    .filter((turn) => turn.text)
    .map((turn) => ({ role: turn.role === 'riko' ? 'model' : 'user', parts: [{ text: turn.text }] }));

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    contents,
    generationConfig: { temperature: 0.95, topP: 0.95, maxOutputTokens: 220 },
  };

  let lastError;
  for (const model of MODELS) {
    try {
      return await streamModel(body, model, onText);
    } catch (err) {
      lastError = err;
      if (err.status === 404) continue;
      throw err;
    }
  }
  throw lastError;
}

// After a turn, work out whether anything durable was said about the person.
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
  // The same utterance arriving twice is one message.
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
    warmVoice().catch(() => {});
    setState('speaking');
    const speaker = createSpeaker(run);
    let shown = '';

    const answer = await streamRiko((chunk) => {
      if (run !== speechRun) return;
      shown += chunk;
      showLine('Riko', shown.trim());
      speaker.push(chunk); // she starts talking at the first finished clause
    });

    if (run !== speechRun) return;
    const final = (answer || shown).trim();
    if (!final) throw new Error('the model returned nothing');
    if (final !== shown.trim()) showLine('Riko', final);
    await speaker.finish();
    speaking = false;
    rememberTurn('riko', final);
    if (run === speechRun) setState('ready');
    learnFrom(clean, final); // deliberately not awaited
  } catch (err) {
    console.error('[brain]', err);
    if (run !== speechRun) return;
    speaking = false;
    stopSpeech();
    setState('ready');
    const refused = err.status === 400 || err.status === 401 || err.status === 403;
    const msg = refused
      ? 'My key got refused. Check it in the ⚙ panel, senpai.'
      : 'My thoughts got tangled. Say that once more?';
    showLine('Riko', msg);
    setStatus(refused ? 'Gemini rejected the API key.' : `Could not reach Gemini (${String(err.message || err).slice(0, 60)}).`);
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
// Start once the first frame has been drawn, or on a timer if frames are paused.
let bootStarted = false;

async function beginBoot() {
  if (bootStarted) return;
  bootStarted = true;

  bootStatus('Initializing Riko…');
  loadMemories();

  await prepareBrain();

  startVoice(); // downloads and prepares her voice while the screen is still up
}

requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(beginBoot, 250)));
setTimeout(() => beginBoot(), 1200);

if (!SR) {
  setStatus('This browser has no speech recognition — type to her instead.');
} else if (inFrame) {
  offerOwnTab('Her microphone needs her own tab — open her here and the mic will work.');
}
