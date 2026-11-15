// Her voice.
//
// Kokoro-82M (Apache-2.0) runs locally in a worker: no API, no key, no cost.
// Nothing is ever reported as "speaking" until a real AudioBufferSourceNode has
// started on a running AudioContext. Every generated buffer is measured first;
// silent or corrupted synthesis is treated as a failure, not as speech.

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE_ID = 'af_heart'; // warmest of Kokoro's English feminine voices
const SPEED = 0.95;

const VARIANTS = [
  { dtype: 'q8', device: 'wasm', label: 'neural' },
  { dtype: 'q4', device: 'wasm', label: 'neural light' },
];
if (typeof navigator !== 'undefined' && navigator.gpu) {
  VARIANTS.push({ dtype: 'fp32', device: 'webgpu', label: 'neural gpu' });
}

// SpeechSynthesis voices are only a fallback. They are robotic, so they are
// ranked for the least unpleasant option rather than pretending to be natural.
const FEMALE_HINTS = ['aria', 'jenny', 'samantha', 'ava', 'serena', 'emma', 'michelle', 'zira', 'susan', 'female', 'natural', 'neural', 'enhanced', 'premium', 'google us english', 'siri'];
const MALE_HINTS = ['david', 'mark', 'george', 'daniel', 'alex', 'fred', 'male', 'guy', 'ryan'];

export class VoiceError extends Error {
  constructor(message, kind = 'voice') {
    super(message);
    this.kind = kind;
  }
}

export class Voice {
  constructor({ onStart, onClause, onIdle, onStatus, onProgress, onDegraded } = {}) {
    this.onStart = onStart || (() => {});
    this.onClause = onClause || (() => {});
    this.onIdle = onIdle || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onDegraded = onDegraded || (() => {});

    this.ctx = null;
    this.analyser = null;
    this.levelBuf = null;
    this.master = null;
    this.mode = 'neural'; // 'neural' | 'device' | 'none'
    this.ready = false;
    this.token = 0;
    this.sources = new Set();
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.variantIndex = 0;
    this.prepared = null;
    this.deviceVoice = null;
    this.deviceActive = false;
    this.devicePulseAt = 0;
    this.deviceLevel = 0;
    this.lastError = null;
    this.speaking = false;
    this.playedAny = false;
  }

  /* ── audio context: created once, resumed inside a user gesture ── */

  ensureContext() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    // Kokoro leaves a lot of headroom; a little lift makes her comfortably
    // audible on phone speakers without clipping the loudest syllables.
    this.master.gain.value = 1.25;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.55;
    this.levelBuf = new Uint8Array(this.analyser.fftSize);
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    return this.ctx;
  }

  // Must be called from a real click/tap/key handler.
  async unlock() {
    const ctx = this.ensureContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* the browser refused; playback will report it */
      }
    }
    return ctx.state === 'running';
  }

  get locked() {
    return !this.ctx || this.ctx.state !== 'running';
  }

  /* ── preparation ── */

  async prepare() {
    if (this.prepared) return this.prepared;
    this.ensureContext();
    this.prepared = (async () => {
      try {
        await this.#prepareNeural();
        this.mode = 'neural';
        this.ready = true;
        return { mode: 'neural' };
      } catch (err) {
        console.warn('[voice] neural voice unavailable', err);
        this.lastError = err;
        const ok = await this.#useDeviceVoice();
        this.mode = ok ? 'device' : 'none';
        this.ready = ok;
        this.onDegraded({
          kind: this.mode === 'device' ? 'device-voice' : 'no-voice',
          message: this.mode === 'device'
            ? 'Her neural voice could not load, so the device voice is being used.'
            : 'No speech output is available in this browser.',
        });
        return { mode: this.mode, error: err };
      }
    })();
    return this.prepared;
  }

  // Full rebuild of the engine, used by the "Rebuild voice" button.
  async reload() {
    this.stop();
    this.prepared = null;
    this.#killWorker();
    this.pending.clear();
    this.variantIndex = 0;
    this.mode = 'neural';
    this.ready = false;
    this.lastError = null;
    return this.prepare();
  }

  async #prepareNeural() {
    const variant = VARIANTS[this.variantIndex];
    if (!variant) throw new VoiceError('no voice variants left', 'unavailable');
    await this.#spawnWorker();
    this.onStatus(`Loading her voice…`);
    await this.#workerCall('load', { dtype: variant.dtype, device: variant.device, model: MODEL }, 180000, true);
    this.onProgress(1);
  }

  #spawnWorker() {
    if (this.worker) return;
    const worker = new Worker(new URL('./tts.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => this.#onWorkerMessage(event.data);
    worker.onerror = (event) => {
      const err = new VoiceError(event.message || 'the voice worker crashed', 'worker');
      for (const [, entry] of this.pending) entry.reject(err);
      this.pending.clear();
      this.#killWorker();
    };
    this.worker = worker;
  }

  #killWorker() {
    if (!this.worker) return;
    try {
      this.worker.terminate();
    } catch {
      /* already gone */
    }
    this.worker = null;
  }

  #onWorkerMessage(msg) {
    if (!msg) return;
    if (msg.type === 'progress') {
      this.onProgress(Math.max(0, Math.min(1, msg.progress || 0)), msg.file);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') entry.reject(new VoiceError(msg.error || 'synthesis failed', 'synthesis'));
    else entry.resolve(msg);
  }

  #workerCall(type, payload, timeoutMs, loading = false) {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new VoiceError('the voice worker is not running', 'worker'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VoiceError(`voice ${type} timed out`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          if (loading) this.#killWorker();
          reject(e);
        },
      });
      this.worker.postMessage({ type, id, ...payload });
    });
  }

  async #useDeviceVoice() {
    if (!('speechSynthesis' in window)) return false;
    this.deviceVoice = await pickDeviceVoice();
    return true;
  }

  /* ── device (fallback) voice ── */

  #speakDevicePart(text) {
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      if (this.deviceVoice) utterance.voice = this.deviceVoice;
      utterance.lang = this.deviceVoice?.lang || 'en-US';
      utterance.rate = 0.96;
      utterance.pitch = 1.0;
      utterance.volume = 1;

      let started = false;
      const watchdog = setTimeout(() => {
        if (started) return;
        try {
          speechSynthesis.cancel();
        } catch {
          /* ignore */
        }
        reject(new VoiceError('the device voice did not start', 'blocked'));
      }, 1800);

      utterance.onstart = () => {
        started = true;
        clearTimeout(watchdog);
        this.deviceActive = true;
        this.devicePulseAt = performance.now();
        resolve();
      };
      utterance.onboundary = () => {
        this.devicePulseAt = performance.now();
      };
      utterance.onend = () => {
        clearTimeout(watchdog);
        this.devicePulseAt = 0;
        this.deviceLevel = 0;
        resolve();
      };
      utterance.onerror = (event) => {
        clearTimeout(watchdog);
        if (event.error === 'interrupted' || event.error === 'canceled') resolve();
        else reject(new VoiceError(`device voice: ${event.error}`, 'device'));
      };

      try {
        speechSynthesis.speak(utterance);
      } catch (err) {
        clearTimeout(watchdog);
        reject(new VoiceError(String(err), 'device'));
      }
    });
  }

  async #speakDevice(parts, token) {
    this.mode = 'device';
    for (const part of parts) {
      if (token !== this.token) return;
      const duration = estimateDuration(part);
      await this.#speakDevicePart(part); // resolves when audio actually starts
      if (token !== this.token) return;
      this.onClause(part, duration);
      if (!this.speaking) {
        this.speaking = true;
        this.onStart();
      }
      await this.#waitDeviceEnd(token);
    }
    this.deviceActive = false;
    this.speaking = false;
  }

  #waitDeviceEnd(token) {
    // The utterance promise resolves on start; wait for the engine to finish.
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        resolve();
      };
      const poll = setInterval(() => {
        if (token !== this.token) return finish();
        if (!speechSynthesis.speaking && !speechSynthesis.pending) finish();
      }, 120);
      setTimeout(finish, 60000);
    });
  }

  /* ── neural path ── */

  async #synthesize(text) {
    const variant = VARIANTS[this.variantIndex];
    if (!variant) throw new VoiceError('no voice variants left', 'unavailable');
    const msg = await this.#workerCall('speak', { text, voice: VOICE_ID, speed: SPEED }, 90000);
    const stats = msg.stats;
    const samples = msg.samples;
    if (!stats || !samples || !samples.length) throw new VoiceError('the voice returned no audio', 'silent');
    if (stats.bad > samples.length * 0.001) throw new VoiceError('the voice returned broken samples', 'corrupt');
    if (stats.duration < 0.12) throw new VoiceError('the voice returned an empty clip', 'silent');
    if (stats.peak < 0.02 || stats.rms < 0.002) throw new VoiceError('the voice returned silence', 'silent');
    return { samples, rate: stats.rate, duration: stats.duration };
  }

  #toBuffer({ samples, rate }) {
    const ctx = this.ensureContext();
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  #play(buffer, token, onStarted) {
    return new Promise((resolve, reject) => {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') {
        reject(new VoiceError('audio is blocked until you interact with the page', 'blocked'));
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.master);

      let started = false;
      source.onended = () => {
        this.sources.delete(source);
        if (started) resolve();
      };
      this.sources.add(source);

      try {
        source.start(ctx.currentTime + 0.02);
        started = true;
        // This is the moment she actually starts making sound.
        if (onStarted) onStarted();
      } catch (err) {
        this.sources.delete(source);
        reject(new VoiceError(String(err), 'playback'));
        return;
      }

      // If the context gets suspended mid-sentence, stop rather than mime it.
      if (ctx.state !== 'running') {
        try {
          source.stop();
        } catch {
          /* ignore */
        }
        this.sources.delete(source);
        reject(new VoiceError('audio playback was suspended', 'blocked'));
      }
    });
  }

  /* ── public: speak / stop ── */

  async speak(text, token = ++this.token) {
    this.token = token;
    this.playedAny = false;
    const parts = splitSpeech(text);
    if (!parts.length) return;

    if (this.mode === 'none') {
      this.onDegraded({ kind: 'no-voice', message: 'No speech output is available in this browser.' });
      return;
    }

    if (this.mode === 'device') {
      await this.#speakDevice(parts, token);
      if (token === this.token) this.onIdle();
      return;
    }

    try {
      await this.#speakNeural(parts, token);
      if (token === this.token) this.onIdle();
    } catch (err) {
      if (token !== this.token) return;
      console.warn('[voice] neural playback failed', err);
      this.lastError = err;
      // Never repeat a sentence she already spoke: degrade quietly instead.
      if (this.playedAny && this.speaking) {
        this.speaking = false;
        this.onDegraded({ kind: 'voice-interrupted', message: 'Her voice dropped out mid-sentence.' });
        this.onIdle();
        return;
      }
      const rotated = await this.#rotateVariant(err);
      if (rotated) {
        try {
          await this.#speakNeural(parts, token);
          if (token === this.token) this.onIdle();
          return;
        } catch (err2) {
          this.lastError = err2;
        }
      }
      if (token !== this.token) return;
      const ok = await this.#useDeviceVoice();
      this.mode = ok ? 'device' : 'none';
      this.onDegraded({
        kind: ok ? 'device-voice' : 'no-voice',
        message: ok
          ? 'Her neural voice stumbled, so the device voice took over.'
          : 'Her voice could not start. Her words are still on screen.',
      });
      if (ok) {
        await this.#speakDevice(parts, token);
        if (token === this.token) this.onIdle();
      } else {
        this.onIdle();
      }
    }
  }

  async #speakNeural(parts, token) {
    let next = this.#synthesize(parts[0]);
    let heardSomething = false;

    for (let i = 0; i < parts.length; i++) {
      if (token !== this.token) return;
      const clip = await next;
      if (token !== this.token) return;

      // Warm the next sentence while this one plays (the worker queues it).
      if (i + 1 < parts.length) {
        next = this.#synthesize(parts[i + 1]);
        next.catch(() => {}); // surfaced when awaited
      }

      const buffer = this.#toBuffer(clip);
      this.onClause(parts[i], clip.duration);
      await this.#play(buffer, token, () => {
        if (this.speaking) return;
        this.speaking = true;
        this.playedAny = true;
        this.onStart(); // only now is she really speaking
      });
      if (token !== this.token) return;
      heardSomething = true;
    }
    this.speaking = false;
    if (!heardSomething) throw new VoiceError('nothing was played', 'silent');
  }

  async #rotateVariant(err) {
    // A silent/corrupt/q8-broken engine gets replaced rather than repeated.
    const retriable = ['silent', 'corrupt', 'synthesis', 'worker', 'unavailable', 'timeout'].includes(err?.kind);
    if (!retriable) return false;
    if (this.variantIndex + 1 >= VARIANTS.length) return false;
    this.variantIndex += 1;
    this.#killWorker();
    this.onStatus('Switching voice engine…');
    try {
      await this.#prepareNeural();
      return true;
    } catch (err2) {
      console.warn('[voice] voice variant failed', err2);
      return false;
    }
  }

  stop() {
    this.token++;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources.clear();
    if ('speechSynthesis' in window) {
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
    this.deviceActive = false;
    this.deviceLevel = 0;
    this.speaking = false;
  }

  // True only while sound is actually leaving the speakers.
  isAudible() {
    if (this.mode === 'device') return this.deviceActive && this.speaking;
    return this.sources.size > 0;
  }

  getLevel() {
    if (this.mode === 'device') {
      if (!this.deviceActive) return 0;
      const since = performance.now() - this.devicePulseAt;
      this.deviceLevel = since < 260 ? 0.35 + 0.55 * Math.abs(Math.sin(performance.now() / 90)) : 0;
      return this.deviceLevel;
    }
    if (!this.analyser || !this.sources.size) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const x = (this.levelBuf[i] - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / this.levelBuf.length);
    return Math.min(1, rms * 6);
  }
}

/* ── helpers ── */

// Kokoro generates a whole chunk at once, so very short chunks waste synthesis
// time and leave audible holes between sentences. The first sentence is kept
// small for a quick start; everything after it is merged into comfortable
// chunks, which also gives far fewer seams in her delivery.
export function splitSpeech(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];

  const sentences = s.match(/[^.!?…]+[.!?…]+["')\]]*|.+$/g) || [s];
  const chunks = [];
  let buf = '';

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (!chunks.length) {
      buf = sentence;
      if (buf.length >= 90) {
        chunks.push(buf);
        buf = '';
      }
      continue;
    }
    if (!buf) {
      buf = sentence;
      continue;
    }
    if (buf.length + sentence.length + 1 <= 220) buf += ` ${sentence}`;
    else {
      chunks.push(buf);
      buf = sentence;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.length ? chunks : [s];
}

function estimateDuration(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.6, words / 2.6);
}

async function pickDeviceVoice() {
  if (!('speechSynthesis' in window)) return null;
  let voices = speechSynthesis.getVoices();
  if (!voices.length) {
    voices = await new Promise((resolve) => {
      const done = () => resolve(speechSynthesis.getVoices());
      speechSynthesis.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 1200);
    });
  }
  const english = voices.filter((v) => /^en(-|_|$)/i.test(v.lang || ''));
  const pool = english.length ? english : voices;
  if (!pool.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const v of pool) {
    const name = `${v.name} ${v.voiceURI}`.toLowerCase();
    let score = 0;
    for (const hint of FEMALE_HINTS) if (name.includes(hint)) score += hint.length >= 6 ? 6 : 3;
    for (const hint of MALE_HINTS) if (name.includes(hint)) score -= 8;
    if (/google/.test(name)) score += 3;
    if (/natural|neural|enhanced|premium/.test(name)) score += 8;
    if (/compact|espeak|pico|robot/i.test(name)) score -= 6;
    if (v.localService) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}
