/**
 * 按 NPC 隔离的记忆存储。每个 NPC 一个目录 + 一个稳定 session id：
 *
 * data/npcs/<slug>/
 *   ├─ state.json          # 机器状态：身份、变体、最近游戏状态、轮次、摘要水位
 *   ├─ memory.md           # 长期记忆（异步摘要器维护，回复前注入模型）
 *   ├─ style.json          # 玩家为该 NPC 设定的对话风格（可选；回复前注入）
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

/** 读长期记忆正文（去掉标题行），按最大字符数截取最新部分。 */
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
  return '…（更早记忆已省略）\n' + body.slice(body.length - maxChars);
}

export function writeMemory(memoryFile, slug, body) {
  const text = `# ${slug} · 长期记忆\n\n> 由外置记忆 Agent 自动维护；要点式、第三人称。\n\n${String(body).trim()}\n`;
  fs.writeFileSync(memoryFile, text, 'utf8');
}

// —— 逐 NPC 对话风格（玩家设定，独立于长期记忆）——
// data/npcs/<slug>/style.json = { useGlobal: boolean, text: string }
//   text      该 NPC 的专属风格提示词（为空表示不设专属风格）
//   useGlobal 是否在该 NPC 上叠加全局风格提示（false = 仅用专属提示，可用来让某角色豁免全局）

export function npcStyleFile(slug) {
  return path.join(npcDir(slug), 'style.json');
}

export const DEFAULT_NPC_STYLE = { useGlobal: true, text: '' };

/** 读逐 NPC 对话风格；文件缺失/损坏时回退默认（叠加全局、无专属文本）。 */
export function loadNpcStyle(slug) {
  const v = readJson(npcStyleFile(slug), null);
  if (!v || typeof v !== 'object') return { ...DEFAULT_NPC_STYLE };
  return { useGlobal: v.useGlobal !== false, text: typeof v.text === 'string' ? v.text : '' };
}

/** 写逐 NPC 对话风格；处于默认态（无专属文本且叠加全局）时删除文件，保持目录干净。 */
export function saveNpcStyle(slug, { useGlobal = true, text = '' } = {}) {
  const use = useGlobal !== false;
  const t = String(text || '').trim();
  if (!t && use) {
    try {
      fs.rmSync(npcStyleFile(slug), { force: true });
    } catch {}
    return { ...DEFAULT_NPC_STYLE };
  }
  const out = { useGlobal: use, text: t };
  fs.writeFileSync(npcStyleFile(slug), JSON.stringify(out, null, 2), 'utf8');
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
