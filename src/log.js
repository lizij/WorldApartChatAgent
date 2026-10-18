/**
 * 运行日志：内存环形缓冲（供管理页实时订阅/回看）+ 按天 JSONL 落盘。
 * append 即分配递增 seq 与唯一 rid，并广播给 SSE 订阅者。
 *
 * 请求详情（完整 prompt / 思维链 / 回复）与主日志分离：
 *   - 主日志只记 hasDetail + tokens 汇总，保持轻量；
 *   - 详情单独落盘到 logs/details/YYYY-MM-DD.jsonl，保留期与主日志一致；
 *   - 内存只保留最近 DETAIL_MEMORY_SIZE 条详情，更早的按 rid 从磁盘读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MAX_LOG_LINE = 8 * 1024;
const DETAIL_MAX_CHARS = 256 * 1024;
const DETAIL_MEMORY_SIZE = 100;
const STARTUP_LOAD = 300;

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
    this.detailDir = path.join(this.dir, 'details');
    fs.mkdirSync(this.detailDir, { recursive: true });
    this.buffer = [];
    this.seq = 0;
    this.runId = crypto.randomBytes(4).toString('hex');
    this.details = new Map();
    this.listeners = new Set();
    this.stream = null;
    this.day = null;
    this.detailStream = null;
    this.detailDay = null;
    this.cleanup();
    this.#loadRecent();
  }

  append(rec, detail) {
    this.seq += 1;
    const now = new Date();
    const rid = `${dayKey(now)}-${this.runId}-${this.seq}`;
    const entry = { ...clampStrings(rec || {}), seq: this.seq, rid, ts: now.toISOString() };
    if (detail) {
      entry.hasDetail = true;
      const clamped = clampStrings(detail, { left: DETAIL_MAX_CHARS });
      this.details.set(rid, clamped);
      while (this.details.size > DETAIL_MEMORY_SIZE) {
        this.details.delete(this.details.keys().next().value);
      }
      this.#persistDetail(rid, entry.ts, clamped);
    }
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

  /** 按 rid 取详情：先查内存，再回读当天详情文件。 */
  getDetail(rid) {
    const key = String(rid || '');
    if (!key) return null;
    if (this.details.has(key)) return this.details.get(key);
    return this.#readDetailFromDisk(key);
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

  #persistDetail(rid, ts, detail) {
    try {
      const day = rid.slice(0, 10);
      if (!this.detailStream || this.detailDay !== day) {
        this.detailStream?.end?.();
        this.detailStream = fs.createWriteStream(path.join(this.detailDir, day + '.jsonl'), {
          flags: 'a',
        });
        this.detailDay = day;
      }
      this.detailStream.write(JSON.stringify({ rid, ts, detail }) + '\n');
    } catch (err) {
      console.error('[log] 详情落盘失败:', err.message);
    }
  }

  #readDetailFromDisk(rid) {
    const m = /^(\d{4}-\d{2}-\d{2})-/.exec(rid);
    if (!m) return null;
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(this.detailDir, m[1] + '.jsonl'), 'utf8').split('\n');
    } catch {
      return null;
    }
    // 新记录在文件末尾，倒序查找更快
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && obj.rid === rid) return obj.detail || null;
      } catch {}
    }
    return null;
  }

  /** 启动时回读最近 STARTUP_LOAD 条主日志，让落盘详情在管理页可用。 */
  #loadRecent() {
    let names = [];
    try {
      names = fs
        .readdirSync(this.dir)
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
        .sort()
        .reverse();
    } catch {
      return;
    }
    const out = [];
    for (const name of names) {
      if (out.length >= STARTUP_LOAD) break;
      let lines = [];
      try {
        lines = fs.readFileSync(path.join(this.dir, name), 'utf8').split('\n');
      } catch {
        continue;
      }
      for (let i = lines.length - 1; i >= 0 && out.length < STARTUP_LOAD; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && typeof rec === 'object') out.push(rec);
        } catch {}
      }
    }
    out.reverse();
    this.buffer = out.slice(-Math.min(STARTUP_LOAD, this.maxMemory));
    this.seq = this.buffer.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
  }

  cleanup() {
    const cutoff = Date.now() - this.maxDays * 86400000;
    const removeOld = (dir) => {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (!m) continue;
        if (Date.parse(`${m[1]}T00:00:00`) < cutoff) {
          try {
            fs.unlinkSync(path.join(dir, name));
          } catch {}
        }
      }
    };
    removeOld(this.dir);
    removeOld(this.detailDir);
  }

  async close() {
    const tasks = [];
    if (this.stream) {
      tasks.push(new Promise((resolve) => this.stream.end(resolve)));
      this.stream = null;
    }
    if (this.detailStream) {
      tasks.push(new Promise((resolve) => this.detailStream.end(resolve)));
      this.detailStream = null;
    }
    await Promise.all(tasks);
  }
}
