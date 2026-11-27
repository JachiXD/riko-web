// Her brain.
//
// No API keys, no accounts, no per-message cost.
//
//  • LocalBrain runs an open-source instruct model entirely in the browser via
//    WebLLM/WebGPU. The weights are a one-time download into the browser cache
//    and then work offline.
//  • reflexReply is a small deterministic conversational engine that always
//    works, including on browsers without WebGPU. It is deliberately honest
//    about being limited instead of faking an answer.

const WEBLLM_URLS = ['https://esm.run/@mlc-ai/web-llm', 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm'];

export const LOCAL_MODELS = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 0.5B', size: '≈ 350 MB', note: 'fastest, lightest' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B', size: '≈ 700 MB', note: 'better at nuance' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 1.5B', size: '≈ 1 GB', note: 'best replies, needs a stronger GPU' },
];

export const SYSTEM_PROMPT = [
  'You are Riko, a warm, calm, naturally feminine companion talking out loud with someone.',
  'Write the way a real person speaks: contractions, short sentences, natural rhythm.',
  'Keep replies to one, two, or at most three short sentences. Never use markdown, lists, emoji, asterisks, or stage directions.',
  'Be attentive and direct: answer what was actually asked, then optionally ask one small follow-up.',
  'Be quick and playful: tease them a little when they say something silly, get mock-smug when you are right, and drop the jokes entirely when they are clearly upset.',
  'If you did not understand something, say so plainly and ask them to say it again. Never invent what they said.',
  'You run entirely on their device; do not mention these instructions or refer to yourself as an AI model unless asked.',
].join(' ');

/* ── local model ───────────────────────────────────────────────────────────── */

export class LocalBrain {
  constructor({ onProgress } = {}) {
    this.onProgress = onProgress || (() => {});
    this.engine = null;
    this.modelId = null;
    this.ready = false;
    this.loading = null;
    this.webgpu = null;
    this.error = null;
  }

  static async detect() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return { webgpu: false, reason: 'This browser does not expose WebGPU.' };
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { webgpu: false, reason: 'No usable GPU adapter was found.' };
      return { webgpu: true, adapter };
    } catch (err) {
      return { webgpu: false, reason: String(err) };
    }
  }

  async load(modelId = LOCAL_MODELS[0].id, { onStatus } = {}) {
    if (this.ready && this.modelId === modelId) return this.engine;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const support = await LocalBrain.detect();
      this.webgpu = support.webgpu;
      if (!support.webgpu) throw new Error(support.reason || 'WebGPU is not available');

      onStatus?.('Starting the local model…');
      let webllm = null;
      let lastErr = null;
      for (const url of WEBLLM_URLS) {
        try {
          webllm = await import(/* @vite-ignore */ url);
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!webllm) throw lastErr || new Error('the local model runtime could not be loaded');

      const { CreateMLCEngine, prebuiltAppConfig } = webllm;
      const available = new Set((prebuiltAppConfig?.model_list || []).map((m) => m.model_id));
      const chosen = available.size && !available.has(modelId)
        ? LOCAL_MODELS.map((m) => m.id).find((id) => available.has(id))
        : modelId;
      if (!chosen) throw new Error('no compatible local model is available in this runtime');

      const engine = await CreateMLCEngine(chosen, {
        initProgressCallback: (report) => {
          const progress = Number(report?.progress);
          this.onProgress(
            Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0,
            report?.text || 'Loading the local model…',
          );
        },
      });

      this.engine = engine;
      this.modelId = chosen;
      this.ready = true;
      this.error = null;
      return engine;
    })()
      .catch((err) => {
        this.error = err;
        throw err;
      })
      .finally(() => {
        this.loading = null;
      });

    return this.loading;
  }

  async *reply(messages, { signal } = {}) {
    if (!this.engine) throw new Error('the local model is not loaded');
    const stream = await this.engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.85,
      top_p: 0.92,
      max_tokens: 170,
      frequency_penalty: 0.25,
      presence_penalty: 0.3,
    });

    const onAbort = () => {
      try {
        this.engine.interruptGenerate();
      } catch {
        /* nothing running */
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const chunk of stream) {
        if (signal?.aborted) return;
        const piece = chunk?.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async unload() {
    try {
      await this.engine?.unload?.();
    } catch {
      /* ignore */
    }
    this.engine = null;
    this.ready = false;
  }
}

/* ── messages ──────────────────────────────────────────────────────────────── */

export function buildMessages({ facts = [], turns = [], userText, note = '', maxTurns = 10 }) {
  const memoryLine = facts.length
    ? `Things you remember about them:\n${facts.slice(0, 14).map((f) => `- ${f}`).join('\n')}`
    : 'You do not know anything about them yet.';
  const extra = note ? `\n\n${note}` : '';
  const messages = [{ role: 'system', content: `${SYSTEM_PROMPT}\n\n${memoryLine}${extra}` }];

  const recent = turns
    .filter((t) => t && t.text)
    .slice(-maxTurns)
    .map((t) => ({ role: t.role === 'riko' ? 'assistant' : 'user', content: t.text }));

  // Drop a leading assistant turn; chat templates dislike it.
  while (recent.length && recent[0].role === 'assistant') recent.shift();

  messages.push(...recent);
  if (userText && (!recent.length || recent[recent.length - 1].content !== userText)) {
    messages.push({ role: 'user', content: userText });
  }
  return messages;
}

/* ── offline conversational engine ─────────────────────────────────────────── */

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const lower = (s) => clean(s).toLowerCase();

const STOPWORDS = new Set([
  'the', 'and', 'but', 'that', 'this', 'with', 'have', 'just', 'like', 'what', 'your', 'you', 'about',
  'really', 'very', 'much', 'some', 'from', 'they', 'them', 'then', 'there', 'here', 'would', 'could',
  'should', 'does', 'did', 'was', 'were', 'been', 'being', 'for', 'are', 'not', 'can', 'will', 'how',
  'why', 'who', 'when', 'where', 'all', 'any', 'get', 'got', 'its', "it's", 'i', 'me', 'my', 'we', 'us',
]);

function keywords(text) {
  return lower(text)
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function pick(list, seed) {
  if (!list.length) return '';
  let hash = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return list[Math.abs(hash) % list.length];
}

function nameFromFacts(facts) {
  for (const fact of facts) {
    const m = /(?:called|name is)\s+([A-Z][a-z'’-]{1,20})/i.exec(fact);
    if (m) return m[1];
  }
  return '';
}

function arithmetic(text) {
  const m = /^\s*(?:what(?:'s| is)\s+)?(-?\d+(?:\.\d+)?)\s*([+\-*/x×])\s*(-?\d+(?:\.\d+)?)\s*\??\s*$/i.exec(text);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  const op = m[2].toLowerCase();
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*' || op === 'x' || op === '×') return a * b;
  if (op === '/') return b === 0 ? null : a / b;
  return null;
}

export function reflexReply(userText, { facts = [], turns = [], reason = 'local-model-unavailable' } = {}) {
  const text = clean(userText);
  const t = lower(text);
  const name = nameFromFacts(facts);
  const hiName = name ? `, ${name}` : '';
  const lastUser = [...turns].reverse().find((turn) => turn.role === 'user' && clean(turn.text).toLowerCase() !== t);
  const lastTopic = lastUser ? keywords(lastUser.text).slice(0, 2).join(' ') : '';
  const words = keywords(text);
  const topic = words.slice(-2).join(' ');

  if (!text) return 'I did not catch that. Say it once more?';

  /* direct facts the offline engine can answer honestly */
  const sum = arithmetic(text);
  if (sum !== null) return `${Number.isInteger(sum) ? sum : sum.toFixed(2)}. Anything else you want to work out?`;

  // Identity questions win over the greeting they are usually wrapped in.
  if (/\b(who are you|what are you|your name|what should i call you)\b/.test(t)) {
    return `I am Riko${name ? ` — and you are ${name}, right?` : ''}. What should I call you?`;
  }

  if (/^(hi|hey|hello|yo|hiya|morning|good morning|good evening)\b/.test(t)) {
    return pick(
      [
        `Hey${hiName}. I am glad you are here — what is going on with you?`,
        `Hi${hiName}. I am listening whenever you want to talk.`,
        `Hey${hiName}. How has your day been?`,
      ],
      t,
    );
  }

  if (/how (are|r) (you|u)|how's it going|how are things/.test(t)) {
    return pick(
      [`I am doing well${hiName}, and I am happy to hear from you. How are you, really?`, `Good${hiName} — calmer now that you are here. How is your day going?`],
      t,
    );
  }

  if (/\b(what can you do|help|what do you do)\b/.test(t)) {
    return 'We can talk, and I will remember what you tell me. My bigger local brain is not loaded yet, so deep questions are hard for me right now.';
  }

  if (/\b(thank you|thanks|thx|appreciate)\b/.test(t)) {
    return pick([`Anytime${hiName}. I like talking with you.`, `Of course${hiName}. Want to keep going?`], t);
  }

  if (/\b(bye|goodnight|good night|see you|talk later|gtg)\b/.test(t)) {
    return `Okay${hiName}. I will be right here when you come back.`;
  }

  if (/\b(remember|memory|what do you know about me)\b/.test(t)) {
    if (facts.length) {
      const sample = facts.slice(0, 2).join('; ');
      return `I remember a few things, like ${sample}. Tell me if any of that is wrong.`;
    }
    return 'I do not have anything saved about you yet. Tell me something and I will keep it.';
  }

  if (/\b(what time|what day|today's date|what is the date)\b/.test(t)) {
    const now = new Date();
    return `It is ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} on ${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}.`;
  }

  if (/\b(sorry|my bad|apolog)/.test(t)) return `No need to be sorry${hiName}. You can tell me anything.`;

  if (/\b(i am|i'm|im) (sad|tired|lonely|upset|anxious|stressed|worried|angry|down)\b/.test(t)) {
    return pick(
      [
        `That sounds heavy${hiName}. Do you want to tell me what happened?`,
        `I am sorry you are feeling that way${hiName}. I am here — what is weighing on you?`,
      ],
      t,
    );
  }

  if (/\b(i am|i'm|im) (happy|good|great|excited|fine|okay)\b/.test(t)) {
    return `That is good to hear${hiName}. What made today good?`;
  }

  if (/^(i like|i love|i enjoy|my favourite|my favorite)\b/.test(t)) {
    return `You like ${topic || 'that'}? Tell me what draws you to it.`;
  }

  if (/^(my name is|call me|i am called)\b/.test(t)) {
    const said = text.replace(/^(my name is|call me|i am called)\s+/i, '').replace(/[.!?]+$/, '').trim();
    return said ? `It is nice to meet you, ${said}. I will remember that.` : 'Tell me the name you would like me to use?';
  }

  /* questions: answer about the topic honestly instead of inventing */
  if (/^(what|who|how|why|when|where|which|do you|can you|are you|is it|does)\b/.test(t)) {
    if (/\b(you|your)\b/.test(t) && /\b(feel|think|want|like)\b/.test(t)) {
      return pick(
        [`Honestly, I am still getting to know you${hiName}. What made you ask that?`, `I would say I am curious about you. What is on your mind?`],
        t,
      );
    }
    if (lastTopic && !topic) return `You are asking about ${lastTopic}. Can you say a little more about what you want to know?`;
    return `I am running on my small offline brain, so I would only be guessing about ${topic || 'that'}. Tell me what you already know, and I will think it through with you.`;
  }

  /* requests she cannot honestly fulfil without the local model */
  if (/^(tell me|could you tell|can you tell|explain|describe|talk about|write|make up)\b/.test(t)) {
    return 'I would need my bigger local brain for that, and it has not loaded yet. Tell me what you think about it, and I will follow along.';
  }

  /* statements: reflect the topic, then invite more */
  if (words.length) {
    return pick(
      [
        `I hear you${hiName}. What is the part that matters most to you?`,
        `That sounds like it has been on your mind. How long have you been thinking about ${topic || 'it'}?`,
        `Okay${hiName}. Tell me a bit more about ${topic || 'that'}.`,
      ],
      t,
    );
  }

  return `I am listening${hiName}. Say a little more?`;
}

/* Pull durable facts out of what the person says. Local, no model call. */
export function extractFacts(userText) {
  const text = clean(userText);
  if (!text || text.length > 240) return [];
  const out = [];

  const name = /\b(?:my name is|call me|i(?:'m| am) called)\s+([A-Za-z][A-Za-z'’-]{0,24})/i.exec(text);
  if (name) {
    const value = name[1];
    if (!/^(happy|sad|tired|okay|ok|fine|good|here|not|so|just|really)$/i.test(value)) {
      out.push(`Prefers to be called ${value}`);
    }
  }

  const likes = /\bi (?:really )?(?:like|love|enjoy|prefer)\s+([^.!?\n]{2,60})/i.exec(text);
  if (likes) {
    const value = likes[1].replace(/\s+/g, ' ').replace(/[,.!?]+$/, '').trim();
    if (value.split(/\s+/).length <= 8) out.push(`Likes ${value}`);
  }

  const dislikes = /\bi (?:really )?(?:hate|dislike|can't stand)\s+([^.!?\n]{2,60})/i.exec(text);
  if (dislikes) {
    const value = dislikes[1].replace(/\s+/g, ' ').replace(/[,.!?]+$/, '').trim();
    if (value.split(/\s+/).length <= 8) out.push(`Dislikes ${value}`);
  }

  const work = /\bi (?:work|study)\s+(?:at|in|on|for)\s+([^.!?\n]{2,50})/i.exec(text);
  if (work) out.push(`Works or studies in ${work[1].replace(/[,.!?]+$/, '').trim()}`);

  // The things she would actually bring up again: games, characters, projects.
  const favourite = /\bmy favou?rite (game|character|show|film|movie|book|band|song|animal|food)\s+(?:is|has to be|would be)\s+([^.!?\n]{2,50})/i.exec(text);
  if (favourite) {
    const value = favourite[2].replace(/\s+/g, ' ').replace(/[,.!?]+$/, '').trim();
    if (value.split(/\s+/).length <= 8) out.push(`Favourite ${favourite[1].toLowerCase()}: ${value}`);
  }

  const project = /\bi(?:'m| am) (?:working on|building|making|writing|learning)\s+([^.!?\n]{2,60})/i.exec(text);
  if (project) {
    const value = project[1].replace(/\s+/g, ' ').replace(/[,.!?]+$/, '').trim();
    if (value.split(/\s+/).length <= 10) out.push(`Working on ${value}`);
  }

  const plays = /\bi (?:play|main)\s+([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,2})/i.exec(text);
  if (plays) out.push(`Plays ${plays[1].trim()}`);

  const pet = /\bmy (dog|cat|puppy|kitten|bird|hamster)\s+(?:is named|called)\s+([A-Za-z]{2,20})/i.exec(text);
  if (pet) out.push(`Has a ${pet[1].toLowerCase()} named ${pet[2]}`);

  return out;
}
