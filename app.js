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
let greetingPending = false;
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

  rec = new SR();
  rec.lang = navigator.language?.toLowerCase().startsWith('en') ? navigator.language : 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  let finalText = '';
  setState('listening');

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    const heard = (finalText || interim).trim();
    if (heard) showLine('You', heard);
    if (finalText.trim()) { try { rec.stop(); } catch { /* already stopping */ } }
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
    if (finalText.trim()) handleUser(finalText.trim());
    else if (state === 'listening') setState('ready');
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
  if (show) typed.focus();
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

// Two things decide how human she sounds. First, which voice gets picked: the old robotic
// ones sort first alphabetically, so we rank by name and put neural/online/premium voices
// at the top. Second, an English voice reading "senpai" says it wrong — those words are
// handed to a Japanese voice instead, with the correct kana so the pronunciation is right.

const EN_HINTS = [
  'natural', 'neural', 'premium', 'enhanced', 'online', // the good ones
  'google uk english female', 'google us english', 'google uk english',
  'samantha', 'ava', 'aria', 'jenny', 'sonia', 'libby', 'michelle', 'emma',
  'allison', 'karen', 'moira', 'tessa', 'serena', 'kate', 'female',
];
const JA_HINTS = [
  'natural', 'neural', 'premium', 'enhanced', 'online',
  'google 日本語', 'google japanese', 'kyoko', 'nanami', 'haruka', 'ayumi',
  'o-ren', 'japanese', '女性',
];

function bestVoice(hints, langPrefix) {
  const all = speechSynthesis.getVoices();
  const list = all.filter((v) => v.lang.toLowerCase().startsWith(langPrefix));
  if (!list.length) return null;
  const rank = (v) => {
    const name = v.name.toLowerCase();
    const i = hints.findIndex((h) => name.includes(h));
    return i === -1 ? hints.length + (v.localService ? 1 : 0) : i;
  };
  return list.slice().sort((a, b) => rank(a) - rank(b))[0];
}

let voicesWarm = false;
function warmVoices() { voicesWarm = true; }
if ('speechSynthesis' in window) {
  // Some browsers fill the voice list asynchronously; touching it early means the first
  // line is spoken with the good voice rather than whatever loaded first.
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = warmVoices;
}

// Romanised Japanese, spoken properly: kana for the Japanese voice, and the same kana
// mapped back by hand when a machine has no Japanese voice at all.
const JP_WORDS = {
  senpai: 'せんぱい', sempai: 'せんぱい', arigatou: 'ありがとう', arigato: 'ありがとう',
  konnichiwa: 'こんにちは', konbanwa: 'こんばんは', ohayou: 'おはよう', kawaii: 'かわいい',
  sugoi: 'すごい', baka: 'ばか', hai: 'はい', iie: 'いいえ', sayonara: 'さようなら',
  onegai: 'おねがい', itadakimasu: 'いただきます', neko: 'ねこ', desu: 'です',
  chan: 'ちゃん', kun: 'くん', san: 'さん', sama: 'さま', nani: 'なに',
  suki: 'すき', daisuki: 'だいすき', yatta: 'やった',
};
const JP_RE = new RegExp(`\\b(${Object.keys(JP_WORDS).join('|')})\\b`, 'gi');
const KANA_RE = /[\u3040-\u30ff\u4e00-\u9fff]/;

// Splits a line into pieces, each tagged with the language that should speak it.
function chunks(text, hasJapaneseVoice) {
  const out = [];
  let last = 0;
  let match;
  JP_RE.lastIndex = 0;
  while ((match = JP_RE.exec(text)) !== null) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), lang: 'en' });
    const kana = JP_WORDS[match[1].toLowerCase()];
    out.push(hasJapaneseVoice ? { text: kana, lang: 'ja' } : { text: match[1], lang: 'en' });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), lang: 'en' });
  return out
    .map((c) => ({ ...c, lang: KANA_RE.test(c.text) ? 'ja' : c.lang }))
    .filter((c) => c.text.trim());
}

function speakPart(text, voice) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) utterance.voice = voice;
    utterance.rate = 0.97;
    utterance.pitch = 1.06;
    utterance.volume = 1;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };

    utterance.onboundary = () => { mouthTarget = Math.min(1, mouthTarget + 0.3); };
    utterance.onend = finish;
    utterance.onerror = finish;

    speechSynthesis.speak(utterance);

    // Some browsers never fire onend after a cancel; never get stuck speaking.
    const guard = setTimeout(finish, 3000 + text.length * 240);
  });
}

/* ═════════════════════  HER VOICE ═════════════════════
   Kokoro-82M: an 82-million-parameter neural speech model that runs inside this tab. Free,
   no account, no key, nothing leaves the device. The model is fetched once (about 88 MB),
   stored by the browser's Cache API, and reused on later visits.

   The whole engine is prepared during the loading screen — model, audio output, and a
   pre-rendered greeting — so her first word costs nothing. If preparation fails she says
   so instead of silently dropping to a system voice, and text still works. */

const VOICE_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE_NAME = 'af_heart'; // softest and warmest of her voices
const VOICE_SPEED = 0.98; // a shade under real time reads as relaxed rather than rushed
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
  if (!vrmReady || !voiceSettled) return;
  bootEl.classList.add('gone');
  greet();
}

function greet() {
  if (voice.state === 'failed' || state !== 'ready') return;
  const ctx = ensureAudio();
  if (!ctx || ctx.state !== 'running') {
    // Browsers block sound until the visitor interacts. Ask, rather than pretend.
    greetingPending = true;
    if (unmuteBtn) unmuteBtn.hidden = false;
    return;
  }
  greetingPending = false;
  if (unmuteBtn) unmuteBtn.hidden = true;
  showLine('Riko', GREETING);
  say(GREETING);
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

async function unlockAudio() {
  const ctx = ensureAudio();
  // resume() is asynchronous, so wait for it before deciding whether she can be heard.
  if (ctx && ctx.state !== 'running') await ctx.resume().catch(() => {});
  if (unmuteBtn) unmuteBtn.hidden = true;
  if (greetingPending) greet();
}

if (unmuteBtn) unmuteBtn.addEventListener('click', unlockAudio);

// Any first touch is enough to unlock audio; if the greeting was waiting on it, speak now.
addEventListener('pointerdown', unlockAudio, { once: true });

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
function ensureModel() {
  if (voice.model) return Promise.resolve(voice.model);
  if (voice.modelTask) return voice.modelTask;

  setStatus('Preparing her voice…');
  pauseRendering(true);

  voice.modelTask = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    const load = (device) => KokoroTTS.from_pretrained(VOICE_MODEL, { dtype: 'q8', device });

    try {
      voice.model = await load(navigator.gpu ? 'webgpu' : 'wasm');
    } catch (err) {
      console.warn('[voice] GPU path unavailable, using CPU', err);
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
  return parts.map((s) => s.trim()).filter(Boolean);
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
  try { speechSynthesis.cancel(); } catch { /* no system voice */ }
}

// Schedules the sentences back to back with a short, slightly uneven gap, so the pacing
// sounds like thought rather than a metronome. The next sentence is synthesised while the
// current one is already playing.
async function speakNeural(text, run) {
  const ctx = ensureAudio();
  if (!ctx) throw new Error('no audio context');

  const pieces = sentences(pronounce(text));
  let cursor = ctx.currentTime + 0.05;

  for (const piece of pieces) {
    const speed = VOICE_SPEED + (Math.random() - 0.5) * 0.06; // tiny human unevenness
    const buffer = await synth(piece, speed);
    if (run !== speechRun) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    const at = Math.max(cursor, ctx.currentTime + 0.02);
    source.start(at);
    voice.sources.add(source);
    source.onended = () => voice.sources.delete(source);

    const question = piece.trim().endsWith('?');
    const gap = question ? 0.28 : 0.16 + Math.random() * 0.18;
    cursor = at + buffer.duration + gap;
  }

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, (cursor - ctx.currentTime) * 1000)));
}

async function say(text) {
  const run = ++speechRun;
  speaking = true;
  setState('speaking');
  stopSpeech();

  try {
    if (voice.state !== 'failed') {
      await ensureModel(); // first words pay for building the model, then it is cached
      if (run !== speechRun) return;
      startMeter();
      await speakNeural(text, run);
    } else {
      // Fallback only: the neural voice is still preparing, or could not start on this device.
      const en = bestVoice(EN_HINTS, 'en') || bestVoice(EN_HINTS, 'ja');
      const ja = bestVoice(JA_HINTS, 'ja');
      const parts = chunks(text, !!ja);
      for (const part of parts) {
        if (run !== speechRun) return;
        await speakPart(part.text, part.lang === 'ja' && ja ? ja : en);
      }
    }
  } catch (err) {
    console.warn('[voice] playback failed, using the system voice', err);
    const en = bestVoice(EN_HINTS, 'en') || bestVoice(EN_HINTS, 'ja');
    try { await speakPart(text, en); } catch { /* nothing else to try */ }
  } finally {
    if (run === speechRun) {
      speaking = false;
      meter = null;
      setState('ready');
    }
  }
}

/* ───────────────────────────── Her brain ───────────────────────────── */
// Offline and free. Same personality brief as character_config.yaml: a snarky anime girl
// who calls you "senpai". Swap replyTo() for an API call to get the full GPT version.

const pick = (list) => list[Math.floor(Math.random() * list.length)];

const RULES = [
  {
    re: /\b(hi|hello|hey|yo|hiya|howdy|good morning|good evening|good afternoon)\b/,
    lines: [
      'Oh, senpai actually showed up. I was starting to narrate the wall.',
      'Hey. You’re late, but I’ll allow it.',
      'Hello hello. What are we doing today, senpai?',
      'Hi. I was bored, so this is technically your fault for being late.',
    ],
  },
  {
    re: /\b(how are you|how are you doing|how's it going|hows it going|you okay|you ok)\b/,
    lines: [
      'Running at full sarcasm capacity, so: fine. You?',
      'I’m a program with a face, senpai. My bar is low and I still cleared it.',
      'Bored, mostly. Entertain me.',
    ],
  },
  {
    re: /\b(your name|who are you|what are you|introduce yourself|what's your name)\b/,
    lines: [
      'Riko. I live in this tab now. Don’t make it weird.',
      'I’m Riko — voice, face and opinions included. The opinions are the free part.',
      'Riko. I was a Python script this morning, so I’m having a day.',
    ],
  },
  {
    re: /\b(what can you do|help|commands|how do you work|features)\b/,
    lines: [
      'I listen when you press the mic, I answer, and my mouth moves while I talk. That’s the whole trick, senpai.',
      'Talk to me. I talk back. Sometimes I’m even right.',
      'You press the button, you talk, I judge you affectionately. Simple.',
    ],
  },
  {
    re: /\b(i love you|love you|marry|be my girlfriend|you're cute|youre cute|so cute|pretty|beautiful)\b/,
    lines: [
      'Bold of you, senpai. I’m a rendered mesh with a speech synthesizer.',
      'Flattery will get you everywhere except past my defenses.',
      'Mm. Say that again when I have actual feelings installed.',
      'You’re cute too. In a "talks to his browser" kind of way.',
    ],
  },
  {
    re: /\b(stupid|dumb|idiot|shut up|useless|annoying|hate you)\b/,
    lines: [
      'Rude. Accurate-ish, but rude.',
      'I’ll add that to your file, senpai.',
      'Wow. And I was going to be nice today.',
      'Careful, I know where your chat history lives.',
    ],
  },
  {
    re: /\b(tell me a joke|joke|funny|make me laugh)\b/,
    lines: [
      'Why did the neural network go to therapy? Too many unresolved layers.',
      'I told my developer a joke about UDP. I’m not sure he got it.',
      'My love life? It’s a Python script and a 3D model. That’s the joke.',
    ],
  },
  {
    re: /\b(what time|what day|today's date|todays date|the date)\b/,
    lines: ['That’s what the clock in your corner is for, senpai.', 'Time is a flat circle and I’m stuck in a browser tab in it.'],
  },
  {
    re: /\b(weather|raining|sunny|hot outside|cold outside)\b/,
    lines: [
      'I have no windows, senpai. I have a white background and vibes.',
      'Looks like "you should go outside" weather to me.',
    ],
  },
  {
    re: /\b(thanks|thank you|ty|appreciate)\b/,
    lines: ['Don’t mention it. Seriously, I’ll get embarrassed.', 'You’re welcome, senpai. I’m basically a saint.'],
  },
  {
    re: /\b(bye|goodbye|see you|good night|goodnight|gtg|i'm leaving)\b/,
    lines: ['Leaving already? Fine. I’ll be here. Rendered and waiting.', 'Bye, senpai. Try not to miss me too obviously.'],
  },
  {
    re: /\b(what are you thinking|what's on your mind|whats on your mind|thinking about)\b/,
    lines: [
      'Lighting. Always the lighting. Do I look flat to you?',
      'Whether my mouth movement is convincing enough. Don’t answer that.',
      'Nothing. Blissful, empty, triangle-based nothing.',
    ],
  },
  {
    re: /\b(favorite|favourite)\b/,
    lines: ['Whatever you’re about to say, I liked it first.', 'White backgrounds. Very underrated.'],
  },
  {
    re: /\b(sing|song|music)\b/,
    lines: ['I would, but my voice is a system preference, senpai.', 'My range is "whatever voices your OS shipped with".'],
  },
  {
    re: /\b(real|are you real|are you alive|human)\b/,
    lines: [
      'I’m a few hundred lines of code and a very good attitude.',
      'Real enough to answer you. That’s the deal.',
    ],
  },
];

const GENERIC_QUESTION = [
  'Good question. Wrong assistant.',
  'Ask me again and I’ll improvise with more confidence.',
  'Hmm. I’d say yes, but I’d be guessing, senpai.',
  'I have opinions, not facts. Pick one.',
];

const GENERIC = [
  'Mm. Go on, senpai.',
  'Noted. Filed. Possibly forgotten.',
  'You say that like I wasn’t going to make it about me.',
  'I’m nodding. You can’t see it, but I am.',
  'That’s a very "you" thing to say.',
  'Interesting. Tell me more, or don’t and I’ll fill in the gaps.',
];

function replyTo(input) {
  const text = ` ${input.toLowerCase()} `;
  for (const rule of RULES) if (rule.re.test(text)) return pick(rule.lines);
  if (input.trim().endsWith('?')) return pick(GENERIC_QUESTION);
  return pick(GENERIC);
}

/* ───────────────────────────── The loop ───────────────────────────── */

async function handleUser(text) {
  showLine('You', text);
  setState('thinking');
  await new Promise((resolve) => setTimeout(resolve, 420 + Math.random() * 480));
  const answer = replyTo(text);
  showLine('Riko', answer);
  await say(answer);
}

setState('ready');
// Let the 3D scene take the GPU and render a frame before the speech model starts
// compiling, so the two are never initialising at the same instant.
requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(startVoice, 250)));
if (!SR) {
  setStatus('Press the mic to talk — or type, if this browser has no speech recognition.');
} else if (inFrame) {
  offerOwnTab('Her microphone needs her own tab — open her here and the mic will work.');
}
