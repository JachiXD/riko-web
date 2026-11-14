// Her voice runs here, on its own thread. Building the model is heavy enough to freeze the
// page if it happens on the main thread, and a frozen page is worse than a slow reply.
import { KokoroTTS } from 'https://esm.sh/kokoro-js@1.2.1';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';

let tts = null;

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === 'init') {
    if (tts) {
      self.postMessage({ type: 'ready' });
      return;
    }
    try {
      tts = await KokoroTTS.from_pretrained(MODEL, {
        dtype: 'q8',
        // The GPU belongs to the 3D scene; sharing it deadlocked the page in testing.
        device: 'wasm',
        progress_callback: (p) => {
          if (p?.status === 'progress' && p.total) {
            self.postMessage({ type: 'progress', ratio: p.loaded / p.total });
          } else if (p?.status === 'done') {
            self.postMessage({ type: 'progress', ratio: 1 });
          }
        },
      });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', stage: 'init', message: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === 'speak') {
    try {
      if (!tts) throw new Error('voice engine is not ready');
      const audio = await tts.generate(msg.text, { voice: VOICE, speed: msg.speed });
      const samples = audio.audio;
      self.postMessage({ type: 'audio', id: msg.id, samples, rate: audio.sampling_rate }, [
        samples.buffer,
      ]);
    } catch (err) {
      self.postMessage({
        type: 'error',
        stage: 'speak',
        id: msg.id,
        message: String(err?.message || err),
      });
    }
  }
};
