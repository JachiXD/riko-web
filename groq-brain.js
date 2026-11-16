/**
 * Groq, reached through the proxy.
 *
 * Shaped like the existing LocalBrain: `reply(messages, { signal })` is an
 * async iterator of text pieces, so the app's streamReply() can swap one for
 * the other without touching the rest of its pipeline. The key lives on the
 * server; this only ever sees text.
 */

const DEFAULT_ENDPOINT = 'https://site-43c53528988b4cca8ce63dd3cac24b06.freebuff.page';

export class GroqBrain {
  constructor({ endpoint = DEFAULT_ENDPOINT, onStatus } = {}) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.onStatus = onStatus;
    this.ready = false;
    this.loading = false;
    this.model = null;
    this.reason = null;
  }

  /** Ask the proxy what it is configured with. Cheap, and never sends a key. */
  async prepare() {
    if (this.loading) return this.ready;
    this.loading = true;
    try {
      const res = await fetch(`${this.endpoint}/api/health`, { cache: 'no-store' });
      const info = await res.json().catch(() => ({}));
      this.ready = res.ok && info.groq === true;
      this.model = info.model || null;
      this.reason = this.ready ? null : info.error || 'the Groq key is not configured on the server';
    } catch (err) {
      this.ready = false;
      this.reason = 'the reply server is unreachable';
      console.warn('[groq] health check failed', err);
    } finally {
      this.loading = false;
    }
    if (!this.ready) this.onStatus?.(this.reason);
    return this.ready;
  }

  /**
   * Stream a reply. Yields plain text pieces as they arrive.
   * Errors are thrown so the caller can fall back to its offline brain.
   */
  async *reply(messages, { signal } = {}) {
    if (!this.ready && !(await this.prepare())) {
      throw new Error(this.reason || 'the reply server is not ready');
    }

    const res = await fetch(`${this.endpoint}/api/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages, stream: true }),
      signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error || '';
      } catch {
        /* ignore */
      }
      if (res.status === 429) {
        const wait = res.headers.get('Retry-After') || '';
        throw new Error(wait ? `she is being rate limited, try again in ${wait}` : 'she is being rate limited');
      }
      throw new Error(detail || `the reply server answered ${res.status}`);
    }
    if (!res.body) throw new Error('the reply server returned no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (payload.error) throw new Error(payload.error);
          if (payload.delta) yield payload.delta;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
