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
let controls = null;
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

  // Frame the camera by her head height, so short and tall models look the same.
  const headY = vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new THREE.Vector3()).y;
  camera.position.set(0, headY * 0.94, headY * 1.37);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, headY * 0.9, 0);
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.minDistance = 0.5;
  controls.maxDistance = 5;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  document.getElementById('boot').classList.add('gone');
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
let mouth = 0;
let mouthTarget = 0;
let wobble = 0;

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  wobble += dt * 12.5;

  const env = speaking
    ? Math.min(1, 0.26 + 0.6 * Math.abs(Math.sin(wobble)) + 0.12 * Math.sin(wobble * 2.61))
    : 0;
  mouthTarget += (env - mouthTarget) * 0.42;
  mouth += (mouthTarget - mouth) * 0.34;

  if (vrm?.expressionManager) {
    vrm.expressionManager.setValue('aa', meter ? meter() : mouth);
    vrm.update(dt);
  }
  controls?.update();
  renderer.render(scene, camera);
});

/* ───────────────────────────── The page ───────────────────────────── */

const $ = (id) => document.getElementById(id);
const micBtn = $('mic');
const kbBtn = $('kb');
const typeForm = $('typeform');
const typed = $('typed');
const statusEl = $('status');
const lineEl = $('line');
const whoEl = $('who');
const textEl = $('text');

const setStatus = (s) => { statusEl.textContent = s; };

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
  speechSynthesis.cancel();
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
      setStatus('The microphone is blocked. Allow it in your browser, or type instead.');
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
  if (state === 'speaking') { speechSynthesis.cancel(); speaking = false; setState('ready'); return; }
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
  const text = typed.value.trim();
  if (!text) return;
  typed.value = '';
  toggleType(false);
  handleUser(text);
});

/* ───────────────────────────── Her voice ───────────────────────────── */

const VOICE_HINTS = [
  'google uk english female', 'google us english', 'samantha', 'aria', 'jenny',
  'zira', 'ava', 'allison', 'karen', 'moira', 'tessa', 'female',
];

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
  if (!voices.length) return null;
  for (const hint of VOICE_HINTS) {
    const hit = voices.find((v) => v.name.toLowerCase().includes(hint));
    if (hit) return hit;
  }
  return voices.find((v) => v.localService) || voices[0];
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => pickVoice();

function say(text) {
  if (!('speechSynthesis' in window)) { setState('ready'); return Promise.resolve(); }

  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = 1.04;
    utterance.pitch = 1.2;
    utterance.volume = 1;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      speaking = false;
      setState('ready');
      resolve();
    };

    utterance.onboundary = () => { mouthTarget = Math.min(1, mouthTarget + 0.3); };
    utterance.onend = finish;
    utterance.onerror = finish;

    speaking = true;
    setState('speaking');
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);

    // Some browsers never fire onend after a cancel; never get stuck speaking.
    const guard = setTimeout(finish, 4000 + text.length * 130);
  });
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
if (!SR) {
  setStatus('Press the mic to talk — or type, if this browser has no speech recognition.');
}
