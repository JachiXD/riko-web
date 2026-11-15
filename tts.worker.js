// Kokoro neural voice, off the main thread. Synthesis in the page thread froze
// the avatar and the UI, which is why this lives in a worker.
// The engine is verified by the page before any of it is played.

let tts = null;
let loaded = null; // string key of the loaded variant

async function load({ dtype, device }) {
  const key = `${dtype}|${device}`;
  if (tts && loaded === key) return { cached: true };
  if (tts) {
    try { tts = null; } catch { /* drop the old instance */ }
  }
  const { KokoroTTS } = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm');
  const started = performance.now();
  tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype,
    device,
    progress_callback: (p) => {
      if (!p) return;
      if (p.status === 'progress' && Number.isFinite(p.progress)) {
        self.postMessage({ type: 'progress', progress: p.progress / 100, file: p.file, loaded: p.loaded, total: p.total });
      } else if (p.status === 'initiate') {
        self.postMessage({ type: 'progress', progress: 0, file: p.file });
      }
    },
  });
  loaded = key;
  return { cached: false, ms: Math.round(performance.now() - started) };
}

function describe(samples, rate) {
  let peak = 0;
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) {
      bad++;
      continue;
    }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { length: samples.length, rate, peak, rms: Math.sqrt(sum / samples.length), bad, duration: samples.length / rate };
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'load') {
      const result = await load(msg);
      self.postMessage({ type: 'loaded', id: msg.id, ...result });
      return;
    }
    if (msg.type === 'speak') {
      if (!tts) throw new Error('the voice model is not loaded');
      const started = performance.now();
      const audio = await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed });
      const samples = audio.audio;
      const stats = describe(samples, audio.sampling_rate);
      // Copy into a transferable buffer rather than structured-cloning twice.
      const out = new Float32Array(samples.length);
      out.set(samples);
      self.postMessage(
        { type: 'audio', id: msg.id, samples: out, stats, ms: Math.round(performance.now() - started) },
        [out.buffer],
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, error: String((err && err.message) || err) });
  }
};
