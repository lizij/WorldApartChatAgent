/**
 * 运行日志：内存环形缓冲（供管理页实时订阅/回看）+ 按天 JSONL 落盘。
 * append 即分配递增 seq，并广播给 SSE 订阅者。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MAX_LOG_LINE = 8 * 1024;

function clampStrings(value, budget = { left: MAX_LOG_LINE }) {
  if (budget.left <= 0) return typeof value === 'string' ? '…' : value;
  if (typeof value === 'string') {
    if (value.length <= budget.left) {
      budget.left -= value.length;
      return value;
    }
    const cut = value.slice(0, Math.max(0, budget.left - 16));
    budget.left = 0;
    return cut + '…[截断]';
  }
  if (Array.isArray(value)) return value.map((v) => clampStrings(v, budget));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clampStrings(v, budget);
    return out;
  }
  return value;
}

export class Logger {
  constructor({ memorySize = 1000, maxDays = 14 } = {}) {
    this.maxMemory = memorySize;
    this.maxDays = maxDays;
    this.dir = path.join(DATA_DIR, 'logs');
    fs.mkdirSync(this.dir, { recursive: true });
    this.buffer = [];
    this.seq = 0;
    this.listeners = new Set();
    this.stream = null;
    this.day = null;
    this.cleanup();
  }

  append(rec) {
    this.seq += 1;
    const entry = { seq: this.seq, ts: new Date().toISOString(), ...clampStrings(rec || {}) };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxMemory) this.buffer.shift();
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {}
    }
    this.#persist(entry);
    return entry;
  }

  list(limit = 300) {
    const n = Math.max(1, Math.min(Number(limit) || 300, this.maxMemory));
    return this.buffer.slice(-n);
  }

  since(seq) {
    const s = Number(seq) || 0;
    return this.buffer.filter((r) => r.seq > s);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #persist(entry) {
    try {
      const day = dayKey();
      if (!this.stream || this.day !== day) {
        this.stream?.end?.();
        this.stream = fs.createWriteStream(path.join(this.dir, day + '.jsonl'), { flags: 'a' });
        this.day = day;
      }
      this.stream.write(JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('[log] 落盘失败:', err.message);
    }
  }

  cleanup() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - this.maxDays * 86400000;
    for (const name of names) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      if (Date.parse(`${m[1]}T00:00:00`) < cutoff) {
        try {
          fs.unlinkSync(path.join(this.dir, name));
        } catch {}
      }
    }
  }

  async close() {
    if (!this.stream) return;
    await new Promise((resolve) => this.stream.end(resolve));
    this.stream = null;
  }
}
