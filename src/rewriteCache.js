/**
 * 请求重写缓存：全局 LRU 键值存储（按机制分文件）。
 *
 * 设计要点：
 *   - 缓存键本身已包含 NPC slug，因此不需要按 NPC 分文件；
 *     每个机制在 data/ 下单独维护一个全局文件，例如
 *     data/rewrite-cache-exact.json（机制 1：整轮指纹缓存）。
 *   - 运行期只读写内存 LRU，变更后防抖异步落盘，避免每轮重写 8MB 全量 JSON。
 *   - 默认上限 1000 条，超出按最久未使用淘汰；条目带 createdAt，读取时按 TTL 过滤。
 *   - 仅加速，不是事实来源：文件损坏、写失败、进程退出丢最后一段都可接受。
 *   - 首次加载时会把 0.13.x 及更早的 data/npcs/<slug>/rewrite-cache.json
 *     合并进机制 1 的全局文件，成功落盘后删除旧文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { NPCS_DIR } from './memory/store.js';

const LEGACY_FILE = 'rewrite-cache.json';
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_DEBOUNCE_MS = 2000;

let tmpSeq = 0;

function fileForMode(dataDir, mode) {
  return path.join(dataDir, `rewrite-cache-${mode}.json`);
}

/** 每次写入使用独立临时文件名，避免同步 flush 与异步写互相覆盖。 */
function tmpPathFor(file) {
  tmpSeq += 1;
  return `${file}.${process.pid}.${tmpSeq}.tmp`;
}

function renameOverSync(tmp, file) {
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows 上极少数情况无法覆盖已有文件
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

async function renameOver(tmp, file) {
  try {
    await fs.promises.rename(tmp, file);
  } catch {
    await fs.promises.rm(file, { force: true });
    await fs.promises.rename(tmp, file);
  }
}

export class RewriteCache {
  constructor({ dataDir = DATA_DIR, npcsDir = NPCS_DIR, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
    this.dataDir = dataDir;
    this.npcsDir = npcsDir;
    this.debounceMs = debounceMs;
    this.stores = new Map();
  }

  #store(mode) {
    let store = this.stores.get(mode);
    if (store) return store;
    store = {
      mode,
      file: fileForMode(this.dataDir, mode),
      entries: new Map(),
      loaded: false,
      dirty: false,
      timer: null,
      writing: false,
    };
    this.stores.set(mode, store);
    this.#load(store);
    return store;
  }

  #load(store) {
    if (store.loaded) return;
    store.loaded = true;
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    } catch {}
    if (data && Array.isArray(data.entries)) {
      for (const entry of data.entries) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.raw !== 'string') continue;
        store.entries.set(entry.key, entry);
      }
    }
    // 旧版逐 NPC 缓存只在机制 1 上迁移
    if (store.mode === 'exact') this.#migrateLegacy(store);
  }

  #migrateLegacy(store) {
    let slugs = [];
    try {
      slugs = fs.readdirSync(this.npcsDir);
    } catch {
      return;
    }
    const legacyFiles = [];
    let merged = false;
    for (const slug of slugs) {
      const file = path.join(this.npcsDir, slug, LEGACY_FILE);
      if (!fs.existsSync(file)) continue;
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (!data || !Array.isArray(data.entries)) continue;
      for (const entry of data.entries) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.raw !== 'string') continue;
        const prev = store.entries.get(entry.key);
        if (!prev || (Number(entry.createdAt) || 0) > (Number(prev.createdAt) || 0)) {
          store.entries.set(entry.key, entry);
          merged = true;
        }
      }
      legacyFiles.push(file);
    }
    if (!legacyFiles.length) return;
    // 先同步落盘，确保迁移结果先于旧文件删除；失败则保留旧文件下次再试
    try {
      if (merged || !fs.existsSync(store.file)) this.#writeSync(store);
    } catch {
      return;
    }
    for (const file of legacyFiles) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  }

  #writeSync(store) {
    const tmp = tmpPathFor(store.file);
    const payload = JSON.stringify({
      version: 1,
      mode: store.mode,
      entries: [...store.entries.values()],
    });
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(tmp, payload, 'utf8');
    renameOverSync(tmp, store.file);
    store.dirty = false;
  }

  async #persist(store) {
    if (store.writing) {
      store.dirty = true;
      return;
    }
    store.writing = true;
    try {
      do {
        if (!store.dirty) break;
        store.dirty = false;
        const tmp = tmpPathFor(store.file);
        const payload = JSON.stringify({
          version: 1,
          mode: store.mode,
          entries: [...store.entries.values()],
        });
        await fs.promises.mkdir(path.dirname(store.file), { recursive: true });
        await fs.promises.writeFile(tmp, payload, 'utf8');
        await renameOver(tmp, store.file);
      } while (store.dirty);
    } catch {
      // 缓存写失败不影响对话
    } finally {
      store.writing = false;
    }
  }

  #schedule(store) {
    store.dirty = true;
    if (store.timer) return;
    store.timer = setTimeout(() => {
      store.timer = null;
      this.#persist(store);
    }, this.debounceMs);
    store.timer.unref?.();
  }

  /**
   * 取缓存条目并按 LRU 移到队尾；过期条目直接删除。
   * 纯读取顺序变化不触发落盘，避免命中时也反复写大盘。
   */
  get(mode, key, { ttlMs = 0 } = {}) {
    if (!mode || !key) return null;
    const store = this.#store(mode);
    const entry = store.entries.get(key);
    if (!entry) return null;
    if (ttlMs > 0 && Date.now() - (Number(entry.createdAt) || 0) > ttlMs) {
      store.entries.delete(key);
      this.#schedule(store);
      return null;
    }
    store.entries.delete(key);
    store.entries.set(key, entry);
    return entry;
  }

  /** 写入缓存，并按容量淘汰最久未使用的条目。 */
  set(mode, key, entry, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (!mode || !key || !entry) return;
    const store = this.#store(mode);
    if (store.entries.has(key)) store.entries.delete(key);
    store.entries.set(key, entry);
    const limit = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
    while (store.entries.size > limit) {
      store.entries.delete(store.entries.keys().next().value);
    }
    this.#schedule(store);
  }

  size(mode) {
    if (!mode) return 0;
    return this.#store(mode).entries.size;
  }

  /** 进程退出前同步落盘；定时器 unref，不会拖住进程。 */
  flushSync(mode = null) {
    const stores = mode ? [this.#store(mode)] : [...this.stores.values()];
    for (const store of stores) {
      if (store.timer) {
        clearTimeout(store.timer);
        store.timer = null;
      }
      // 异步写正在进行时跳过：它的 do/while 会把最新脏状态继续写完
      if (!store.dirty || store.writing) continue;
      try {
        this.#writeSync(store);
      } catch {}
    }
  }
}

/** 进程内单例；按机制分文件，后续机制复用同一实例即可。 */
export const rewriteCache = new RewriteCache();
