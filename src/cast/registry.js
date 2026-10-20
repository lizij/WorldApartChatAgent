/**
 * 配角名册（运行期缓存，非持久化文件）：
 * 扫描 data/npcs/* 的 slug / state.rawNames / aliases.json，得到「名字 → slug」映射，
 * 并记录每个 NPC 是否有可用的 intake 存档（没有 intake 就无法构造角色卡）。
 *
 * 缓存 60 秒；管理页改动别名后调用 invalidateRegistry() 立即失效。
 * 只有开启共演时才会被调用，关闭时零开销。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NPCS_DIR } from '../memory/store.js';

const TTL_MS = 60000;

let cache = { at: 0, entries: [], map: new Map() };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function hasIntake(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'intake')).some((n) => n.endsWith('.md'));
  } catch {
    return false;
  }
}

export function invalidateRegistry() {
  cache = { at: 0, entries: [], map: new Map() };
}

export function getRegistry() {
  if (cache.entries.length && Date.now() - cache.at < TTL_MS) return cache;

  let dirs = [];
  try {
    dirs = fs.readdirSync(NPCS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {}

  const entries = [];
  const map = new Map();
  for (const d of dirs) {
    const slug = d.name;
    const dir = path.join(NPCS_DIR, slug);
    const state = readJson(path.join(dir, 'state.json'), {}) || {};
    const aliases = readJson(path.join(dir, 'aliases.json'), {}) || {};
    const cast = readJson(path.join(dir, 'cast.json'), {}) || {};
    const list = [slug, ...(Array.isArray(state.rawNames) ? state.rawNames : [])];
    if (Array.isArray(aliases.names)) list.push(...aliases.names);
    const names = [...new Set(list.map((x) => String(x || '').trim()).filter(Boolean))];
    entries.push({
      slug,
      dir,
      names,
      hasIntake: hasIntake(dir),
      castEnabled: cast.enabled === true,
    });
    for (const n of names) {
      // 先到先得即可：同名的第二个档案会用其 slug 自身兜底
      if (!map.has(n)) map.set(n, slug);
    }
  }

  cache = { at: Date.now(), entries, map };
  return cache;
}

export function entryOf(slug) {
  return getRegistry().entries.find((e) => e.slug === slug) || null;
}

/** 按名字长度降序，保证「奈宝·江楚弦」先于「江楚弦」被匹配。 */
export function allNamesByLength() {
  return [...getRegistry().map.keys()].sort((a, b) => b.length - a.length);
}

export function loadAliases(slug) {
  const v = readJson(path.join(NPCS_DIR, slug, 'aliases.json'), null);
  return v && Array.isArray(v.names) ? v.names.map((x) => String(x || '').trim()).filter(Boolean) : [];
}

export function saveAliases(slug, names) {
  const list = [...new Set((Array.isArray(names) ? names : []).map((x) => String(x || '').trim()).filter(Boolean))];
  const file = path.join(NPCS_DIR, slug, 'aliases.json');
  if (!list.length) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  } else {
    fs.writeFileSync(file, JSON.stringify({ names: list }, null, 2), 'utf8');
  }
  invalidateRegistry();
  return list;
}

/** 逐 NPC 共演开关：默认 false（文件缺失即关闭）。 */
export function loadCastFlag(slug) {
  const v = readJson(path.join(NPCS_DIR, slug, 'cast.json'), null);
  return { enabled: !!(v && v.enabled === true) };
}

export function saveCastFlag(slug, enabled) {
  const file = path.join(NPCS_DIR, slug, 'cast.json');
  if (!enabled) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  } else {
    fs.writeFileSync(file, JSON.stringify({ enabled: true }, null, 2), 'utf8');
  }
  invalidateRegistry();
  return { enabled: !!enabled };
}
