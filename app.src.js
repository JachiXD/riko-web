// Riko's app loop: ears → brain → voice → body, with states driven by real events.
//
// Nothing in here marks her as "speaking" on its own. The voice engine reports
// playback start, and only then does the UI and the avatar switch to speaking.
//
// Her speech is Japanese and her subtitles are English. The two travel together
// as segments from her server, so nothing can be said without being read.

import { Avatar } from './avatar.js?v=29';
import { Voice } from './voice.js?v=30';
import { Ears } from './ears.js?v=29';
import { Memory } from './memory.js?v=29';
import { LocalBrain, LOCAL_MODELS, buildMessages, reflexReply, extractFacts } from './brain.js?v=29';
import { GroqBrain } from './groq-brain.js?v=30';
import { FishVoice } from './fish-voice.js?v=29';

const $ = (id) => document.getElementById(id);

const host = $('scene');
const micBtn = $('mic');
const kbBtn = $('kb');
const settingsBtn = $('settings');
const newTabLink = $('newtab');
const unmuteBtn = $('unmute');
const typeForm = $('typeform');
const typed = $('typed');
const statusEl = $('status');
const lineEl = $('line');
const whoEl = $('who');
const textEl = $('text');
const bootEl = $('boot');
const bootMsgEl = $('bootmsg');
const bootBarEl = $('bootbar');
const bootFillEl = $('bootfill');
const bootRetryEl = $('bootretry');
const bootSkipEl = $('bootskip');
const panelEl = $('panel');
const memListEl = $('memlist');
const memEmptyEl = $('memempty');

/* ── language ── */

// She speaks Japanese and subtitles herself in English. The preference is kept
// on this device so a refresh never quietly puts her back into English speech.
const LANG_PREFS = 'riko.lang.v1';
const SPEECH_LANG = 'ja-JP';

function saveLangPrefs() {
  try {
    localStorage.setItem(LANG_PREFS, JSON.stringify({ speech: 'ja', subtitles: 'en', at: Date.now() }));
  } catch {
    /* storage blocked */
  }
}

saveLangPrefs();

/* ── introductions ──
   Written as pairs so the subtitle is always the exact sentence being spoken,
   never a second, separate introduction. One is picked per page load, and not
   the same one twice in a row. */
const INTROS = [
  { ja: 'やっと来た。暇で仕方なかったんだよ、ずっと。', en: 'Finally. I was bored out of my mind, the whole time.' },
  { ja: 'こんばんは。今日はどんな一日だった?', en: 'Evening. So how was your day?' },
  { ja: 'あれ、また君だ。嫌じゃないよ、別に。', en: "Oh, it's you again. Not that I mind." },
  { ja: 'ちょうど君のこと考えてた。理由は聞かないでね。', en: "I was just thinking about you. Don't ask why." },
  { ja: '静かだね。まあ、私がしゃべればいいんだけど。', en: "It's quiet in here. Well — I can do the talking." },
  { ja: '準備できてるよ。あとは君の番。', en: "I'm ready. The rest is up to you." },
  { ja: '今日はちょっと機嫌がいいんだ。理由は秘密ね。', en: "I'm in a decent mood today. The reason's a secret." },
  { ja: '戻ってきたね。コーヒーでも持ってきてくれた?', en: 'You came back. Did you bring me coffee?' },
  { ja: '待ってたわけじゃないから。ちょっとだけ、ね。', en: "Not that I was waiting for you. ...Maybe a little." },
  { ja: 'おかえり。君がいないと、この部屋が広すぎるんだ。', en: "Welcome back. Without you this room feels too big." },
];

const INTRO_PREFS = 'riko.intro.v1';

/** One intro per load, never the same index twice running. */
function pickIntro() {
  let last = -1;
  try {
    last = Number(localStorage.getItem(INTRO_PREFS));
  } catch {
    /* storage blocked */
  }
  let index = Math.floor(Math.random() * INTROS.length);
  if (INTROS.length > 1 && index === last) {
    index = (index + 1 + Math.floor(Math.random() * (INTROS.length - 1))) % INTROS.length;
  }
  try {
    localStorage.setItem(INTRO_PREFS, String(index));
  } catch {
    /* storage blocked */
  }
  return INTROS[index];
}

/* ── state ── */

let state = 'idle';
let runToken = 0;
let bridge = null;
let abortController = null;
let lastUserText = '';
let lastUserAt = 0;
let bootDone = false;
let speakingSince = 0;
let avatarInfo = null;
let gpuSupport = null;

const avatar = new Avatar(host);
const localVoice = new Voice({
  onStart: () => {
    // Real audio started. This is the only place speaking becomes true.
    if (state !== 'error') setState('speaking');
    speakingSince = performance.now();
    lastProgressAt = performance.now();
  },
  onClause: (text, duration) => avatar.beginClause(text, duration),
  onIdle: () => {},
  onStatus: (text) => {
    if (!bootDone) bootStatus(text);
  },
  onProgress: (ratio, file) => {
    if (!bootDone) bootProgress(0.45 + clamp(ratio, 0, 1) * 0.55, file);
    else if (ratio < 1) setPanelNote('voice', `Preparing her voice… ${Math.round(ratio * 100)}%`);
  },
  onDegraded: (report) => {
    voiceNote = report.message;
    if (report.kind === 'device-voice') noteStatus('Her neural voice is unavailable — using the device voice.');
    else if (report.kind === 'no-voice') noteStatus('No speech output is available here. Her words are on screen.');
    else if (report.kind === 'audio-blocked') noteStatus('Your browser is holding the audio back — tap the page once and she can speak.');
    updatePanel();
  },
});
// Her real voice, streamed from her own server. It reports the same four
// events as the in-page engine, so the avatar cannot tell the difference.
const fish = new FishVoice({
  onStart: () => {
    if (state !== 'error') setState('speaking');
    speakingSince = performance.now();
    lastProgressAt = performance.now();
  },
  onClause: (text, duration) => avatar.beginClause(text, duration),
  onIdle: () => {},
  onStatus: (text) => noteStatus(text),
});

// One voice face for the rest of the file: Fish when her server is configured,
// the in-page engine otherwise. Nothing downstream needs to know which it got.
let localVoiceReady = false;
const voice = {
  get mode() {
    return fish.ready ? 'fish' : localVoice.mode;
  },
  get locked() {
    return fish.ready ? fish.locked : Boolean(localVoice.locked);
  },
  async prepare() {
    await fish.prepare();
    if (!fish.ready) {
      localVoiceReady = true;
      await localVoice.prepare();
    }
  },
  async reload() {
    await fish.prepare();
    if (!fish.ready) await localVoice.reload();
  },
  unlock: () => (fish.ready ? fish.unlock() : localVoice.unlock()),
  async speak(text, run) {
    if (fish.ready) return fish.speak(text, run);
    // Fish can stand down mid-conversation; her in-page voice has to be there.
    if (!localVoiceReady) {
      localVoiceReady = true;
      await localVoice.prepare().catch(() => {});
    }
    return localVoice.speak(text, run);
  },
  stop: () => {
    fish.stop();
    localVoice.stop();
  },
  getLevel: () => (fish.ready ? fish.getLevel() : localVoice.getLevel()),
  isAudible: () => (fish.ready ? fish.isAudible() : localVoice.isAudible()),
};

const memory = new Memory();
const ears = new Ears({
  // English in, as always: she understands what you say, she just answers in
  // Japanese.
  lang: 'en-US',
  onPartial: (heard) => showLine('You', heard),
  onFinal: (text) => handleUser(text),
  onListening: (listening) => {
    if (listening) {
      setState('listening');
      return;
    }
    // onend fires just before the transcript is delivered; give it a beat.
    setTimeout(() => {
      if (state === 'listening') setState('idle');
    }, 80);
  },
  onError: (err) => handleEarError(err),
});
const local = new LocalBrain({ onProgress: (ratio, text) => updateBrainProgress(ratio, text) });
// Her words come from Groq through her own server when it is reachable; the
// in-page model stays as the fallback so she still answers when it is not.
const cloud = new GroqBrain({ onStatus: (text) => noteStatus(text) });

let voiceNote = '';
let brainNote = '';
let bootSkipped = false;
let bootErrors = [];

/* ── small helpers ── */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}
function noteStatus(text) {
  // Only speak over a resting Riko, never over a live state message.
  if (state === 'idle') setStatus(text);
}

function showLine(who, text) {
  if (!lineEl) return;
  whoEl.textContent = who;
  textEl.textContent = text;
  lineEl.classList.add('show');
}

function setState(next) {
  const previous = state;
  state = next;
  micBtn.className = '';
  avatar.setState(next);

  if (next === 'listening') {
    micBtn.classList.add('listening');
    micBtn.textContent = '● Listening… tap to stop';
    setStatus('Go ahead — I’m listening.');
  } else if (next === 'thinking') {
    micBtn.classList.add('thinking');
    micBtn.textContent = 'Thinking…';
    setStatus('Thinking…');
  } else if (next === 'speaking') {
    micBtn.textContent = '■ Tap to interrupt';
    setStatus('Riko is talking.');
  } else if (next === 'error') {
    micBtn.textContent = '🎙 Tap to talk';
  } else {
    micBtn.textContent = '🎙 Tap to talk';
    setStatus('Press the mic and say hi.');
  }

  if (previous === 'speaking' && next !== 'speaking') speakingSince = 0;
}

function showError(message) {
  setState('error');
  setStatus(message);
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => {
    if (state === 'error') setState('idle');
  }, 3200);
}

/* ── her opening line ── */

let pendingIntro = null;

/**
 * voice.unlock(), with a guard. On a page nobody has touched yet the AudioContext
 * is suspended, and resuming it can leave the promise pending for good instead
 * of rejecting. Waiting on that would cost her the whole hello, so the wait is
 * bounded and a blocked context is reported as "not yet".
 */
async function unlockVoice(timeout = 900) {
  const ok = await Promise.race([
    voice.unlock().catch(() => false),
    delay(timeout).then(() => false),
  ]);
  return ok === true;
}

/** Speaks one of her introductions in Japanese, with its English line beside it. */
async function playIntro(intro) {
  showLine('Riko', intro.en);
  const ok = await unlockVoice();
  if (!ok) {
    // Browsers hold audio until the page is touched. Keep her subtitle up and
    // say the line the moment that touch arrives.
    pendingIntro = intro;
    if (unmuteBtn) unmuteBtn.hidden = false;
    setStatus('Tap anywhere and I’ll say hello out loud.');
    return;
  }
  pendingIntro = null;
  if (unmuteBtn) unmuteBtn.hidden = true;
  const run = ++runToken;
  bridge?.cancel();
  bridge = null;
  if (avatar.ready) avatar.greet();
  try {
    await voice.speak(intro.ja, run);
  } catch (err) {
    console.warn('[intro] voice failed', err);
  }
  if (run === runToken) {
    avatar.endSpeech();
    if (state === 'speaking' || state === 'thinking') setState('idle');
  }
}

function sayIntro() {
  playIntro(pickIntro());
}

/** After the first tap or key, deliver the hello that was held back. */
function resumeIntro() {
  if (!pendingIntro) return;
  const intro = pendingIntro;
  pendingIntro = null;
  playIntro(intro);
}

/* ── boot ── */

function bootStatus(text) {
  if (bootMsgEl) bootMsgEl.textContent = text;
}
function bootProgress(ratio, file) {
  if (!bootBarEl) return;
  bootBarEl.hidden = false;
  bootFillEl.style.width = `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
  if (file) bootStatus(`Preparing her voice… (${String(file).split('/').pop()})`);
}
function bootClearProgress() {
  if (!bootBarEl) return;
  bootBarEl.hidden = true;
  bootFillEl.style.width = '0%';
}

function finishBoot() {
  if (bootDone) return;
  bootDone = true;
  bootEl?.classList.add('gone');
  setState('idle');
  // Her hello is spoken, not printed: the Japanese goes to the voice and the
  // English goes on screen beside it.
  sayIntro();

  if (bootErrors.length) {
    setStatus(bootErrors[0]);
  } else if (bootSkipped) {
    setStatus('Her voice is still loading in the background. You can type to her now.');
  } else if (voice.mode === 'device') {
    setStatus('Her neural voice could not load, so she is using the device voice. Her settings has details.');
  } else if (voice.mode === 'none') {
    setStatus('No speech output is available in this browser. Her words will appear on screen.');
  } else {
    setStatus('Press the mic and say hi.');
  }
  updatePanel();
  maybeWarmBrain();
}

async function bootSequence() {
  bootStatus('Loading her model…');
  bootProgress(0.02);

  const avatarTask = avatar
    .load('./riko.vrm', (p) => bootProgress(0.02 + clamp(p, 0, 1) * 0.43))
    .then((info) => {
      avatarInfo = info;
      bootProgress(0.45);
    })
    .catch((err) => {
      console.error('[avatar]', err);
      bootErrors.push('Her model did not load. Check that riko.vrm is next to index.html.');
      bootStatus('Her model did not load.');
      if (bootBarEl) bootBarEl.hidden = true;
      if (bootMsgEl) {
        bootMsgEl.innerHTML = 'Her model did not load.<small>riko.vrm is missing or blocked — check the console.</small>';
      }
      if (bootSkipEl) bootSkipEl.hidden = false;
    });

  const memoryTask = memory.init().catch((err) => {
    console.warn('[memory]', err);
  });

  // Ask her server what it can do, in parallel with the model load. A failure
  // here must never stall the boot, so it resolves to false.
  const cloudTask = cloud.prepare().catch(() => false);

  const gpuTask = LocalBrain.detect().then((support) => {
    gpuSupport = support;
  });

  await Promise.all([avatarTask, memoryTask, gpuTask, cloudTask]);
  if (!avatar.ready) {
    // Without a body there is nothing to animate; stop here but keep the page usable.
    bootDone = true;
    if (bootSkipEl) bootSkipEl.hidden = true;
    return;
  }

  bootStatus('Preparing her voice…');
  const voiceReady = voice.prepare();
  const winner = await Promise.race([
    voiceReady.then(() => 'ready').catch(() => 'failed'),
    delay(60000).then(() => 'timeout'),
  ]);

  if (winner === 'timeout' && !bootSkipped) {
    bootStatus('Her voice is still downloading — you can start now and it will finish in the background.');
    if (bootSkipEl) bootSkipEl.hidden = false;
  }

  bootProgress(1);
  bootStatus('Ready.');
  finishBoot();
}

bootSkipEl?.addEventListener('click', () => {
  bootSkipped = true;
  finishBoot();
});

bootRetryEl?.addEventListener('click', async () => {
  bootStatus('Trying her voice again…');
  bootClearProgress();
  bootRetryEl.hidden = true;
  try {
    await voice.reload();
    bootStatus('Her voice is ready.');
    bootProgress(1);
    noteStatus('Her voice is ready now.');
  } catch (err) {
    bootStatus('Her voice still will not load. Text still works.');
  }
  updatePanel();
});

/* ── the loop ── */

const clock = { last: performance.now() };
let lastLowLevel = 0;
// Any sign of progress (a token, a clause, real audio) resets this clock, so a
// stall can be told apart from a slow answer.
let lastProgressAt = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0.001, (now - clock.last) / 1000));
  clock.last = now;

  const level = voice.getLevel();
  avatar.update(dt, level);
  avatar.render();

  // State must follow sound, not intent. If the next sentence is still being
  // synthesised, she is not speaking: she is thinking about the next words.
  // The old build showed "speaking" through these silent gaps, which is exactly
  // the "she says she's talking but there's no sound" bug.
  if (state === 'speaking') {
    const live = voice.isAudible();
    if (!live) {
      if (!lastLowLevel) lastLowLevel = now;
      else if (now - lastLowLevel > 900) {
        lastLowLevel = 0;
        setState('thinking');
        setStatus('Getting her next words ready…');
      }
    } else {
      lastLowLevel = 0;
    }
  } else {
    lastLowLevel = 0;
  }

  // Nothing may sit in thinking forever: a hung model, a blocked audio context
  // or a dead network all end here instead of spinning indefinitely.
  if (state === 'thinking' && now - lastProgressAt > 45000) {
    lastProgressAt = now;
    bridge?.cancel();
    bridge = null;
    abortController?.abort();
    avatar.endSpeech();
    setState('idle');
    setStatus('That answer took too long, so I stopped waiting on it. Ask me again?');
  }
}

/* ── speech queue ── */

class SpeechBridge {
  constructor(run, onDrained) {
    this.run = run;
    this.onDrained = onDrained;
    this.queue = [];
    this.running = false;
    this.done = false;
    this.cancelled = false;
  }

  push(text) {
    const sentence = clean(text);
    if (!sentence || this.cancelled) return;
    this.queue.push(sentence);
    this.#pump();
  }

  finish() {
    this.done = true;
    this.#settle();
  }

  cancel() {
    this.cancelled = true;
    this.queue = [];
    this.done = true;
    voice.stop();
  }

  async #pump() {
    if (this.running || this.cancelled) return;
    this.running = true;
    try {
      while (this.queue.length && !this.cancelled) {
        const sentence = this.queue.shift();
        // One failed sentence must not strand the queue or leave the UI waiting.
        try {
          await voice.speak(sentence, this.run);
        } catch (err) {
          console.warn('[voice] sentence failed', err);
        }
      }
    } finally {
      this.running = false;
      this.#settle();
    }
  }

  #settle() {
    if (this.done && !this.queue.length && !this.running && !this.cancelled) {
      this.onDrained?.();
    }
  }
}

/* ── brain ── */

/** Turns an English-only fallback answer into one segment she can actually say. */
async function* fromEnglish(english, signal) {
  const text = clean(english);
  if (!text) return;
  let ja = '';
  try {
    if (cloud.ready) ja = clean(await cloud.translate(text, 'ja'));
  } catch (err) {
    console.warn('[translate]', err);
  }
  if (signal?.aborted) return;
  // With no translation she stays quiet rather than reading English aloud: an
  // untranslated line would break the one rule this page is built around.
  yield { ja, en: text, untranslated: !ja };
}

async function* streamReply(userText, signal) {
  const facts = memory.topFacts();
  const turns = memory.recentTurns(14);

  // Groq first: it is the brain she is supposed to have. It answers in
  // Japanese + English pairs, one segment per sentence.
  if (cloud.ready) {
    const messages = buildMessages({ facts, turns, userText });
    let produced = false;
    try {
      for await (const segment of cloud.reply(messages, { signal })) {
        produced = true;
        yield segment;
      }
      if (!produced) throw new Error('her server returned nothing');
      return;
    } catch (err) {
      if (signal.aborted) return;
      console.warn('[brain] groq failed', err);
      if (produced) throw err;
      noteStatus('Her server did not answer — falling back to the in-page brain.');
    }
  }

  // The local model and the offline reflex engine both think in English, so
  // their answer is translated once before it is spoken.
  let english = '';
  if (local.ready) {
    const messages = buildMessages({ facts, turns, userText });
    try {
      for await (const piece of local.reply(messages, { signal })) english += piece;
    } catch (err) {
      if (signal.aborted) return;
      console.warn('[brain] local model failed', err);
      english = '';
    }
    if (!english.trim()) english = reflexReply(userText, { facts, turns, reason: 'error' });
  } else {
    english = reflexReply(userText, { facts, turns, reason: local.loading ? 'loading' : 'not-loaded' });
  }

  yield* fromEnglish(english, signal);
}

async function handleUser(raw) {
  const text = clean(raw);
  if (!text) {
    noteStatus('I did not catch that. Say it again?');
    return;
  }
  if (text === lastUserText && Date.now() - lastUserAt < 6000) return;
  lastUserText = text;
  lastUserAt = Date.now();
  lastProgressAt = performance.now();

  ears.cancel();
  abortController?.abort();
  bridge?.cancel();
  voice.stop();
  runToken++;

  showLine('You', text);
  setState('thinking');

  await memory.addTurn('user', text);
  for (const fact of extractFacts(text)) await memory.addFact(fact, 'auto');

  const run = runToken;
  const abort = new AbortController();
  abortController = abort;
  avatar.endSpeech();
  const speech = new SpeechBridge(run, () => {
    if (run !== runToken) return;
    avatar.endSpeech();
    if (state === 'speaking' || state === 'thinking') setState('idle');
  });
  bridge = speech;

  let full = '';
  const pairs = [];
  let spoken = 0;

  try {
    for await (const segment of streamReply(text, abort.signal)) {
      if (run !== runToken) return;
      lastProgressAt = performance.now();
      if (segment.en) {
        full = full ? `${full} ${segment.en}` : segment.en;
        showLine('Riko', full);
      }
      if (segment.ja && segment.en) pairs.push(`${segment.ja} ||| ${segment.en}`);
      if (segment.ja) {
        spoken++;
        speech.push(segment.ja);
      }
    }

    if (run !== runToken) return;
    const subtitle = full.trim();
    if (!subtitle) throw new Error('the reply was empty');
    showLine('Riko', subtitle);
    // Mood and gestures are read off the English, because that is the half this
    // file can understand without its own Japanese tokeniser.
    avatar.readTextEmotion(subtitle);
    avatar.reactTo(subtitle);
    await memory.addTurn('riko', pairs.length ? pairs.join('\n') : subtitle);
    if (!spoken) noteStatus('Her voice is out of reach, so that one is on screen only.');
    speech.finish();
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error('[reply]', err);
    speech.cancel();
    showError('Something went wrong on my end. Try that again?');
  }
}

/* ── ears wiring ── */

const inFrame = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

function handleEarError(err) {
  const kind = err?.kind;
  if (kind === 'unsupported') {
    toggleType(true);
    setStatus('This browser has no speech recognition — type to her instead.');
    return;
  }
  if (kind === 'blocked') {
    offerOwnTab('The microphone is blocked here. Give the browser permission, or open her own tab.');
    toggleType(true);
    return;
  }
  if (kind === 'network') {
    setStatus('Speech recognition needs a connection in this browser. Typing works too.');
    toggleType(true);
    return;
  }
  if (kind === 'unclear' || kind === 'partial') {
    setState('idle');
    setStatus(err.heard ? `I may have misheard “${err.heard}”. Say it once more?` : 'I only caught part of that. Say it again?');
    return;
  }
  if (kind === 'nothing' || kind === 'no-speech') {
    setState('idle');
    setStatus('I did not hear anything. Try again?');
    return;
  }
  setState('idle');
  setStatus(`Microphone trouble (${kind}). Typing works too.`);
  toggleType(true);
}

function offerOwnTab(message) {
  if (newTabLink) newTabLink.hidden = false;
  if (message) setStatus(message);
}

function toggleType(force) {
  if (!typeForm) return;
  const show = force ?? typeForm.hidden;
  typeForm.hidden = !show;
  if (show) typed.focus();
}

async function startListening() {
  await ensureSound();
  if (!Ears.supported) {
    toggleType(true);
    setStatus('This browser has no speech recognition — type to her instead.');
    return;
  }
  if (inFrame) offerOwnTab('Her microphone needs her own tab — open her here and the mic will work.');
  voice.stop();
  bridge?.cancel();
  abortController?.abort();
  const started = ears.start();
  if (!started) {
    toggleType(true);
  }
}

function stopEverything() {
  runToken++;
  abortController?.abort();
  bridge?.cancel();
  bridge = null;
  voice.stop();
  ears.cancel();
  avatar.endSpeech();
  setState('idle');
}

async function ensureSound() {
  const ok = await unlockVoice();
  if (!ok && unmuteBtn) unmuteBtn.hidden = false;
  return ok;
}

micBtn.addEventListener('click', async () => {
  await ensureSound();
  if (state === 'speaking' || state === 'thinking') {
    stopEverything();
    setStatus('Stopped. What were you saying?');
    return;
  }
  if (state === 'listening') {
    ears.stop();
    return;
  }
  startListening();
});

unmuteBtn?.addEventListener('click', async () => {
  const ok = await unlockVoice(2500);
  if (ok) {
    unmuteBtn.hidden = true;
    noteStatus('Sound is on.');
    resumeIntro();
  }
});

kbBtn.addEventListener('click', () => toggleType());

typeForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = typed.value.trim();
  if (!text) return;
  typed.value = '';
  toggleType(false);
  await ensureSound();
  handleUser(text);
});

addEventListener('pointerdown', async () => {
  if (await unlockVoice()) resumeIntro();
}, { once: true });
addEventListener('keydown', async () => {
  if (await unlockVoice()) resumeIntro();
  if (event.key === 'Escape' && (state === 'speaking' || state === 'thinking')) {
    stopEverything();
  }
}, { once: false });

/* ── panel ── */

const memList = memListEl;

function esc(text) {
  return String(text ?? '');
}

function renderFacts() {
  if (!memList) return;
  memList.innerHTML = '';
  if (!memory.facts.length) {
    if (memEmptyEl) memEmptyEl.hidden = false;
    return;
  }
  if (memEmptyEl) memEmptyEl.hidden = true;

  for (const fact of memory.facts) {
    const item = document.createElement('li');

    const label = document.createElement('span');
    label.textContent = esc(fact.text);

    const edit = document.createElement('button');
    edit.className = 'icon';
    edit.type = 'button';
    edit.title = 'Edit';
    edit.textContent = '✎';
    edit.addEventListener('click', () => {
      const field = document.createElement('input');
      field.value = fact.text;
      item.replaceChildren(field);
      field.focus();
      field.select();
      const commit = async () => {
        await memory.updateFact(fact.id, field.value);
        renderFacts();
      };
      field.addEventListener('blur', commit);
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') renderFacts();
      });
    });

    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.type = 'button';
    remove.title = 'Forget this';
    remove.textContent = '✕';
    remove.addEventListener('click', async () => {
      await memory.deleteFact(fact.id);
      renderFacts();
    });

    item.append(label, edit, remove);
    memList.append(item);
  }
}

function setPanelNote(which, text) {
  const el = $(which === 'voice' ? 'voicestate' : 'brainstate');
  if (el) el.textContent = text;
}

function updateBrainProgress(ratio, text) {
  const bar = $('brainbar');
  const fill = $('brainfill');
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
  }
  if (text) setPanelNote('brain', text);
  // Progress stays in the panel: it must never overwrite a live status message
  // such as a microphone error.
}

function updatePanel() {
  const voiceText = voice.mode === 'fish'
    ? 'Voice: her own Fish Audio model, streamed from her server, speaking Japanese. No key in this page.'
    : voice.mode === 'neural'
    ? 'Neural voice: Kokoro-82M, running locally in a worker. No API, no key.'
    : voice.mode === 'device'
      ? 'Neural voice unavailable — using this device’s built-in voice. It sounds more robotic.'
      : 'No voice output available in this browser. Her replies stay on screen.';
  setPanelNote('voice', voiceNote || voiceText);

  let brainText;
  if (local.ready) brainText = `Local model loaded: ${local.modelId}. Everything runs on this device.`;
  else if (local.loading) brainText = 'Downloading her local model…';
  else if (local.error) brainText = `Local model failed: ${String(local.error.message || local.error)}`;
  else if (gpuSupport && !gpuSupport.webgpu) brainText = `Local model unavailable: ${gpuSupport.reason} Her offline replies still work.`;
  else brainText = 'Local model not loaded yet. It downloads once, then works offline.';
  setPanelNote('brain', brainNote || brainText);

  const cap = $('capstate');
  if (cap) {
    if (avatarInfo) {
      cap.textContent = `Rig: ${avatarInfo.bones} body bones · ${avatarInfo.fingers} finger joints · mouth shapes: ${avatarInfo.visemes.join(' ') || 'none'} · eye look-at: ${avatarInfo.lookAt ? 'yes' : 'no'}`;
    } else {
      cap.textContent = '';
    }
  }

  const select = $('modelselect');
  if (select && !select.options.length) {
    for (const model of LOCAL_MODELS) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.label} — ${model.size} (${model.note})`;
      select.append(option);
    }
    const prefs = readBrainPrefs();
    if (prefs.model) select.value = prefs.model;
  }
}

function openPanel() {
  updatePanel();
  renderFacts();
  panelEl?.classList.add('open');
  panelEl?.setAttribute('aria-hidden', 'false');
}
function closePanel() {
  panelEl?.classList.remove('open');
  panelEl?.setAttribute('aria-hidden', 'true');
}

settingsBtn?.addEventListener('click', openPanel);
$('panelclose')?.addEventListener('click', closePanel);
panelEl?.addEventListener('click', (event) => {
  if (event.target === panelEl) closePanel();
});

$('memadd')?.addEventListener('click', async () => {
  const text = prompt('Something she should remember about you?');
  if (text && (await memory.addFact(text, 'manual'))) {
    renderFacts();
    setStatus('Saved to her memory.');
  }
});

$('memclear')?.addEventListener('click', async () => {
  if (memory.facts.length && confirm('Forget everything she remembers about you?')) {
    await memory.clearFacts();
    renderFacts();
  }
});

$('loadmodel')?.addEventListener('click', async () => {
  const modelId = $('modelselect')?.value || LOCAL_MODELS[0].id;
  writeBrainPrefs({ model: modelId, auto: true });
  try {
    await loadLocalBrain(modelId);
    setStatus('Her local brain is ready. Ask her anything.');
  } catch (err) {
    showError(`Her local brain could not start: ${String(err.message || err)}`);
  }
  updatePanel();
});

$('voice-retry')?.addEventListener('click', async () => {
  setPanelNote('voice', 'Rebuilding her voice…');
  try {
    await voice.reload();
    voiceNote = '';
    setPanelNote('voice', 'Her neural voice is ready.');
  } catch (err) {
    setPanelNote('voice', `Could not rebuild her voice: ${String(err.message || err)}`);
  }
});

$('voice-demo')?.addEventListener('click', async () => {
  let ok = await unlockVoice(2500);
  if (!ok) {
    // A second attempt inside the same gesture catches contexts that report
    // their old state for a tick after the first resume.
    await delay(150);
    ok = await unlockVoice(2500);
  }
  if (!ok) {
    if (inFrame) {
      offerOwnTab('Her page is inside another page, which mutes it. Open her in her own tab and try again.');
      setPanelNote('voice', 'This page is framed by another page, and browsers mute audio in frames. Open her own tab, then try again.');
    } else {
      setPanelNote('voice', 'Tap anywhere on the page once, then press “Hear a sample” again.');
    }
    return;
  }
  const run = ++runToken;
  bridge?.cancel();
  voice.stop();
  avatar.endSpeech();
  // The sample is Japanese too, with its translation on screen: it is the same
  // voice she will use for every reply.
  const sample = INTROS[0];
  showLine('Riko', sample.en);
  await voice.speak(sample.ja, run);
  if (run === runToken) {
    avatar.endSpeech();
    setState('idle');
  }
});

/* ── brain prefs ── */

const BRAIN_PREFS = 'riko.brain.v1';
function readBrainPrefs() {
  try {
    return JSON.parse(localStorage.getItem(BRAIN_PREFS) || '{}') || {};
  } catch {
    return {};
  }
}
function writeBrainPrefs(patch) {
  try {
    localStorage.setItem(BRAIN_PREFS, JSON.stringify({ ...readBrainPrefs(), ...patch }));
  } catch {
    /* storage blocked */
  }
}

async function loadLocalBrain(modelId) {
  brainNote = 'Downloading her local model…';
  updatePanel();
  noteStatus('Downloading her local brain in the background — you can talk to her meanwhile.');
  const bar = $('brainbar');
  if (bar) bar.hidden = false;
  await local.load(modelId, {
    onStatus: (text) => setPanelNote('brain', text),
  });
  updateBrainProgress(1, `Local model ready: ${modelId}`);
  brainNote = '';
  noteStatus('Her local brain is ready.');
  updatePanel();
}

function maybeWarmBrain() {
  const prefs = readBrainPrefs();
  // No point downloading a multi-gigabyte model she will not use.
  if (cloud.ready) {
    brainNote = 'Her head runs on Groq through her own server. Nothing to download.';
    updatePanel();
    return;
  }
  if (gpuSupport && !gpuSupport.webgpu) {
    brainNote = 'No WebGPU in this browser, so her offline replies are used.';
    updatePanel();
    return;
  }
  if (prefs.auto === false) {
    updatePanel();
    return;
  }
  // Respect a metered or very small device; those users can load it from the panel.
  const connection = navigator.connection || {};
  const lowMemory = (navigator.deviceMemory || 8) < 4;
  if (connection.saveData || lowMemory) {
    brainNote = 'Automatic download skipped (data saver or low memory). Load her brain from her settings when you want.';
    updatePanel();
    return;
  }
  const modelId = prefs.model || LOCAL_MODELS[0].id;
  loadLocalBrain(modelId).catch((err) => {
    console.warn('[brain] local model unavailable', err);
    brainNote = `Local model unavailable: ${String(err.message || err)}`;
    const bar = $('brainbar');
    if (bar) bar.hidden = true;
    noteStatus('Her local brain did not download — using her small offline brain. You can retry in her settings.');
    updatePanel();
  });
}

/* ── go ── */

updatePanel();
requestAnimationFrame(frame);
bootSequence().catch((err) => {
  console.error('[boot]', err);
  bootStatus('Riko could not start.');
  if (bootSkipEl) bootSkipEl.hidden = false;
});

if (!Ears.supported) {
  setStatus('This browser has no speech recognition — type to her instead.');
} else if (inFrame) {
  offerOwnTab('Her microphone needs her own tab — open her here and the mic will work.');
}

// Expose a tiny read-only view for debugging in the console.
window.riko = {
  get state() {
    return state;
  },
  get voiceMode() {
    return voice.mode;
  },
  get speechLang() {
    return SPEECH_LANG;
  },
  get subtitle() {
    return textEl ? textEl.textContent : '';
  },
  get intro() {
    return pendingIntro ? pendingIntro.en : null;
  },
  get brainReady() {
    return local.ready;
  },
  get cloudReady() {
    return cloud.ready;
  },
  get avatarInfo() {
    return avatarInfo;
  },
  get mouth() {
    return avatar.getMouthShape();
  },
  get mouthDebug() {
    return avatar.getMouthDebug();
  },
  get emotion() {
    return { ...avatar.emotion };
  },
  get facts() {
    return memory.facts.map((f) => f.text);
  },
  get turns() {
    return memory.turns.length;
  },
  get level() {
    return voice.getLevel();
  },
  get gestureCount() {
    return avatar.gestures.length;
  },
  get speechPlan() {
    return avatar.plan.length;
  },
  get avatar() {
    return avatar;
  },
  get motion() {
    return avatar.getMotion();
  },
};
