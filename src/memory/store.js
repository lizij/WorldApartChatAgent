/**
 * 按 NPC 隔离的记忆存储。每个 NPC 一个目录 + 一个稳定 session id：
 *
 * data/npcs/<slug>/
 *   ├─ state.json          # 机器状态：身份、变体、最近游戏状态、轮次、摘要水位
 *   ├─ memory.md           # 长期记忆（异步摘要器维护，回复前注入模型）
 *   ├─ prompt.json         # 玩家为该 NPC 设定的个人提示词（可选；回复前注入）
 *   ├─ conversations.jsonl # 完整对话流水（只追加）
 *   └─ intake/<日期>.md    # system 原文快照（首见 / 内容变化时）
 *
 * 同步 IO：单进程、低写入量，配合 KeyedQueue 已足够，且语义简单可靠。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';

export const NPCS_DIR = path.join(DATA_DIR, 'npcs');

export function sessionIdOf(slug) {
  return 'ses_' + crypto.createHash('sha256').update('npc:' + slug).digest('hex').slice(0, 24);
}

function npcDir(slug) {
  return path.join(NPCS_DIR, slug);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureNpc(slug) {
  const dir = npcDir(slug);
  fs.mkdirSync(path.join(dir, 'intake'), { recursive: true });
  return dir;
}

/** 载入（必要时初始化）NPC 状态。info 来自本轮识别结果。 */
export function openNpc(slug, info = {}) {
  const dir = ensureNpc(slug);
  const stateFile = path.join(dir, 'state.json');
  const memoryFile = path.join(dir, 'memory.md');
  const convFile = path.join(dir, 'conversations.jsonl');

  const now = new Date().toISOString();
  let state = readJson(stateFile, null);
  let isNew = false;
  if (!state) {
    isNew = true;
    state = {
      slug,
      sessionId: sessionIdOf(slug),
      rawNames: [],
      variants: [],
      unnamed: !!info.unnamed,
      firstSeen: now,
      lastSeen: now,
      turns: 0,
      lastSummaryTurn: 0,
      // 摘要窗口水位：conversations.jsonl 里已消费到第几条（非空行）。
      // 老档案没有这个字段 → 首次摘要沿用旧窗口，之后自动接管。
      lastSummaryLine: 0,
      systemHash: null,
      lastGame: null,
    };
  }
  if (info.rawName && !state.rawNames.includes(info.rawName)) state.rawNames.push(info.rawName);
  if (info.variant && !state.variants.includes(info.variant)) state.variants.push(info.variant);
  state.unnamed = state.unnamed || !!info.unnamed;
  state.lastSeen = now;
  if (info.state) state.lastGame = info.state;

  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(
      memoryFile,
      `# ${slug} · 长期记忆\n\n> 由外置记忆 Agent 自动维护；要点式、第三人称。暂无内容时保持本节为空。\n\n`,
      'utf8',
    );
  }

  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
  return { dir, stateFile, memoryFile, convFile, state, isNew };
}

/** system 原文快照：仅当内容哈希变化时存档（首见即存）。 */
export function snapshotSystem(slug, systemText, state) {
  if (!systemText) return false;
  const hash = crypto.createHash('sha256').update(systemText).digest('hex');
  if (state.systemHash === hash) return false;
  const d = new Date();
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(
    d.getMinutes(),
  ).padStart(2, '0')}.md`;
  const file = path.join(npcDir(slug), 'intake', name);
  fs.writeFileSync(
    file,
    `# 请求原文存档 · ${slug} · ${d.toISOString()}\n\n\`\`\`\n${systemText}\n\`\`\`\n`,
    'utf8',
  );
  state.systemHash = hash;
  return true;
}

export function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * 记忆分区（顺序固定）。这是「状态卡」的骨架：
 * 前两区是底座（不轻易裁剪），中间两区是编号故事行，最后三区是清单。
 */
export const MEMORY_SECTIONS = [
  '【身份与称呼】',
  '【关系】',
  '【经历与进度】',
  '【未了之事】',
  '【赠予往来】',
  '【习惯与忌讳】',
  '【同场】',
];

/**
 * 记忆分区裁剪顺序：超预算时从前往后处理（先整段丢，丢不划算就软裁剪该段）。
 * 先牺牲细节与大段进度，保住「她是谁、跟他什么关系、还欠着什么」。
 */
const SECTION_DROP_ORDER = [
  '【赠予往来】',
  '【同场】',
  '【习惯与忌讳】',
  '【经历与进度】',
  '【未了之事】',
  '【当前关系】',
  '【关系】',
  '【身份与称呼】',
];

/** 把记忆正文拆成「前导 + 各分区」；标题行必须是独占一行的【…】。 */
function splitMemorySections(body) {
  const out = [];
  let cur = { title: null, lines: [] };
  for (const line of String(body || '').split('\n')) {
    const m = /^【[^】]+】\s*$/.exec(line.trim());
    if (m) {
      out.push(cur);
      cur = { title: m[0], lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  out.push(cur);
  return out.filter((s) => s.title || s.lines.some((l) => l.trim()));
}

function renderMemorySections(sections) {
  return sections
    .map((s) => (s.title ? [s.title, ...s.lines].join('\n') : s.lines.join('\n')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 按分区优先级把记忆压到 maxChars 以内：
 * 低优先级分区先「整段丢」，丢不动（或丢它太浪费）就「软裁剪」它自己的正文，
 * 身份与关系永远最后才动；连底座都放不下时才退化为「保留开头 60% + 结尾 40%」。
 */
function trimMemorySections(body, maxChars) {
  const sections = splitMemorySections(body);
  const dropped = [];
  const clipped = [];
  const size = () => renderMemorySections(sections).length;
  if (size() <= maxChars) return body;

  for (const name of SECTION_DROP_ORDER) {
    if (size() <= maxChars) break;
    const idx = sections.findIndex((s) => s.title === name);
    if (idx < 0) continue;
    const sec = sections[idx];
    const over = size() - maxChars;
    const bodyLen = sec.lines.join('\n').trim().length;
    // 这一段的正文比「必须砍掉的量」还小 → 整段丢更划算；否则只砍正文尾部够用的部分
    if (bodyLen > over + 20) {
      if (clipSectionBody(sec, bodyLen - over - 20)) clipped.push(name);
    } else {
      sections.splice(idx, 1);
      dropped.push(name);
    }
  }

  let text = renderMemorySections(sections);
  const notes = [];
  if (dropped.length) notes.push(`本次未注入：${dropped.join('、')}`);
  if (clipped.length) notes.push(`已截短：${clipped.join('、')}`);
  if (notes.length) text += `\n（${notes.join('；')}）`;

  if (text.length <= maxChars) return text;

  // 底座本身超限：保留首尾，切在句末
  const mark = '\n……（中间内容已省略）\n';
  const budget = Math.max(100, maxChars - mark.length);
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  let h = text.slice(0, head);
  const k = Math.max(h.lastIndexOf('。'), h.lastIndexOf('\n'));
  if (k > head * 0.5) h = h.slice(0, k + 1);
  return h + mark + text.slice(text.length - tail);
}

/** 把某分区正文压到 maxBodyChars 以内（保留开头 60% + 结尾 40%，按行边界切）；返回是否有改动。 */
function clipSectionBody(section, maxBodyChars) {
  const bodyText = section.lines.join('\n').trim();
  if (bodyText.length <= maxBodyChars) return false;
  const mark = '…（中间略）…';
  const budget = Math.max(60, maxBodyChars - mark.length);
  const headLen = Math.floor(budget * 0.6);
  const tailLen = budget - headLen;
  let head = bodyText.slice(0, headLen);
  const nlH = head.lastIndexOf('\n');
  if (nlH > head.length * 0.5) head = head.slice(0, nlH);
  let tail = bodyText.slice(bodyText.length - tailLen);
  const nlT = tail.indexOf('\n');
  if (nlT >= 0 && nlT < tail.length * 0.5) tail = tail.slice(nlT + 1);
  section.lines = ['', head, mark, tail];
  return true;
}

/** 读长期记忆正文（去掉标题行），超预算时按分区优先级裁剪后注入。 */
export function loadMemory(memoryFile, maxChars) {
  let text;
  try {
    text = fs.readFileSync(memoryFile, 'utf8');
  } catch {
    return '';
  }
  const body = text
    .split('\n')
    .filter((l) => !/^#/.test(l.trim()) && !/^>/.test(l.trim()))
    .join('\n')
    .trim();
  if (!maxChars || body.length <= maxChars) return body;
  return trimMemorySections(body, maxChars);
}

export function writeMemory(memoryFile, slug, body) {
  const text = `# ${slug} · 长期记忆\n\n> 由外置记忆 Agent 自动维护；要点式、第三人称。\n\n${String(body).trim()}\n`;
  fs.writeFileSync(memoryFile, text, 'utf8');
}

/**
 * 按时间戳备份当前长期记忆：data/npcs/<slug>/backups/memory-YYYYMMDD-HHMMSS.md。
 * 用于「AI 修改记忆」保存前留底（玩家可手工回滚）。文件不存在时返回 null。
 * @returns {string|null} 相对 NPC 目录的备份路径，如 backups/memory-20261017-153012.md
 */
export function backupMemory(memoryFile, slug) {
  if (!fs.existsSync(memoryFile)) return null;
  const d = new Date();
  const name = `memory-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(
    d.getMinutes(),
  ).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}.md`;
  const dir = path.join(path.dirname(memoryFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(memoryFile, path.join(dir, name));
  return `backups/${name}`;
}

// —— 逐 NPC 外置设定提示词（玩家设定，独立于长期记忆）——
// data/npcs/<slug>/prompt.json = { useGlobal: boolean, text: string }
//   text      该 NPC 的个人提示词（为空表示不设个人提示）
//   useGlobal 是否在该 NPC 上叠加全局提示词（false = 仅用个人提示，可让某角色豁免全局）
// 兼容旧版 style.json：读取时回退；保存时写入 prompt.json 并删除旧文件。

export function npcPromptFile(slug) {
  return path.join(npcDir(slug), 'prompt.json');
}

function legacyNpcStyleFile(slug) {
  return path.join(npcDir(slug), 'style.json');
}

export const DEFAULT_NPC_PROMPT = { useGlobal: true, text: '' };

/** 读逐 NPC 提示词；文件缺失/损坏时回退默认（叠加全局、无个人文本）。 */
export function loadNpcPrompt(slug) {
  const v = readJson(npcPromptFile(slug), null) || readJson(legacyNpcStyleFile(slug), null);
  if (!v || typeof v !== 'object') return { ...DEFAULT_NPC_PROMPT };
  return { useGlobal: v.useGlobal !== false, text: typeof v.text === 'string' ? v.text : '' };
}

/** 写逐 NPC 提示词；处于默认态（无个人文本且叠加全局）时删除文件，保持目录干净。 */
export function saveNpcPrompt(slug, { useGlobal = true, text = '' } = {}) {
  const use = useGlobal !== false;
  const t = String(text || '').trim();
  try {
    fs.rmSync(legacyNpcStyleFile(slug), { force: true });
  } catch {}
  if (!t && use) {
    try {
      fs.rmSync(npcPromptFile(slug), { force: true });
    } catch {}
    return { ...DEFAULT_NPC_PROMPT };
  }
  const out = { useGlobal: use, text: t };
  fs.writeFileSync(npcPromptFile(slug), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/** 追加若干条对话记录（每条一个 JSON 对象）。 */
export function appendConversations(convFile, entries) {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.appendFileSync(convFile, lines + '\n', 'utf8');
}

/** 读最近 N 条对话记录（解析失败的行跳过）。 */
export function recentConversations(convFile, limit) {
  let lines = [];
  try {
    lines = fs.readFileSync(convFile, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
  const out = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/**
 * 按「行号水位」读未消费的对话：只取 lineOffset 之后、最多 maxEntries 条。
 * 解决 old：按「最近 N 条」取窗口会在每 everyTurns 轮重复喂同一段对话（重复摘要 → 流水账膨胀）。
 *
 * 行号按「非空行」计（对话记录都是单行 JSON，空行会被过滤），因此水位稳定、可持久化到 state.lastSummaryLine。
 * @returns {{entries: object[], consumed: number, totalLines: number}}
 */
export function conversationsAfter(convFile, lineOffset = 0, maxEntries = 0) {
  let lines = [];
  try {
    lines = fs
      .readFileSync(convFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
  } catch {
    return { entries: [], consumed: 0, totalLines: 0 };
  }
  const start = Math.max(0, Math.min(Number(lineOffset) || 0, lines.length));
  const rest = lines.slice(start);
  const slice = maxEntries > 0 ? rest.slice(0, maxEntries) : rest;
  const entries = [];
  for (const line of slice) {
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return { entries, consumed: slice.length, totalLines: lines.length };
}
