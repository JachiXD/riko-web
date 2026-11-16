/**
 * Fish Audio, reached through the proxy.
 *
 * Same public surface as the existing Voice class, so app.js can construct this
 * one instead and keep its SpeechBridge, its sentence queue and its lip-sync
 * hookup. Audio is decoded through Web Audio rather than an <audio> tag so the
 * mouth can follow the real signal, and so a cancelled sentence stops instantly.
 */

const DEFAULT_ENDPOINT = 'https://site-43c53528988b4cca8ce63dd3cac24b06.freebuff.page';

export class VoiceError extends Error {
  constructor(message, kind = 'voice') {
    super(message);
    this.name = 'VoiceError';
    this.kind = kind;
  }
}

export class FishVoice {
  constructor({ endpoint = DEFAULT_ENDPOINT, onStart, onClause, onIdle, onStatus } = {}) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.onStart = onStart;
    this.onClause = onClause;
    this.onIdle = onIdle;
    this.onStatus = onStatus;

    this.mode = 'fish';
    this.speaking = false;
    this.ready = false;
    this.token = 0;
    this.context = null;
    this.analyser = null;
    this.levels = null;
    this.source = null;
    this.controller = null;
    this.playedAt = 0;
    this.failures = 0;
  }

  /* audio context */

  ensureContext() {
    if (this.context) return this.context;
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) throw new VoiceError('this browser has no Web Audio', 'unsupported');
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    analyser.connect(ctx.destination);
    this.context = ctx;
    this.analyser = analyser;
    this.levels = new Uint8Array(analyser.frequencyBinCount);
    return ctx;
  }

  /** Browsers only allow audio after a gesture; the UI calls this from one. */
  async unlock() {
    try {
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') await ctx.resume();
      return ctx.state === 'running';
    } catch (err) {
      console.warn('[fish] audio context unavailable', err);
      return false;
    }
  }

  get locked() {
    return !this.context || this.context.state !== 'running';
  }

  async prepare() {
    try {
      const res = await fetch(`${this.endpoint}/api/health`, { cache: 'no-store' });
      const info = await res.json().catch(() => ({}));
      this.ready = res.ok && info.fish === true;
      if (!this.ready) this.onStatus?.('Her voice service is not configured yet.');
    } catch (err) {
      this.ready = false;
      this.onStatus?.('Her voice service is unreachable.');
      console.warn('[fish] health check failed', err);
    }
    return this.ready;
  }

  /* level for lip-sync */

  getLevel() {
    if (!this.analyser || !this.speaking) return 0;
    this.analyser.getByteTimeDomainData(this.levels);
    let peak = 0;
    for (let i = 0; i < this.levels.length; i += 4) {
      const v = Math.abs(this.levels[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return Math.min(1, peak * 1.6);
  }

  isAudible() {
    return this.speaking && performance.now() - this.playedAt > 120;
  }

  /* speech */

  async speak(text, token = ++this.token) {
    const clean = String(text || '').trim();
    if (!clean) return;
    this.token = token;
    this.speaking = true;
    try {
      await this.#say(clean, token);
    } catch (err) {
      if (token !== this.token) return;
      console.warn('[fish] sentence failed', err);
      this.speaking = false;
      // Two dead sentences in a row means the service, not the sentence, is the
      // problem: stand down so the caller can use its own voice instead.
      if (++this.failures >= 2) {
        this.ready = false;
        this.onStatus?.('Her voice service is not answering, so she is using the in-page voice.');
      } else {
        this.onStatus?.('Her voice stumbled on that sentence.');
      }
    }
  }

  async #say(text, token) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();

    this.controller = new AbortController();
    const res = await fetch(`${this.endpoint}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: this.controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error || '';
      } catch {
        /* ignore */
      }
      throw new VoiceError(detail || `the voice server answered ${res.status}`);
    }

    const bytes = await res.arrayBuffer();
    if (token !== this.token) return;
    if (!bytes.byteLength) throw new VoiceError('the voice returned no audio', 'silent');

    const buffer = await ctx.decodeAudioData(bytes);
    if (token !== this.token) return;
    this.failures = 0;

    // The clause starts when the audio actually starts, so her mouth and her
    // gestures stay tied to the sound rather than to the request.
    this.onClause?.(text, buffer.duration);

    await new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser);
      this.source = source;
      source.onended = () => {
        if (this.source === source) this.source = null;
        resolve();
      };
      source.start();
      this.playedAt = performance.now();
      this.onStart?.();
    });

    if (token === this.token) {
      this.speaking = false;
      this.onIdle?.();
    }
  }

  stop() {
    this.token++;
    this.speaking = false;
    this.controller?.abort();
    this.controller = null;
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source = null;
    }
    this.onIdle?.();
  }
}
