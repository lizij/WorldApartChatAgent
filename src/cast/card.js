/**
 * 配角角色卡：从 data/npcs/<slug>/intake/*.md 抽取「身份 / 背景 / 说话习惯 / 性格 / 世界规则」，
 * 纯正则 + 截断，不调用模型。按 intake 文件的 mtime 缓存，避免每轮重复读盘与解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NPCS_DIR } from '../memory/store.js';

const CARD_TTL_MS = 60000;
const cache = new Map(); // slug -> { at, file, card }

function latestIntake(slug) {
  const dir = path.join(NPCS_DIR, slug, 'intake');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return null;
  }
  if (!names.length) return null;
  let best = null;
  for (const n of names) {
    const file = path.join(dir, n);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
  }
  return best ? best.file : null;
}

/** 把 markdown 里的 `## 标题` 拆成 map（去 CRLF，保留正文原样）。 */
export function sectionsOf(text) {
  const out = {};
  const norm = String(text || '').replace(/\r\n/g, '\n');
  const re = /^##[ \t]*(.+?)[ \t]*\n([\s\S]*?)(?=^##[ \t]|$)/gm;
  let m;
  while ((m = re.exec(norm))) {
    const title = m[1].trim();
    if (!title) continue;
    if (out[title] == null) out[title] = m[2].trim();
  }
  return out;
}

function firstSentence(text, max = 80) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^(.{1,120}?)[。！？!?]/);
  return (m ? m[1] : s).slice(0, max);
}

function trim(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max * 0.6 ? cut.slice(0, nl) : cut).trim() + '…';
}

function attrLines(attr, keys) {
  const out = [];
  for (const line of String(attr || '').split('\n')) {
    const t = line.replace(/^[-*\s]+/, '').trim();
    if (!t) continue;
    if (keys.some((k) => t.startsWith(`**${k}**`) || t.startsWith(`${k}：`) || t.startsWith(`${k}:`))) {
      out.push(t.replace(/^\*\*|\*\*$/g, ''));
    }
  }
  return out;
}

/**
 * 构造配角角色卡。
 * @returns {null|{slug:string,name:string,identity:string,background:string,speech:string,personality:string,world:string,sourceFile:string,chars:number}}
 */
export function buildCard(slug) {
  const file = latestIntake(slug);
  if (!file) return null;
  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && hit.file === file && now - hit.at < CARD_TTL_MS) return hit.card;

  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const s = sectionsOf(raw);
  const fullName = String(s['角色设定'] || '')
    .replace(/^你是[ \t]*/, '')
    .trim()
    .slice(0, 40);
  const background = String(s['角色背景'] || '').trim();
  const speech = String(s['说话习惯'] || '').trim();
  const attr = String(s['角色属性'] || '').trim();

  const personality = attrLines(attr, ['性格', '善恶']).join('；');
  const world = [trim(s['守住世界观'], 320), trim(s['通用要求'], 420)].filter(Boolean).join('\n');

  const card = {
    slug,
    // 对玩家展示与台词前缀一律用 slug（已剥掉 mod 前缀/品阶/括号），
    // 完整全名只保留在 fullName 里供排查。
    name: slug,
    fullName: fullName || slug,
    identity: firstSentence(background, 60),
    background: trim(background, 220),
    speech: trim(speech, 260),
    personality: trim(personality, 180),
    world,
    sourceFile: path.basename(file),
    chars:
      slug.length +
      trim(background, 220).length +
      trim(speech, 260).length +
      trim(personality, 180).length +
      world.length,
  };
  cache.set(slug, { at: now, file, card });
  return card;
}

export function invalidateCards(slug) {
  if (slug) cache.delete(slug);
  else cache.clear();
}

/** A 是否认识 B：在 A 的当轮 system + 长期记忆里找 B 的名字/别名。 */
export function isKnownBy({ names, systemText, memoryText }) {
  const hay = String(systemText || '') + '\n' + String(memoryText || '');
  if (!hay.trim()) return false;
  return (Array.isArray(names) ? names : []).some((n) => n && hay.includes(n));
}

/** 角色卡渲染成 prompt 片段；`rendered` 非空时表示已被请求重写替换。 */
export function renderCard(card) {
  if (!card) return '';
  if (card.rendered) return card.rendered;
  const lines = [`姓名：${card.name}`];
  if (card.identity) lines.push(`身份：${card.identity}`);
  if (card.background) lines.push(`背景：${card.background}`);
  if (card.speech) lines.push(`说话习惯：${card.speech}`);
  if (card.personality) lines.push(`性格：${card.personality}`);
  return lines.join('\n');
}
