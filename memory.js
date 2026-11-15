// Local persistence for Riko: conversation turns and long-term facts.
// IndexedDB is the primary store; localStorage is a fallback for browsers or
// private modes where IndexedDB is unavailable. Nothing leaves the device.

const DB_NAME = 'riko-local';
const DB_VERSION = 1;
const TURNS = 'turns';
const FACTS = 'facts';
const TURN_LIMIT = 400;

const LS = {
  turns: 'riko.turns.v2',
  facts: 'riko.facts.v2',
  legacyChat: 'riko.chat.v1',
  legacyMem: 'riko.memory.v1',
};

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the in-memory copy still works this session */
  }
}

export class Memory {
  constructor() {
    this.facts = [];
    this.turns = [];
    this.db = null;
    this.kind = 'memory';
  }

  async init() {
    try {
      this.db = await openDB();
      this.kind = 'indexeddb';
      this.turns = await this.#all(TURNS);
      this.facts = await this.#all(FACTS);
    } catch (err) {
      console.warn('[memory] IndexedDB unavailable, using localStorage', err);
      this.kind = 'localstorage';
      this.turns = readLS(LS.turns, []);
      this.facts = readLS(LS.facts, []);
    }

    this.turns = this.turns.filter(validTurn).slice(-TURN_LIMIT);
    this.facts = dedupeFacts(this.facts.filter(validFact));
    await this.#migrateLegacy();
    return this;
  }

  async #migrateLegacy() {
    if (this.facts.length || this.turns.length) return;
    const oldChat = readLS(LS.legacyChat, []);
    const oldMem = readLS(LS.legacyMem, []);
    if (Array.isArray(oldChat)) {
      for (const t of oldChat) {
        if (t && typeof t.text === 'string' && (t.role === 'user' || t.role === 'riko')) {
          await this.addTurn(t.role, t.text);
        }
      }
    }
    if (Array.isArray(oldMem)) {
      for (const m of oldMem) {
        if (m && typeof m.text === 'string') await this.addFact(m.text, 'auto');
      }
    }
  }

  #all(store) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  #put(store, value) {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  #delete(store, key) {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve) => {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  #clear(store) {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve) => {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async addTurn(role, text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const turn = { role, text: clean, at: Date.now() };
    turn.id = `${turn.at}-${Math.random().toString(36).slice(2, 8)}`;
    this.turns.push(turn);
    if (this.turns.length > TURN_LIMIT) this.turns = this.turns.slice(-TURN_LIMIT);
    if (this.db) await this.#put(TURNS, turn);
    else writeLS(LS.turns, this.turns);
    return turn;
  }

  recentTurns(count = 12) {
    return this.turns.slice(-count);
  }

  async clearTurns() {
    this.turns = [];
    await this.#clear(TURNS);
    writeLS(LS.turns, []);
  }

  async addFact(text, source = 'manual') {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const norm = clean.toLowerCase().replace(/[.!]+$/, '');
    if (this.facts.some((f) => f.text.toLowerCase().replace(/[.!]+$/, '') === norm)) return null;
    const fact = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text: clean, source, at: Date.now() };
    this.facts.unshift(fact);
    this.facts = this.facts.slice(0, 80);
    if (this.db) await this.#put(FACTS, fact);
    else writeLS(LS.facts, this.facts);
    return fact;
  }

  async updateFact(id, text) {
    const fact = this.facts.find((f) => f.id === id);
    if (!fact) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return this.deleteFact(id);
    fact.text = clean;
    if (this.db) await this.#put(FACTS, fact);
    else writeLS(LS.facts, this.facts);
  }

  async deleteFact(id) {
    this.facts = this.facts.filter((f) => f.id !== id);
    await this.#delete(FACTS, id);
    writeLS(LS.facts, this.facts);
  }

  async clearFacts() {
    this.facts = [];
    await this.#clear(FACTS);
    writeLS(LS.facts, []);
  }

  // Facts worth putting in front of the model on every turn.
  topFacts(count = 16) {
    return this.facts.slice(0, count).map((f) => f.text);
  }
}

function validTurn(t) {
  return t && typeof t.text === 'string' && (t.role === 'user' || t.role === 'riko');
}

function validFact(f) {
  return f && typeof f.text === 'string' && f.text.trim();
}

function dedupeFacts(facts) {
  const seen = new Set();
  return facts.filter((f) => {
    const key = f.text.toLowerCase().replace(/[.!]+$/, '').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('no indexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TURNS)) db.createObjectStore(TURNS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FACTS)) db.createObjectStore(FACTS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}
