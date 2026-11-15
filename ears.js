// Her ears. Browser-native speech recognition, with explicit handling for the
// cases that used to produce wrong or duplicated messages.

const SILENCE_MS = 1500;      // a natural pause ends the turn
const MAX_LISTEN_MS = 20000;  // never hold the mic open forever
const MIN_CONFIDENCE = 0.45;  // below this we ask instead of guessing

export class Ears {
  constructor({ lang = 'en-US', onPartial, onFinal, onError, onListening } = {}) {
    this.lang = lang;
    this.onPartial = onPartial || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onError = onError || (() => {});
    this.onListening = onListening || (() => {});
    this.rec = null;
    this.active = false;
    this.finalText = '';
    this.interimText = '';
    this.lowestConfidence = 1;
    this.silenceTimer = null;
    this.maxTimer = null;
    this.finished = false;
  }

  static get supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  get listening() {
    return this.active;
  }

  start() {
    if (this.active) return false;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      this.onError({ kind: 'unsupported' });
      return false;
    }

    this.stop(); // never leave a previous session running
    this.finalText = '';
    this.interimText = '';
    this.lowestConfidence = 1;
    this.finished = false;

    const rec = new Recognition();
    this.rec = rec;
    rec.lang = this.lang;
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 3;

    rec.onstart = () => {
      this.active = true;
      this.onListening(true);
      this.#armSilence();
      this.maxTimer = setTimeout(() => this.stop(), MAX_LISTEN_MS);
    };

    rec.onresult = (event) => {
      let finalAdd = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const best = result[0];
        const text = best?.transcript || '';
        if (result.isFinal) {
          finalAdd += text;
          if (typeof best.confidence === 'number' && best.confidence > 0) {
            this.lowestConfidence = Math.min(this.lowestConfidence, best.confidence);
          }
        } else {
          interim += text;
        }
      }
      if (finalAdd) this.finalText = (this.finalText + ' ' + finalAdd).replace(/\s+/g, ' ').trim();
      this.interimText = interim.trim();
      const heard = (this.finalText || this.interimText).trim();
      if (heard) this.onPartial(heard);
      this.#armSilence();
    };

    rec.onerror = (event) => {
      const kind = event.error || 'unknown';
      if (kind === 'aborted') return;
      // A stray "no-speech" after we already have text is not an error.
      if (kind === 'no-speech' && (this.finalText || this.interimText)) return;
      this.#finish({ error: kind });
    };

    rec.onend = () => {
      this.#finish({});
    };

    try {
      rec.start();
      return true;
    } catch (err) {
      this.#cleanup();
      this.active = false;
      this.onListening(false);
      this.onError({ kind: 'start-failed', error: err });
      return false;
    }
  }

  // Ask the recognition engine to wrap up; onend delivers the transcript.
  stop() {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.maxTimer);
    const rec = this.rec;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  }

  cancel() {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.maxTimer);
    this.finished = true;
    const rec = this.rec;
    this.rec = null;
    this.active = false;
    this.finalText = '';
    this.interimText = '';
    this.onListening(false);
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* nothing to abort */
      }
    }
  }

  #armSilence() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.stop(), SILENCE_MS);
  }

  #cleanup() {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.maxTimer);
    this.silenceTimer = null;
    this.maxTimer = null;
    this.rec = null;
  }

  #finish({ error }) {
    if (this.finished) return;
    this.finished = true;
    this.#cleanup();
    this.active = false;
    this.onListening(false);

    const finalText = this.finalText.trim();
    const partial = this.interimText.trim();

    if (error === 'not-allowed' || error === 'service-not-allowed') {
      this.onError({ kind: 'blocked' });
      return;
    }
    if (error && error !== 'no-speech' && error !== 'network') {
      this.onError({ kind: error });
      return;
    }
    if (error === 'network') {
      this.onError({ kind: 'network' });
      return;
    }

    if (finalText) {
      if (this.lowestConfidence < MIN_CONFIDENCE && finalText.split(/\s+/).length > 1) {
        this.onError({ kind: 'unclear', heard: finalText });
        return;
      }
      this.onFinal(finalText);
      return;
    }
    if (partial) {
      // Something was heard but the engine never confirmed it: say so instead of
      // silently inventing a message.
      this.onError({ kind: 'partial', heard: partial });
      return;
    }
    this.onError({ kind: 'nothing' });
  }
}
