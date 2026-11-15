// Riko's app loop: ears → brain → voice → body, with states driven by real events.
//
// Nothing in here marks her as "speaking" on its own. The voice engine reports
// playback start, and only then does the UI and the avatar switch to speaking.

import { Avatar } from './avatar.js?v=27';
import { Voice } from './voice.js?v=27';
import { Ears } from './ears.js?v=27';
import { Memory } from './memory.js?v=27';
import { LocalBrain, LOCAL_MODELS, buildMessages, reflexReply, extractFacts } from './brain.js?v=27';

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

const GREETING = 'Oh — you actually showed up. I was starting to narrate the wall.';

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
const voice = new Voice({
  onStart: () => {
    // Real audio started. This is the only place speaking becomes true.
    if (state !== 'error') setState('speaking');
    speakingSince = performance.now();
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
    updatePanel();
  },
});
const memory = new Memory();
const ears = new Ears({
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
  showLine('Riko', GREETING);

  if (bootErrors.length) {
    setStatus(bootErrors[0]);
  } else if (bootSkipped) {
    setStatus('Her voice is still loading in the background. You can type to her now.');
  } else if (voice.mode === 'device') {
    setStatus('Her neural voice could not load, so she is using the device voice. ⚙ has details.');
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

  const gpuTask = LocalBrain.detect().then((support) => {
    gpuSupport = support;
  });

  await Promise.all([avatarTask, memoryTask, gpuTask]);
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
        await voice.speak(sentence, this.run);
      }
    } finally {
      this.running = false;
    }
    this.#settle();
  }

  #settle() {
    if (this.done && !this.queue.length && !this.running && !this.cancelled) {
      this.onDrained?.();
    }
  }
}

function takeFirstSentence(buffer) {
  for (let i = 8; i < buffer.length; i++) {
    const ch = buffer[i];
    if (!/[.!?…]/.test(ch)) continue;
    const next = buffer[i + 1];
    if (next === undefined || /\s/.test(next)) {
      return [buffer.slice(0, i + 1).trim(), buffer.slice(i + 1)];
    }
  }
  return [null, buffer];
}

/* ── brain ── */

async function* streamReply(userText, signal) {
  const facts = memory.topFacts();
  const turns = memory.recentTurns(14);

  if (local.ready) {
    const messages = buildMessages({ facts, turns, userText });
    let produced = false;
    try {
      for await (const piece of local.reply(messages, { signal })) {
        produced = true;
        yield piece;
      }
      if (!produced) throw new Error('the local model returned nothing');
      return;
    } catch (err) {
      if (signal.aborted) return;
      console.warn('[brain] local model failed', err);
      if (produced) throw err;
      setStatus('Her local brain stumbled — answering with her small offline brain.');
      yield reflexReply(userText, { facts, turns, reason: 'error' });
      return;
    }
  }

  yield reflexReply(userText, { facts, turns, reason: local.loading ? 'loading' : 'not-loaded' });
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
  let buffer = '';

  try {
    for await (const piece of streamReply(text, abort.signal)) {
      if (run !== runToken) return;
      full += piece;
      buffer += piece;
      showLine('Riko', full.trim());

      let sentence;
      while ((sentence = takeFirstSentence(buffer))[0]) {
        buffer = sentence[1];
        speech.push(sentence[0]);
      }
    }

    if (run !== runToken) return;
    const reply = full.trim();
    if (!reply) throw new Error('the reply was empty');
    if (buffer.trim()) speech.push(buffer.trim());
    showLine('Riko', reply);
    avatar.readTextEmotion(reply);
    await memory.addTurn('riko', reply);
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
  const ok = await voice.unlock();
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
  const ok = await voice.unlock();
  if (ok) {
    unmuteBtn.hidden = true;
    noteStatus('Sound is on. Press the mic and say hi.');
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

addEventListener('pointerdown', () => {
  voice.unlock().catch(() => {});
}, { once: true });
addEventListener('keydown', (event) => {
  voice.unlock().catch(() => {});
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
  const voiceText = voice.mode === 'neural'
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
  const ok = await voice.unlock();
  if (!ok) {
    setPanelNote('voice', 'The browser blocked audio until you tap the page.');
    return;
  }
  const run = ++runToken;
  bridge?.cancel();
  voice.stop();
  avatar.endSpeech();
  await voice.speak('Hi. I’m Riko. This is what I sound like when it’s only me talking.', run);
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
    brainNote = 'Automatic download skipped (data saver or low memory). Load her brain from ⚙ when you want.';
    updatePanel();
    return;
  }
  const modelId = prefs.model || LOCAL_MODELS[0].id;
  loadLocalBrain(modelId).catch((err) => {
    console.warn('[brain] local model unavailable', err);
    brainNote = `Local model unavailable: ${String(err.message || err)}`;
    const bar = $('brainbar');
    if (bar) bar.hidden = true;
    noteStatus('Her local brain did not download — using her small offline brain. You can retry in ⚙.');
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
  get brainReady() {
    return local.ready;
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
};
