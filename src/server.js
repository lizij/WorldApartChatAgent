/**
 * HTTP 服务（单端口）：
 *  - 游戏侧（需 API Key）：POST /v1/chat/completions、GET /v1/models
 *  - 管理页（仅本机，随桌面窗口使用）：/、/api/*
 *
 * NPC 对话编排：识别身份 → 按 NPC 取档注入 → 真流式转发 → 旁路落盘 → 异步摘要。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_DIR,
  IS_TEST,
  PUBLIC_DIR,
  VERSION,
  REWRITE_CACHE_MODES,
  upstreamChatUrl,
  effectiveMemoryChars,
  effectiveInjectChars,
} from './config.js';
import { classify, isFactModule, mergePendingFacts } from './identify.js';
import {
  openNpc,
  snapshotSystem,
  saveState,
  appendConversations,
  sessionIdOf,
  loadNpcPrompt,
  saveNpcPrompt,
  backupMemory,
  writeMemory,
  loadMemory,
  recentConversations,
  NPCS_DIR,
} from './memory/store.js';
import { buildMemoryText, buildPromptsText, insertBeforeLastUser } from './memory/inject.js';
import { Summarizer } from './memory/summarizer.js';
import { MemoryRewriter } from './memory/rewriter.js';
import { RequestRewriter, wrapPlainReply } from './requestRewrite.js';
import { IdleFlusher } from './memory/idleFlusher.js';
import { forwardUpstream, messageText, sendJsonError, tokenUsage } from './upstream.js';
import { repairNpcReplyText } from './replyRepair.js';
import { KeyedQueue } from './locks.js';
import { planCast } from './cast/plan.js';
import { buildActorMessages, callActor, sanitizeActorText } from './cast/actor.js';
import { renderCard } from './cast/card.js';
import { ContentInjector } from './cast/merge.js';
import { loadStage, saveStage } from './cast/stage.js';
import { entryOf, loadAliases, saveAliases, saveCastFlag } from './cast/registry.js';
import {
  speak,
  synthesize,
  synthesizeKokoro,
  listVoices,
  resolveVoice,
  readVoice,
  saveVoice,
  isVoiceEnabled,
  reset as ttsReset,
  shutdown as ttsShutdown,
  installKokoro,
  kokoroStatus,
  isKokoroInstalled,
  KOKORO_VOICES,
  ENGINE_IDS,
  activeEngine,
} from './tts/index.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 外置提示词字数上限（全局与逐 NPC 同一上限；防止误粘贴超长文本挤占 token）。 */
const PROMPT_MAX_CHARS = 4000;

/** 「AI 修改记忆」一次性指令上限（字）。 */
const MEMORY_EDIT_MAX_CHARS = 4000;

/** 手工保存记忆正文的上限（字）；防止误粘贴超长文本。 */
const MEMORY_TEXT_MAX_CHARS = 200000;

/**
 * 输出格式强化提醒（注入与日志来源标注共用同一常量）。
 *
 * 只强调「唯一一个 JSON 对象」这条技术契约；content 里要不要写动作/旁白，
 * 由本轮 `## 输出格式` 的字段说明与外置设定决定——2026-11 游戏更新后
 * 该契约改成了「content 只写台词，不写括号旁白」，不能再硬编码成相反要求。
 */
const FORMAT_REMINDER =
  '再次提醒：本轮必须且只能输出系统要求的那个 JSON 对象（不要 JSON 代码围栏、不要解释、不要输出 JSON 之外的文字）。' +
  'content 写你本人的台词；动作、表情、旁白是否写入 content，以本轮「## 输出格式」的字段说明与外置设定为准。' +
  '不要写成多说话人剧本，也不要替在场其他角色写「名字：台词」。' +
  '输出前自检：整条回复必须以「{」开头、以「}」结尾；只写台词正文而不写 JSON 外壳，游戏将无法读取。';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('请求体过大');
        err.code = 'payload_too_large';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function prepareUpstreamBody(body, cfg) {
  const out = { ...body, model: cfg.upstream.model };
  if (cfg.upstream.disableThinking && out.thinking === undefined) {
    out.thinking = { type: 'disabled' };
  }
  // 可选：让上游在流式响应末尾额外返回 usage（默认关闭，避免影响游戏端解析）。
  if (cfg.upstream.includeUsage && out.stream) {
    const so =
      out.stream_options && typeof out.stream_options === 'object' ? out.stream_options : {};
    out.stream_options = { ...so, include_usage: true };
  }
  return out;
}

/** 日志详情里记录的请求参数（不含密钥）。 */
function requestMeta(body) {
  return {
    model: body?.model || null,
    stream: !!body?.stream,
    temperature: body?.temperature ?? null,
    max_tokens: body?.max_tokens ?? null,
    thinking: body?.thinking ?? null,
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    includeUsage: !!body?.stream_options?.include_usage,
  };
}

/** 给最终 messages 标来源，便于在日志里看清哪些内容来自记忆/风格/格式提醒。 */
function buildDetailMessages(messages, injected) {
  const list = Array.isArray(messages) ? messages : [];
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  return list.map((m, i) => {
    const content = messageText(m);
    let origin = 'game';
    if (injected && injected.has(content)) origin = injected.get(content);
    else if (m?.role === 'user') origin = i === lastUser ? 'player' : 'history';
    else if (m?.role === 'assistant') origin = 'history';
    else if (m?.role === 'system') origin = 'game';
    else if (m?.role) origin = 'other';
    return { role: m?.role || 'unknown', origin, content, chars: content.length };
  });
}

/**
 * 收集需要请求重写的纯文本 system 模块（此时尚未注入外置内容）。
 * 真实游戏会把设定拆成多条 system 消息，甚至与历史消息交错，因此必须逐条处理。
 *
 * 2026-11 游戏更新后，请求里还混有【相关经历】【人物关系】【任务接取】【任务交付】
 * 【好感变化】【交情变化】【赠出礼物】【结交】等**已结算事实**模块。它们不是表演规则，
 * 不能被外置设定删改（否则摘要器与游戏结算事实会自相矛盾），一律原样透传。
 *
 * 事实模块整条透传的前提是它只有事实块。若某天游戏把事实块与 `## 设定` 标题合并进同一条，
 * 这里仍按事实模块透传（宁可少改也不改错事实），但会把它记进 mixed 让日志发出告警，
 * 以便及时改成分段处理。
 * @returns {{systems:Array<{index:number,content:string}>, skipped:number[], mixed:number[]}}
 */
function collectGameSystemMessages(messages) {
  const out = [];
  const skipped = [];
  const mixed = [];
  if (!Array.isArray(messages)) return { systems: out, skipped, mixed };
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || m.role !== 'system' || typeof m.content !== 'string') continue;
    if (!m.content.trim()) continue;
    if (isFactModule(m.content)) {
      skipped.push(i);
      // 含 `## ` 标题说明这条里还混着设定模块，透传会让那部分设定失去改写机会
      if (/^[ \t]*##[ \t]/m.test(m.content)) mixed.push(i);
      continue;
    }
    out.push({ index: i, content: m.content });
  }
  return { systems: out, skipped, mixed };
}

function tokenFields(tokens) {
  return tokens ? { tokens } : {};
}

function detailTiming(result) {
  return {
    ttftMs: result?.ttftMs ?? null,
    reasoningTtftMs: result?.reasoningTtftMs ?? null,
    contentTtftMs: result?.contentTtftMs ?? null,
    durationMs: result?.durationMs ?? null,
  };
}

function parseNpcReply(text) {
  const out = { content: text, emotion: null, control: null, giftItem: null, jsonOk: false };
  if (!text) return out;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      out.content = typeof j.content === 'string' ? j.content : text;
      out.emotion = j.emotion || null;
      out.control = j.control || null;
      out.giftItem = j.intent?.gift_item ?? null;
      out.jsonOk = true;
    }
  } catch {}
  return out;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 剥掉 A 正文里替在场配角写的台词行（行首或括号动作后紧跟「B：」）。
 * A 本不该代演 B；这类行会和系统插入的 B 台词重复，也会把 A 的历史带成多说话人剧本。
 * 剥完为空时保留原文，避免整轮回复被清空。
 * @returns {{text:string, stripped:boolean}}
 */
function stripCostarSpeech(raw, bName) {
  const name = String(bName || '').trim();
  if (!name) return { text: raw, stripped: false };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  const target =
    parsed && typeof parsed === 'object' && typeof parsed.content === 'string' ? parsed.content : raw;
  const lines = String(target).split(/\r?\n/);
  const re = new RegExp(`^\\s*(?:（[^（）]*）\\s*)*${escapeRegExp(name)}[：:]`);
  const kept = lines.filter((l) => !re.test(l));
  if (kept.length === lines.length) return { text: raw, stripped: false };
  const next = kept.join('\n');
  // 整段都是 B 的台词时无法安全清空（游戏会收到空 content），保留原文但记账。
  if (!next.trim()) return { text: raw, stripped: true };
  if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
    return { text: JSON.stringify({ ...parsed, content: next }), stripped: true };
  }
  return { text: next, stripped: true };
}

function turnIdOf() {
  return 't-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
}

/** 只读 NPC 的 state.json（不写盘，供共演预规划使用）。 */
function readStateOf(slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(NPCS_DIR, slug, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 把一条对话记录渲染成 `[说话人] 内容`（共演条目按 segments 逐句）。 */
function renderConvEntry(e, selfSlug) {
  if (e && Array.isArray(e.segments) && e.segments.length) {
    return e.segments.map((s) => `[${s.who || selfSlug}] ${s.text ?? ''}`).join('\n');
  }
  const who = e?.speaker || (e?.role === 'player' ? '玩家' : selfSlug);
  return `[${who}] ${e?.content ?? ''}`;
}

function transcriptOf(convFile, limit, selfSlug) {
  return recentConversations(convFile, limit).map((e) => renderConvEntry(e, selfSlug)).join('\n');
}

/** A 侧「本场现场」块。 */
function buildCastBlock({ coStar, known, addressedB, outputStyle, aName }) {
  const b = coStar.name;
  const knownLine = known
    ? `${b}你认得（你自己的记忆里提到过她）：${coStar.card.identity || '你记得这个人'}。`
    : `${b}这个人你没见过，也没听人提过；她此刻却站在这里。`;
  const lines = [
    '【本场现场】',
    knownLine,
    '玩家括号里的动作与场景已经发生，你当场承接；括号里点名谁，谁就是本轮主要回应者。',
  ];
  if (addressedB) {
    lines.push(
      `本轮玩家转向${b}说话。你不必替她回答，也不必复述玩家对她说的内容；`,
      '你可以只给一个在旁的动作或半句话，也可以自己也插一句，或者不接话。',
    );
  } else {
    lines.push(
      `本轮玩家主要对你说话。${b}在场，若她的动作或台词需要你回应，你可以自然接一句。`,
    );
  }
  lines.push('', '【写法】');
  if (outputStyle === 'script') {
    lines.push(
      `你只写你自己的台词：以「${aName}：」开头另起一行，动作用括号写在自己那句里。`,
    );
  } else {
    lines.push('你只写你自己的台词与动作，不要替她写。');
  }
  lines.push(
    `${b}的台词由她本人应答，你不要替她写，也不要给她留“台词位”。`,
    `历史回复里若出现「${b}：…」这类句子，那是系统插入的她的公开台词，不是你的发言；不要模仿这种多说话人写法。`,
    '你输出的 content 里只能出现你自己的台词；不要以其他人的名字开头另起一行。',
    '她不替玩家行动，也不替你决定；她不知道你私下的事。',
    '可写 1~3 句，每句不超过 60 字；回应到点就停。',
    `emotion、control 与 intent 只描述你自己（${aName}）。`,
  );
  return lines.join('\n');
}

/** A 侧观测块：B 先说话时追加，只给公开输出。 */
function buildObservationBlock({ coStar, line }) {
  return [
    '【你刚才看到的】',
    `${coStar.name}先开了口（她的原话，不是你的口吻）：`,
    line,
    '你看到了这些，但不知道她心里怎么想。',
  ].join('\n');
}

/** 替换最后一条 user 消息的内容（共演指令剥离后使用）。 */
function replaceLastUser(messages, content) {
  const out = Array.isArray(messages) ? messages.slice() : [];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i]?.role === 'user') {
      out[i] = { ...out[i], content };
      break;
    }
  }
  return out;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  // 用 PUBLIC_DIR + 分隔符 判断，避免 publicX/ 这类同前缀兄弟目录被误放行
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    sendJsonError(res, 403, 'forbidden', '禁止访问');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // 前端单页回退到 index.html（仅对无扩展名路径）
      if (!path.extname(rel)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
          if (e2) return sendJsonError(res, 404, 'not_found', '页面不存在');
          res.setHeader('content-type', MIME['.html']);
          res.end(idx);
        });
        return;
      }
      sendJsonError(res, 404, 'not_found', '资源不存在');
      return;
    }
    res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    // 管理页是本地单页应用：脚本/样式不做强缓存，避免升级后仍用旧 app.js
    if (/\.(?:html|js|css)$/i.test(file)) res.setHeader('cache-control', 'no-cache');
    res.end(buf);
  });
}

function maskKey(k) {
  const s = String(k || '');
  return s.length <= 10 ? '***' : s.slice(0, 4) + '****' + s.slice(-4);
}

/** 管理页传入的数值归一化：非法值(NaN/字符串)一律忽略，合法值按范围夹取。 */
function intIn(v, min, max) {
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function strIn(v, maxLen) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.slice(0, maxLen);
}

export function createServer({ config, logger, getPortFallback = null }) {
  const queues = new KeyedQueue();
  // 同一进程内可能再次创建服务（测试 / 重启）：复位上一轮 shutdown 留下的停止标志
  ttsReset();
  const summarizer = new Summarizer({ config, logger, queue: queues });
  const rewriter = new MemoryRewriter({ config, queue: queues });
  const requestRewriter = new RequestRewriter({ config });
  const idleFlusher = new IdleFlusher({ config, logger, summarizer });

  function cfg() {
    return config.get();
  }

  /** 解析并校验 NPC slug → 目录；非法转义/越界/不存在时已回 404，返回 null。 */
  function resolveNpcDir(res, slugRaw) {
    let slug;
    try {
      slug = decodeURIComponent(slugRaw);
    } catch {
      sendJsonError(res, 404, 'not_found', 'NPC 不存在');
      return null;
    }
    const dir = path.join(NPCS_DIR, slug);
    if (!dir.startsWith(NPCS_DIR + path.sep) || !fs.existsSync(dir)) {
      sendJsonError(res, 404, 'not_found', 'NPC 不存在');
      return null;
    }
    return { slug, dir };
  }

  function authed(req) {
    const key = cfg().server.apiKey;
    if (!key) return true;
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers['authorization'] || ''));
    const provided = m ? m[1].trim() : String(req.headers['x-api-key'] || '');
    return !!provided && timingSafeEqualStr(provided, key);
  }

  // —— 管理 API ——

  function handleStatus(req, res) {
    const c = cfg();
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        ok: true,
        version: VERSION,
        service: 'worldapart-npc-agent',
        isTest: IS_TEST,
        dataDir: DATA_DIR,
        baseUrl: `http://${c.server.host}:${c.server.port}/v1`,
        port: c.server.port,
        // 本次启动是否因端口被占用而自动顺延（null = 未发生）；用于管理页区分“自动换过”和“玩家自己改的端口”
        portFallback: typeof getPortFallback === 'function' ? getPortFallback() : null,
        apiKey: c.server.apiKey,
        servedModel: c.server.servedModel,
        upstream: {
          baseUrl: c.upstream.baseUrl,
          model: c.upstream.model,
          hasApiKey: !!c.upstream.apiKey,
          disableThinking: !!c.upstream.disableThinking,
          includeUsage: !!c.upstream.includeUsage,
        },
        memory: c.memory,
        prompts: { enabled: !!c.prompts.enabled, hasGlobal: !!(c.prompts.global || '').trim() },
        requestRewrite: { enabled: !!c.requestRewrite.enabled },
        multiNpc: {
          enabled: !!c.multiNpc.enabled,
          maxCoStars: c.multiNpc.maxCoStars,
          maxCallsPerTurn: c.multiNpc.maxCallsPerTurn,
          outputStyle: c.multiNpc.outputStyle,
        },
        // 只给开关与参数，语音清单另走 /api/tts/voices（枚举要起一次 PowerShell）
        tts: {
          enabled: !!c.tts.enabled,
          engine: c.tts.engine === 'kokoro' ? 'kokoro' : 'windows',
          // 实际生效的引擎（kokoro 未安装会自动降到 windows）
          activeEngine: activeEngine(c),
          kokoroInstalled: isKokoroInstalled(),
          readMode: c.tts.readMode,
          skipActions: !!c.tts.skipActions,
          defaultGender: c.tts.defaultGender,
        },
      }),
    );
  }

  function handleGetConfig(req, res) {
    const c = cfg();
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        server: { host: c.server.host, port: c.server.port, apiKey: c.server.apiKey, servedModel: c.server.servedModel },
        upstream: {
          ...c.upstream,
          apiKey: c.upstream.apiKey ? maskKey(c.upstream.apiKey) : '',
          apiKeySet: !!c.upstream.apiKey,
        },
        memory: c.memory,
        prompts: { enabled: !!c.prompts.enabled, global: c.prompts.global || '' },
        requestRewrite: c.requestRewrite,
        multiNpc: c.multiNpc,
        tts: c.tts,
        log: c.log,
        // 派生上限：maxMemoryChars 受 maxTokens 物理约束，供管理页做交叉校验提示
        limits: {
          memoryEffectiveChars: effectiveMemoryChars(c),
          injectEffectiveChars: effectiveInjectChars(c),
        },
      }),
    );
  }

  async function handlePutConfig(req, res) {
    let patch;
    try {
      patch = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return sendJsonError(res, 400, 'bad_request', '配置不是合法 JSON');
    }
    const safe = {};
    if (patch.server) {
      safe.server = {};
      const sm = strIn(patch.server.servedModel, 200);
      if (sm) safe.server.servedModel = sm;
      // 明确传入的新 Key 才更新；空/掩码值忽略
      if (
        typeof patch.server.apiKey === 'string' &&
        patch.server.apiKey.startsWith('wfc-') &&
        patch.server.apiKey.length > 12
      ) {
        safe.server.apiKey = patch.server.apiKey;
      }
    }
    if (patch.upstream) {
      safe.upstream = {};
      const baseUrl = strIn(patch.upstream.baseUrl, 500);
      if (baseUrl) safe.upstream.baseUrl = baseUrl;
      const model = strIn(patch.upstream.model, 200);
      if (model) safe.upstream.model = model;
      if (patch.upstream.insecureTLS !== undefined) safe.upstream.insecureTLS = !!patch.upstream.insecureTLS;      if (patch.upstream.disableThinking !== undefined) safe.upstream.disableThinking = !!patch.upstream.disableThinking;
      if (patch.upstream.includeUsage !== undefined) safe.upstream.includeUsage = !!patch.upstream.includeUsage;
      const ct = intIn(patch.upstream.connectTimeoutMs, 1000, 600000);
      if (ct !== undefined) safe.upstream.connectTimeoutMs = ct;
      const rt = intIn(patch.upstream.requestTimeoutMs, 1000, 3600000);
      if (rt !== undefined) safe.upstream.requestTimeoutMs = rt;
      if (
        typeof patch.upstream.apiKey === 'string' &&
        patch.upstream.apiKey.trim() &&
        !patch.upstream.apiKey.includes('****')
      ) {
        safe.upstream.apiKey = patch.upstream.apiKey.trim();
      }
    }
    if (patch.memory) {
      safe.memory = {};
      if (patch.memory.enabled !== undefined) safe.memory.enabled = !!patch.memory.enabled;
      if (patch.memory.snapshotSystem !== undefined) safe.memory.snapshotSystem = !!patch.memory.snapshotSystem;
      const imc = intIn(patch.memory.injectMaxChars, 0, 200000);
      if (imc !== undefined) safe.memory.injectMaxChars = imc;
      if (patch.memory.summarizer) {
        safe.memory.summarizer = {};
        const s = patch.memory.summarizer;
        if (s.enabled !== undefined) safe.memory.summarizer.enabled = !!s.enabled;
        const every = intIn(s.everyTurns, 1, 100);
        if (every !== undefined) safe.memory.summarizer.everyTurns = every;
        const recent = intIn(s.recentEntries, 1, 1000);
        if (recent !== undefined) safe.memory.summarizer.recentEntries = recent;
        const mmc = intIn(s.maxMemoryChars, 100, 20000);
        if (mmc !== undefined) safe.memory.summarizer.maxMemoryChars = mmc;
        const mt = intIn(s.maxTokens, 50, 32000);
        if (mt !== undefined) safe.memory.summarizer.maxTokens = mt;
        const to = intIn(s.timeoutMs, 1000, 600000);
        if (to !== undefined) safe.memory.summarizer.timeoutMs = to;
        // 超限重试次数（0~3）
        if (s.overLimitRetries !== undefined) {
          const olr = intIn(s.overLimitRetries, 0, 3);
          if (olr !== undefined) safe.memory.summarizer.overLimitRetries = olr;
        }
        // 空闲兜底（解决尾部轮次/短会话永不进记忆）
        if (s.idleFlushEnabled !== undefined) safe.memory.summarizer.idleFlushEnabled = !!s.idleFlushEnabled;
        const ifm = intIn(s.idleFlushMs, 1000, 86400000);
        if (ifm !== undefined) safe.memory.summarizer.idleFlushMs = ifm;
      }
    }
    // 外置设定提示词；旧版管理页仍传 style 时按别名处理（prompts 优先）
    if (patch.prompts || patch.style) {
      const src = patch.prompts && typeof patch.prompts === 'object' ? patch.prompts : patch.style;
      safe.prompts = {};
      if (src.enabled !== undefined) safe.prompts.enabled = !!src.enabled;
      // 允许空字符串（= 清空全局提示词），故不用 strIn（strIn 会把空值当未提供）
      if (typeof src.global === 'string') {
        if (src.global.length > PROMPT_MAX_CHARS) {
          return sendJsonError(res, 400, 'bad_request', `全局提示词过长（上限 ${PROMPT_MAX_CHARS} 字）`);
        }
        safe.prompts.global = src.global;
      }
    }
    // 请求重写（实验性）
    if (patch.requestRewrite && typeof patch.requestRewrite === 'object') {
      safe.requestRewrite = {};
      const rw = patch.requestRewrite;
      if (rw.enabled !== undefined) safe.requestRewrite.enabled = !!rw.enabled;
      const mt = intIn(rw.maxTokens, 500, 32000);
      if (mt !== undefined) safe.requestRewrite.maxTokens = mt;
      const to = intIn(rw.timeoutMs, 1000, 600000);
      if (to !== undefined) safe.requestRewrite.timeoutMs = to;
      const temp = Number(rw.temperature);
      if (Number.isFinite(temp)) safe.requestRewrite.temperature = Math.min(Math.max(temp, 0), 2);
      if (rw.cache && typeof rw.cache === 'object') {
        safe.requestRewrite.cache = {};
        let mode;
        if (typeof rw.cache.mode === 'string') {
          mode = rw.cache.mode.trim();
          if (!REWRITE_CACHE_MODES.includes(mode)) {
            return sendJsonError(res, 400, 'bad_request', `未知的重写缓存机制: ${mode}`);
          }
        } else if (rw.cache.enabled !== undefined) {
          // 兼容 0.12.x 的布尔开关
          mode = rw.cache.enabled ? 'exact' : 'none';
        }
        if (mode) safe.requestRewrite.cache.mode = mode;
        const me = intIn(rw.cache.maxEntries, 1, 100);
        if (me !== undefined) safe.requestRewrite.cache.maxEntries = me;
        const ttl = intIn(rw.cache.ttlDays, 0, 3650);
        if (ttl !== undefined) safe.requestRewrite.cache.ttlDays = ttl;
      }
    }
    // 多 NPC 共演（实验性）
    if (patch.multiNpc && typeof patch.multiNpc === 'object') {
      safe.multiNpc = {};
      const m = patch.multiNpc;
      if (m.enabled !== undefined) safe.multiNpc.enabled = !!m.enabled;
      const co = intIn(m.maxCoStars, 1, 2);
      if (co !== undefined) safe.multiNpc.maxCoStars = co;
      const calls = intIn(m.maxCallsPerTurn, 1, 2);
      if (calls !== undefined) safe.multiNpc.maxCallsPerTurn = calls;
      if (m.speakPolicy === 'addressed' || m.speakPolicy === 'always') safe.multiNpc.speakPolicy = m.speakPolicy;
      if (m.outputStyle === 'script' || m.outputStyle === 'inherit') safe.multiNpc.outputStyle = m.outputStyle;
      for (const k of ['allowASilence', 'coStarWritesMemory', 'skipOnTask', 'autoStage']) {
        if (m[k] !== undefined) safe.multiNpc[k] = !!m[k];
      }
      const tt = intIn(m.transcriptTurns, 1, 40);
      if (tt !== undefined) safe.multiNpc.transcriptTurns = tt;
      const idle = intIn(m.autoExitIdleMs, 1000, 86400000);
      if (idle !== undefined) safe.multiNpc.autoExitIdleMs = idle;
      const tw = intIn(m.actorTailWaitMs, 500, 10000);
      if (tw !== undefined) safe.multiNpc.actorTailWaitMs = tw;
      const amt = intIn(m.actorMaxTokens, 80, 4000);
      if (amt !== undefined) safe.multiNpc.actorMaxTokens = amt;
      const ato = intIn(m.actorTimeoutMs, 1000, 600000);
      if (ato !== undefined) safe.multiNpc.actorTimeoutMs = ato;
    }
    // 语音朗读（TTS）
    if (patch.tts && typeof patch.tts === 'object') {
      safe.tts = {};
      const t = patch.tts;
      for (const k of ['enabled', 'skipActions']) {
        if (t[k] !== undefined) safe.tts[k] = !!t[k];
      }
      // 只有装了 Kokoro 才允许切过去，否则保持 windows（避免存一个用不了的引擎）
      if (t.engine !== undefined) {
        if (!ENGINE_IDS.includes(t.engine)) {
          return sendJsonError(res, 400, 'bad_request', `未知的语音引擎: ${t.engine}`);
        }
        if (t.engine === 'kokoro' && !isKokoroInstalled()) {
          return sendJsonError(res, 400, 'engine_not_installed', 'Kokoro 引擎尚未安装，请先在「实验功能」里下载');
        }
        safe.tts.engine = t.engine;
      }
      if (t.readMode === 'all' || t.readMode === 'dialogue') safe.tts.readMode = t.readMode;
      if (t.defaultGender === 'male' || t.defaultGender === 'female') safe.tts.defaultGender = t.defaultGender;
      // 语音名：空串视为"回到默认"，仍按字符串收下（前端可能清空下拉）
      if (t.voices && typeof t.voices === 'object') {
        safe.tts.voices = {};
        for (const g of ['male', 'female']) {
          if (typeof t.voices[g] === 'string') safe.tts.voices[g] = t.voices[g].trim().slice(0, 200);
        }
      }
      // Kokoro 音色（只接受清单里的名字）
      if (t.kokoro && typeof t.kokoro === 'object') {
        safe.tts.kokoro = {};
        const valid = new Set(KOKORO_VOICES.map((v) => v.name));
        for (const k of ['voiceFemale', 'voiceMale']) {
          if (typeof t.kokoro[k] === 'string') {
            const v = t.kokoro[k].trim();
            if (v && !valid.has(v)) return sendJsonError(res, 400, 'bad_request', `未知的 Kokoro 音色: ${v}`);
            if (v) safe.tts.kokoro[k] = v;
          }
        }
        const th = intIn(t.kokoro.threads, 1, 8);
        if (th !== undefined) safe.tts.kokoro.threads = th;
      }
      // 注意：volume/rate/pitch 都是小数，不能用 intIn（Math.floor 会把 0.8 压成 0）
      const clampFloat = (v, min, max) => {
        if (v === undefined || v === null || v === '' || typeof v === 'boolean') return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) return undefined;
        return Math.round(Math.min(Math.max(n, min), max) * 100) / 100;
      };
      const mc = intIn(t.maxChars, 50, 5000);
      if (mc !== undefined) safe.tts.maxChars = mc;
      const vol = clampFloat(t.volume, 0, 1);
      if (vol !== undefined) safe.tts.volume = vol;
      const rate = clampFloat(t.rate, 0.5, 3);
      if (rate !== undefined) safe.tts.rate = rate;
      const pitch = clampFloat(t.pitch, 0.5, 2);
      if (pitch !== undefined) safe.tts.pitch = pitch;
    }
    config.update(safe);
    logger.append({ kind: 'config', status: 'updated' });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
  }

  function handleNpcList(req, res) {
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(NPCS_DIR, { withFileTypes: true });
    } catch {
      names = [];
    }
    for (const ent of names) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(NPCS_DIR, ent.name);
      let state = null;
      try {
        state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      } catch {}
      let convCount = 0;
      try {
        convCount = fs.readFileSync(path.join(dir, 'conversations.jsonl'), 'utf8').split('\n').filter(Boolean).length;
      } catch {}
      let memoryChars = 0;
      try {
        memoryChars = fs.statSync(path.join(dir, 'memory.md')).size;
      } catch {}
      const prompt = loadNpcPrompt(ent.name);
      const reg = entryOf(ent.name);
      out.push({
        slug: ent.name,
        rawNames: state?.rawNames || [],
        variants: state?.variants || [],
        turns: state?.turns || 0,
        firstSeen: state?.firstSeen || null,
        lastSeen: state?.lastSeen || null,
        lastGame: state?.lastGame || null,
        conversationEntries: convCount,
        memoryBytes: memoryChars,
        promptChars: prompt.text.trim().length,
        promptUsesGlobal: prompt.useGlobal,
        aliases: loadAliases(ent.name),
        hasIntake: !!reg?.hasIntake,
        castEnabled: !!reg?.castEnabled,
        voiceEnabled: readVoice(ent.name).enabled,
      });
    }
    out.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ npcs: out }));
  }

  async function handleNpcDetail(req, res, slugRaw) {
    let slug;
    try {
      slug = decodeURIComponent(slugRaw);
    } catch {
      // 非法百分号转义（如 /api/npcs/%）应为 404，而不是 500
      return sendJsonError(res, 404, 'not_found', 'NPC 不存在');
    }
    const dir = path.join(NPCS_DIR, slug);
    if (!dir.startsWith(NPCS_DIR + path.sep) || !fs.existsSync(dir)) {
      return sendJsonError(res, 404, 'not_found', 'NPC 不存在');
    }
    const read = (name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        return null;
      }
    };
    const state = (() => {
      try {
        return JSON.parse(read('state.json') || 'null');
      } catch {
        return null;
      }
    })();
    const memory = read('memory.md') || '';
    const convLines = (read('conversations.jsonl') || '').trim().split('\n').filter(Boolean);
    const conversations = [];
    for (const line of convLines.slice(-100)) {
      try {
        conversations.push(JSON.parse(line));
      } catch {}
    }
    const c0 = cfg();
    const resolved = await resolveVoice(slug, c0.tts);
    // Kokoro 引擎下，实际音色名与 gender 取自 Kokoro 音色表；否则沿用系统语音
    const kokoroOn = activeEngine(c0) === 'kokoro';
    const perVoice = readVoice(slug);
    const kGender =
      perVoice.gender === 'male' || perVoice.gender === 'female'
        ? perVoice.gender
        : resolved.gender;
    const kVoice =
      (perVoice.voice && KOKORO_VOICES.find((v) => v.name === perVoice.voice)) ||
      KOKORO_VOICES.find((v) => v.name === (kGender === 'male' ? c0.tts.kokoro.voiceMale : c0.tts.kokoro.voiceFemale)) ||
      KOKORO_VOICES[0];
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        slug,
        state,
        memory,
        prompt: loadNpcPrompt(slug),
        conversations,
        stage: loadStage(slug),
        aliases: loadAliases(slug),
        hasIntake: !!entryOf(slug)?.hasIntake,
        castEnabled: !!entryOf(slug)?.castEnabled,
        voice: readVoice(slug),
        engine: kokoroOn ? 'kokoro' : 'windows',
        // 只回传前端要展示的字段：available 是完整语音清单，体积大且另有 /api/tts/voices
        voiceResolved: kokoroOn
          ? {
              gender: kVoice.gender,
              voiceName: kVoice.name,
              voiceLabel: kVoice.label,
              reason: perVoice.voice ? '该 NPC 指定了 Kokoro 音色' : `按${kVoice.gender === 'male' ? '男' : '女'}声取全局默认`,
            }
          : {
              gender: resolved.gender,
              voiceName: resolved.voiceName,
              reason: resolved.reason,
            },
      }),
    );
  }

  async function handlePutNpcPrompt(req, res, slugRaw) {
    let slug;
    try {
      slug = decodeURIComponent(slugRaw);
    } catch {
      return sendJsonError(res, 404, 'not_found', 'NPC 不存在');
    }
    const dir = path.join(NPCS_DIR, slug);
    if (!dir.startsWith(NPCS_DIR + path.sep) || !fs.existsSync(dir)) {
      return sendJsonError(res, 404, 'not_found', 'NPC 不存在');
    }
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return sendJsonError(res, 400, 'bad_request', '请求体不是合法 JSON');
    }
    if (!body || typeof body.text !== 'string') {
      return sendJsonError(res, 400, 'bad_request', 'text 缺失或类型错误');
    }
    if (body.text.length > PROMPT_MAX_CHARS) {
      return sendJsonError(res, 400, 'bad_request', `提示词过长（上限 ${PROMPT_MAX_CHARS} 字）`);
    }
    const saved = saveNpcPrompt(slug, { useGlobal: body.useGlobal !== false, text: body.text });
    logger.append({ kind: 'config', status: 'updated', slug, promptChars: saved.text.length });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, prompt: saved }));
  }

  // —— 共演：在场状态与别名 ——

  function handleGetStage(req, res, slugRaw) {
    const hit = resolveNpcDir(res, slugRaw);
    if (!hit) return;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, slug: hit.slug, stage: loadStage(hit.slug) }));
  }

  function handleDeleteStage(req, res, slugRaw) {
    const hit = resolveNpcDir(res, slugRaw);
    if (!hit) return;
    const stage = { sceneKey: null, onStage: [], updatedAt: Date.now() };
    saveStage(hit.slug, stage);
    logger.append({ kind: 'config', status: 'updated', slug: hit.slug, action: 'stage_cleared' });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, slug: hit.slug, stage }));
  }

  async function handlePutAliases(req, res, slugRaw) {
    const hit = resolveNpcDir(res, slugRaw);
    if (!hit) return;
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return sendJsonError(res, 400, 'bad_request', '请求体不是合法 JSON');
    }
    if (!body || !Array.isArray(body.names)) {
      return sendJsonError(res, 400, 'bad_request', 'names 缺失或不是数组');
    }
    if (body.names.length > 20 || body.names.some((x) => typeof x !== 'string' || x.length > 20)) {
      return sendJsonError(res, 400, 'bad_request', '别名最多 20 条，每条不超过 20 字');
    }
    const names = saveAliases(hit.slug, body.names);
    logger.append({ kind: 'config', status: 'updated', slug: hit.slug, aliases: names.length });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, slug: hit.slug, names }));
  }

  function handleGetCast(req, res, slugRaw) {
    const hit = resolveNpcDir(res, slugRaw);
    if (!hit) return;
    const entry = entryOf(hit.slug);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        ok: true,
        slug: hit.slug,
        enabled: !!entry?.castEnabled,
        hasIntake: !!entry?.hasIntake,
      }),
    );
  }

  async function handlePutCast(req, res, slugRaw) {
    const hit = resolveNpcDir(res, slugRaw);
    if (!hit) return;
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return sendJsonError(res, 400, 'bad_request', '请求体不是合法 JSON');
    }
    if (!body || typeof body.enabled !== 'boolean') {
      return sendJsonError(res, 400, 'bad_request', 'enabled 缺失或不是布尔值');
    }
    const entry = entryOf(hit.slug);
    if (body.enabled && !entry?.hasIntake) {
      return sendJsonError(res, 400, 'no_intake', '该 NPC 还没有 intake 存档（从未成功对话过），不能启用共演');
    }
    const saved = saveCastFlag(hit.slug, body.enabled);
    // 关闭共演时，若该 NPC 正在别的 NPC 的在场列表里，立即请出（惰性生效，下轮请求会过滤）
    logger.append({ kind: 'config', status: 'updated', slug: hit.slug, castEnabled: saved.enabled });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, slug: hit.slug, ...saved }));
  }

  // —— AI 修改记忆：一次性指令改写草稿 → 预览/编辑 → 备份后覆盖 ——

  /** POST /api/npcs/:slug/memory/rewrite：按玩家指令用上游模型改写记忆，返回草稿（不落盘）。 */
  async function handleRewriteMemory(req, res, slugRaw) {
    const hit = resolveNpcDir(res, slugRaw);
    if (!hit) return;
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return sendJsonError(res, 400, 'bad_request', '请求体不是合法 JSON');
    }
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return sendJsonError(res, 400, 'bad_request', '修改要求（prompt）不能为空');
    if (prompt.length > MEMORY_EDIT_MAX_CHARS) {
      return sendJsonError(res, 400, 'bad_request', `修改要求过长（上限 ${MEMORY_EDIT_MAX_CHARS} 字）`);
    }
    if (!cfg().upstream.apiKey) {
      return sendJsonError(res, 503, 'upstream_not_configured', '上游 API Key 未配置，请在管理页填写');
    }
    const { slug, dir } = hit;
    const memoryFile = path.join(dir, 'memory.md');
    let original = '';
    try {
      original = fs.readFileSync(memoryFile, 'utf8');
    } catch {}
    const started = Date.now();
    try {
      const { draft, durationMs, usage, messages, request } = await rewriter.rewrite(
        slug,
        memoryFile,
        prompt,
      );
      const tokens = tokenUsage({ usage, messages, reply: draft });
      const detail = {
        kind: 'memory_edit',
        action: 'rewrite',
        request: request || { model: cfg().upstream.model, stream: false, messageCount: messages?.length || 0 },
        messages: (messages || []).map((m) => {
          const content = messageText(m);
          return { role: m.role, origin: 'internal', content, chars: content.length };
        }),
        reasoning: '',
        reply: draft,
        usage: usage || null,
        tokens,
        timing: { durationMs },
      };
      logger.append(
        {
          kind: 'memory_edit',
          slug,
          action: 'rewrite',
          status: 'done',
          durationMs,
          promptChars: prompt.length,
          generatedChars: draft.length,
          ...tokenFields(tokens),
        },
        detail,
      );
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, slug, original, draft }));
    } catch (err) {
      logger.append({
        kind: 'memory_edit',
        slug,
        action: 'rewrite',
        status: 'error',
        durationMs: Date.now() - started,
        error: err?.message || String(err),
      });
      sendJsonError(res, 502, 'upstream_error', `AI 改写失败: ${err?.message || err}`);
    }
  }

  /** PUT /api/npcs/:slug/memory：用草稿覆盖记忆；覆盖前按时间戳备份到 backups/。 */
  async function handlePutMemory(req, res, slugRaw) {
    const hit = resolveNpcDir(res, slugRaw);
    if (!hit) return;
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return sendJsonError(res, 400, 'bad_request', '请求体不是合法 JSON');
    }
    if (!body || typeof body.text !== 'string') {
      return sendJsonError(res, 400, 'bad_request', 'text 缺失或类型错误');
    }
    if (body.text.length > MEMORY_TEXT_MAX_CHARS) {
      return sendJsonError(res, 400, 'bad_request', `记忆过长（上限 ${MEMORY_TEXT_MAX_CHARS} 字）`);
    }
    const { slug, dir } = hit;
    const memoryFile = path.join(dir, 'memory.md');
    let backup = null;
    try {
      // 与摘要器写 memory.md 用同一队列 key，避免覆盖与摘要写入交错
      backup = await queues.run('summary:' + slug, () => {
        const b = backupMemory(memoryFile, slug);
        writeMemory(memoryFile, slug, body.text);
        return b;
      });
    } catch (err) {
      logger.append({ kind: 'memory_edit', slug, action: 'save', status: 'error', error: err?.message || String(err) });
      return sendJsonError(res, 500, 'internal_error', `保存失败: ${err?.message || err}`);
    }
    const chars = body.text.trim().length;
    logger.append({ kind: 'memory_edit', slug, action: 'save', status: 'done', memoryChars: chars, backup });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, backup, chars }));
  }

  // —— 语音朗读（TTS） ——

  /**
   * 语音朗读日志：**成功只落盘、不进界面**（fileOnly）。
   * 朗读是高频动作，每播一条记一条会把执行日志刷屏，并把环形缓冲里真正的对话记录挤掉；
   * 失败仍然进界面（数量少、有诊断价值）。落盘记录可在 logs/YYYY-MM-DD.jsonl 里 grep。
   */
  function logTts(rec) {
    logger.append(rec, undefined, { fileOnly: rec.status !== 'error' });
  }

  /** 系统中文语音清单（枚举要起一次 PowerShell，缓存 10 分钟）。 */
  async function handleTtsVoices(req, res, url) {
    const force = url.searchParams.get('refresh') === '1';
    const voices = await listVoices({ force });
    const c = cfg();
    const kstatus = kokoroStatus();
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        ok: voices.length > 0 || kstatus.installed,
        voices,
        suggested: {
          male: voices.some((v) => v.name === c.tts.voices.male) ? c.tts.voices.male : null,
          female: voices.some((v) => v.name === c.tts.voices.female) ? c.tts.voices.female : null,
        },
        // 引擎与音色清单（前端据此渲染下拉与安装按钮）
        engines: {
          current: activeEngine(c),
          configured: c.tts.engine === 'kokoro' ? 'kokoro' : 'windows',
          kokoro: {
            installed: kstatus.installed,
            bytes: kstatus.bytes,
            downloadBytes: kstatus.downloadBytes,
            voices: KOKORO_VOICES,
            // 当前保存的 Kokoro 音色。前端只能从这里拿——
            // /api/status 的 tts 段不含这一项，否则重载页面后下拉会回退成第一个。
            voiceMale: c.tts.kokoro.voiceMale,
            voiceFemale: c.tts.kokoro.voiceFemale,
            threads: c.tts.kokoro.threads,
            state: kstatus.state,
          },
        },
        hint: voices.length
          ? ''
          : '系统里没有可用的中文语音。请在 Windows「设置 → 时间和语言 → 语音」中添加中文语音包。',
      }),
    );
  }

  /** 安装 Kokoro 引擎（后台执行，前端轮询 /api/tts/install）。 */
  async function handleTtsInstall(req, res) {
    if (isKokoroInstalled()) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: true, alreadyInstalled: true }));
    }
    // 已在下载中：不要重复启动（install() 会返回 already_running，但那时 HTTP 已回 started）
    if (kokoroStatus().state?.running) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: true, alreadyRunning: true }));
    }
    // 不 await：安装有 159MB，不能把请求挂住
    installKokoro().catch((err) => {
      logger.append({ kind: 'tts', status: 'error', action: 'install', error: String(err?.message || err) });
    });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, started: true }));
  }

  /** 安装进度（前端每 800ms 轮询一次）。 */
  function handleTtsInstallStatus(req, res) {
    const s = kokoroStatus();
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, ...s }));
  }


  /**
   * 按日志 rid 合成语音。
   * 音色归属：detail.slug 优先；0.18.0 之前的旧日志没有该字段 → 用 ?slug= 兜底。
   * ?slug= 来自 URL，属不可信输入，必须做路径校验。
   */
  async function handleTtsAudio(req, res, rid, url) {
    let id;
    try {
      id = decodeURIComponent(rid);
    } catch {
      id = rid;
    }
    const detail = logger.getDetail(id);
    if (!detail || typeof detail !== 'object') {
      return sendJsonError(res, 404, 'detail_not_found', '详情已过期或不存在');
    }
    // 只允许 NPC 对话：记忆摘要 / 压缩器 / 探测的详情里也有 reply，
    // 但它们不是"角色台词"，不应该被朗读（也避免被当成通用合成接口）。
    if (detail.kind !== 'npc') {
      return sendJsonError(res, 400, 'not_npc_reply', '这条记录不是 NPC 对话，无法朗读');
    }

    // 只有 NPC 对话才有可朗读的正文
    let slug = typeof detail.slug === 'string' && detail.slug ? detail.slug : null;
    if (!slug) {
      const fromQuery = strIn(url.searchParams.get('slug'), 200);
      if (fromQuery) {
        const dir = path.join(NPCS_DIR, fromQuery);
        if (dir.startsWith(NPCS_DIR + path.sep) && fs.existsSync(dir)) slug = fromQuery;
      }
    }

    const auto = url.searchParams.get('auto') === '1';
    // 自动朗读时尊重逐 NPC 静音；手动播放（点 ▶）不受任何开关限制
    if (auto && !isVoiceEnabled(slug)) {
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }

    const mode = url.searchParams.get('mode');
    const raw = typeof detail.reply === 'string' ? detail.reply : '';
    const c = cfg();
    const started = Date.now();
    let result;
    try {
      result = await speak({ raw, slug, cfg: c, mode });
    } catch (err) {
      result = { ok: false, reason: 'tts_powershell_failed', chars: 0, text: '', mode: 'all', voiceName: null, gender: 'female', detail: String(err?.message || err) };
    }

    const baseLog = {
      kind: 'tts',
      slug,
      engine: result.engine || 'windows',
      mode: result.mode,
      chars: result.chars,
      voice: result.voiceName,
      gender: result.gender,
      auto,
      synthMs: result.synthMs ?? Date.now() - started,
      cached: !!result.cached,
      ...(result.engineFallback ? { engineFallback: result.engineFallback } : {}),
    };

    if (!result.ok) {
      const reason = result.reason || (result.engine === 'kokoro' ? 'kokoro_failed' : 'tts_powershell_failed');
      // 「这条没东西可读」是正常情况，不算故障：记 skipped，且不进界面
      const benign = reason === 'empty_text' || reason === 'not_plain_text';
      logTts({
        ...baseLog,
        status: benign || reason === 'tts_stopping' ? 'skipped' : 'error',
        ...(benign ? { reason } : { error: result.detail ? `${reason}:${result.detail}` : reason }),
      });
      if (benign) {
        return sendJsonError(res, 400, reason, '这条回复里没有可朗读的文字');
      }
      if (reason === 'tts_stopping') {
        return sendJsonError(res, 503, reason, '程序正在退出');
      }
      return sendJsonError(res, 500, reason, '语音合成失败');
    }

    logTts({ ...baseLog, status: 'done', bytes: result.wav.length });
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': result.wav.length,
      'cache-control': 'no-store',
    });
    res.end(result.wav);
  }

  /** 试听：不带 text 时用内置示例句。 */
  async function handleTtsPreview(req, res) {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return sendJsonError(res, 400, 'bad_request', '请求体不是合法 JSON');
    }
    const c = cfg();
    const gender = body?.gender === 'male' || body?.gender === 'female' ? body.gender : c.tts.defaultGender;
    const maxChars = c.tts.maxChars || 600;
    const text = (strIn(body?.text, maxChars) || '道友请留步。今日山门前的桃花开得正好，可否愿意与我同去看看？').trim();

    const clampFloat = (v, min, max, fallback) => {
      // Number(null)===0 / Number('')===0：先排除"没传"，否则会被夹到 min
      if (v === null || v === undefined || v === '') return fallback;
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.round(Math.min(Math.max(n, min), max) * 100) / 100;
    };
    const rate = clampFloat(body?.rate, 0.5, 3, c.tts.rate);
    const pitch = clampFloat(body?.pitch, 0.5, 2, c.tts.pitch);

    // 试听不绑 NPC：优先用调用方明确指定的音色（管理页下拉框里选中的那个），
    // 没指定才按性别取配置里的默认音色。
    // 注意：不能只用 gender —— 那样换下拉框里的音色也永远听同一个声音。
    //
    // engine=kokoro 时 voice 是 Kokoro 音色名（zf_xiaoxiao 等）；否则是系统语音名。
    const wantEngine = body?.engine === 'kokoro' ? 'kokoro' : body?.engine === 'windows' ? 'windows' : activeEngine(c);
    const started = Date.now();

    if (wantEngine === 'kokoro') {
      if (!isKokoroInstalled()) {
        return sendJsonError(res, 400, 'engine_not_installed', 'Kokoro 引擎尚未安装');
      }
      const explicitK = KOKORO_VOICES.find((v) => v.name === strIn(body?.voice, 40));
      const defK = gender === 'male' ? c.tts.kokoro.voiceMale : c.tts.kokoro.voiceFemale;
      const voice = explicitK || KOKORO_VOICES.find((v) => v.name === defK) || KOKORO_VOICES[0];
      const r = await synthesizeKokoro({ text, voice: voice.name, rate, threads: c.tts.kokoro.threads });
      if (!r.ok) {
        logTts({ kind: 'tts', status: 'error', action: 'preview', engine: 'kokoro', voice: voice.name, chars: text.length, error: r.detail ? `${r.reason}:${r.detail}` : r.reason });
        return sendJsonError(res, 500, r.reason || 'kokoro_failed', 'Kokoro 合成失败');
      }
      logTts({ kind: 'tts', status: 'done', action: 'preview', engine: 'kokoro', voice: voice.name, gender: voice.gender, chars: text.length, bytes: r.wav.length, synthMs: r.synthMs ?? Date.now() - started });
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': r.wav.length, 'cache-control': 'no-store' });
      return res.end(r.wav);
    }

    const voices = await listVoices();
    const explicit = strIn(body?.voice, 200);
    const want = gender === 'male' ? c.tts.voices.male : c.tts.voices.female;
    let voiceName = null;
    if (explicit && voices.some((v) => v.name === explicit)) voiceName = explicit;
    if (!voiceName && voices.some((v) => v.name === want)) voiceName = want;
    if (!voiceName) voiceName = (voices.find((v) => v.gender === gender) || voices[0])?.name || null;
    if (!voiceName) {
      logTts({ kind: 'tts', status: 'error', error: 'tts_no_voice', action: 'preview' });
      return sendJsonError(res, 400, 'tts_no_voice', '系统里没有可用的中文语音');
    }

    const r = await synthesize({ text, voice: voiceName, rate, pitch });
    if (!r.ok) {
      logTts({
        kind: 'tts',
        status: 'error',
        action: 'preview',
        voice: voiceName,
        chars: text.length,
        error: r.detail ? `${r.reason}:${r.detail}` : r.reason,
      });
      return sendJsonError(res, 500, r.reason || 'tts_powershell_failed', '语音合成失败');
    }
    logTts({
      kind: 'tts',
      status: 'done',
      action: 'preview',
      voice: voiceName,
      gender,
      chars: text.length,
      bytes: r.wav.length,
      synthMs: r.synthMs ?? Date.now() - started,
    });
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': r.wav.length,
      'cache-control': 'no-store',
    });
    res.end(r.wav);
  }

  /** 保存逐 NPC 语音设置。 */
  async function handlePutNpcVoice(req, res, slugRaw) {
    const hit = resolveNpcDir(res, slugRaw);
    if (!hit) return;
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      return sendJsonError(res, 400, 'bad_request', '请求体不是合法 JSON');
    }
    // Kokoro 音色名要校验，避免写入无法使用的值
    const raw = body && typeof body === 'object' ? { ...body } : {};
    if (typeof raw.voice === 'string' && raw.voice.trim()) {
      if (!KOKORO_VOICES.some((v) => v.name === raw.voice.trim())) {
        return sendJsonError(res, 400, 'bad_request', `未知的 Kokoro 音色: ${raw.voice}`);
      }
    }
    const next = saveVoice(hit.slug, raw);
    logger.append({ kind: 'config', status: 'updated', slug: hit.slug, action: 'voice', voiceEnabled: next.enabled, gender: next.gender, voice: next.voice || null });
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, voice: next }));
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'snapshot', records: logger.list(200) });
    const unsub = logger.subscribe((entry) => send({ type: 'log', record: entry }));
    const hb = setInterval(() => res.write(': hb\n\n'), 25000);
    req.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  }

  // —— 游戏对话编排 ——

  async function handleChat(req, res, bodyBuf) {
    const started = Date.now();
    let body;
    try {
      body = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      return sendJsonError(res, 400, 'bad_request', '请求体不是合法 JSON');
    }
    if (!body || !Array.isArray(body.messages)) {
      return sendJsonError(res, 400, 'bad_request', 'messages 缺失');
    }
    const c = cfg();
    if (!c.upstream.apiKey) {
      return sendJsonError(res, 503, 'upstream_not_configured', '上游 API Key 未配置，请在管理页填写');
    }
    if (c.upstream.insecureTLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const info = classify(body);
    const baseLog = {
      kind: info.type,
      modelIn: body.model || null,
      modelOut: c.upstream.model,
      stream: !!body.stream,
      messageCount: body.messages.length,
      slug: info.slug || null,
      variant: info.variant || null,
      sessionId: info.slug ? sessionIdOf(info.slug) : null,
      playerText: info.userText ? info.userText.slice(0, 300) : '',
    };

    if (info.type !== 'npc') {
      const finalBody = prepareUpstreamBody(body, c);
      const detail = {
        kind: info.type,
        request: requestMeta(finalBody),
        messages: buildDetailMessages(finalBody.messages),
        reasoning: '',
        reasoningTruncated: false,
        reply: '',
        usage: null,
        tokens: null,
        timing: {},
        error: null,
      };
      try {
        const result = await forwardUpstream(finalBody, res, c);
        const tokens = tokenUsage({
          usage: result.usage,
          messages: finalBody.messages,
          reply: result.assistantText,
          reasoning: result.reasoningText,
        });
        Object.assign(detail, {
          reasoning: result.reasoningText,
          reasoningTruncated: !!result.reasoningTruncated,
          reply: result.assistantText,
          usage: result.usage || null,
          tokens,
          timing: detailTiming(result),
        });
        logger.append(
          {
            ...baseLog,
            // 上游非 2xx 时如实记 upstream_error，不要一律记 done
            status: result.ok ? 'done' : 'upstream_error',
            upstreamStatus: result.status,
            durationMs: result.durationMs,
            ttftMs: result.ttftMs,
            reasoningTtftMs: result.reasoningTtftMs,
            contentTtftMs: result.contentTtftMs,
            ...tokenFields(tokens),
          },
          detail,
        );
      } catch (err) {
        detail.error = err?.message || String(err);
        logger.append(
          { ...baseLog, status: 'error', durationMs: Date.now() - started, error: detail.error },
          detail,
        );
        sendJsonError(res, 502, 'upstream_error', `上游请求失败: ${err?.message || err}`);
      }
      return;
    }

    const memEnabled = !!c.memory.enabled;
    const ms = c.multiNpc || {};
    const castOn = !!ms.enabled;
    const turnId = castOn ? turnIdOf() : null;
    let bundle = null;
    let memoryText = '';
    let promptsText = '';
    let injectChars = 0;
    let promptChars = 0;
    let castChars = 0;
    let snapshotChanged = false;
    const warnings = [];
    // 中性提示（不是故障）：例如纯文本回复已按当轮模板补成 JSON，只在日志里注明，不标红。
    const notes = [];
    // 记录注入内容 → 来源，用于日志详情标注「游戏原始 / 游戏重写后 / 外置记忆 / 外置提示词 / 格式提醒」
    const injected = new Map();
    let rewriteInfo = null;
    let detailRewrite = null;
    let rewriteTokens = null;
    // 原样透传、不参与重写的游戏事实模块数（任务/经历/关系/结算）
    let rewriteSkippedFacts = 0;

    // 客户端断开时中止重写 / 配角调用，避免白白消耗 token
    const clientAc = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) clientAc.abort();
    });

    // —— 共演预规划（只读，不落盘） ——
    let cast = null;
    let bCard = null;
    let bActor = null; // { messages, result, line, order }
    let castInjector = null;
    let castMode = null; // 'head' | 'tail'
    let castStage = null;
    let castStageChanged = false;
    let castStageTouched = false;
    let castNotes = [];
    let castCommands = [];
    let modelPlayerText = info.userText;

    if (castOn) {
      try {
        const aMemory0 = memEnabled
          ? loadMemory(path.join(NPCS_DIR, info.slug, 'memory.md'), effectiveInjectChars(c))
          : '';
        cast = planCast({
          info,
          cfg: c,
          aMemoryText: aMemory0,
        });
        if (cast) {
          castNotes = cast.notes || [];
          castCommands = cast.commands || [];
          const clean = String(cast.cleanText ?? info.userText);
          const blank = !clean.trim() || /^[\s，,。！？!?、]+$/.test(clean);
          modelPlayerText = castCommands.length && blank ? '（玩家没有开口）' : clean;
        }
        for (const w of cast?.warnings || []) warnings.push(w);
        if (cast?.skip) {
          // no_costar 是普通单人轮，不算告警
          if (cast.skip !== 'no_costar') warnings.push('cast_skipped:' + cast.skip);
          // 入场/离场仍要在本轮成功后落盘
          castStage = cast.stage || null;
          castStageChanged = !!cast.changed;
          castStageTouched = !!cast.touched;
          cast = null;
        }
        if (cast?.coStar) bCard = cast.coStar.card;
        if (cast) {
          castStage = cast.stage;
          castStageChanged = !!cast.changed;
          castStageTouched = !!cast.touched;
        }
      } catch (err) {
        warnings.push('cast_plan_failed:' + (err?.message || String(err)));
        cast = null;
      }
    }

    if (modelPlayerText !== info.userText) {
      body = { ...body, messages: replaceLastUser(body.messages, modelPlayerText) };
    }

    const aName = info.slug;
    const castLog =
      cast || castNotes.length || castCommands.length
        ? {
            turnId,
            coStar: cast?.coStar?.slug || null,
            coStarName: cast?.coStar?.name || null,
            stage: (cast?.stage?.onStage || castStage?.onStage || []).map((x) => x.slug),
            stageChanged: castStageChanged ? (cast?.left?.length || castNotes.some((n) => n.includes('离开')) ? 'leave' : 'enter') : null,
            addressed: cast?.addressedB ? cast.coStar?.slug : null,
            known: !!cast?.known,
            order: cast?.order || null,
            commands: castCommands.map((x) => `${x.action}:${x.name}`),
            notes: castNotes,
          }
        : null;

    const logBCall = ({ actor, order, mode, line }) => {
      const result = actor?.result;
      const tokens = tokenUsage({
        usage: result?.usage,
        messages: actor?.messages || [],
        reply: result?.raw || '',
      });
      const detail = {
        kind: 'costar',
        turnId,
        request: {
          model: c.upstream.model,
          stream: false,
          temperature: 0.6,
          max_tokens: Math.max(80, Number(ms.actorMaxTokens) || 300),
          thinking: { type: 'disabled' },
          messageCount: (actor?.messages || []).length,
        },
        messages: (actor?.messages || []).map((m) => {
          const content = messageText(m);
          return { role: m.role, origin: 'internal', content, chars: content.length };
        }),
        reasoning: '',
        reasoningTruncated: false,
        reply: result?.raw || '',
        usage: result?.usage || null,
        tokens,
        timing: { durationMs: result?.durationMs ?? null },
      };
      logger.append(
        {
          kind: 'costar',
          turnId,
          actor: bCard?.name || cast?.coStar?.name || null,
          role: 'costar',
          slug: info.slug,
          order,
          mode,
          spoke: !!line,
          lineChars: line ? line.length : 0,
          replyPreview: (line || result?.raw || '').slice(0, 300),
          durationMs: result?.durationMs ?? null,
          status: result?.ok ? 'done' : 'error',
          ...(result?.error ? { error: result.error } : {}),
          ...tokenFields(tokens),
        },
        detail,
      );
      return tokens;
    };

    /**
     * 构造并调用配角。返回清洗后的台词（null = 不说话 / 失败）。
     * @param {'head'|'tail'} mode
     */
    const runActor = async ({ mode, aContent = '' }) => {
      if (!bCard) return { actor: null, line: null, tokens: null };
      const bState = readStateOf(bCard.slug);
      const bMemory = loadMemory(path.join(NPCS_DIR, bCard.slug, 'memory.md'), 800);
      const bPrompt = c.prompts.enabled ? loadNpcPrompt(bCard.slug) : { useGlobal: true, text: '' };
      const hist = transcriptOf(
        path.join(NPCS_DIR, info.slug, 'conversations.jsonl'),
        Math.max(1, Number(ms.transcriptTurns) || 8),
        info.slug,
      );
      const lines = [hist, `[玩家] ${modelPlayerText}`];
      if (mode === 'tail' && aContent) lines.push(`[${aName}] ${aContent}`);
      const messages = buildActorMessages({
        card: bCard,
        memoryText: bMemory,
        scene: info.state?.scene || '',
        gameTime: info.state?.gameTime || '',
        presentNames: [aName, bCard.name],
        transcript: lines.filter(Boolean).join('\n'),
        playerText: modelPlayerText,
        globalPrompt: c.prompts.enabled && bPrompt.useGlobal !== false ? c.prompts.global || '' : '',
        npcPrompt: c.prompts.enabled ? bPrompt.text || '' : '',
      });
      const actor = { messages, result: null, line: null, order: mode === 'head' ? 1 : 2 };
      const result = await callActor({ config: c, messages, signal: clientAc.signal, label: 'costar' });
      actor.result = result;
      if (!result.ok) {
        logger.append({
          kind: 'costar',
          turnId,
          actor: bCard.name,
          role: 'costar',
          slug: info.slug,
          order: actor.order,
          mode,
          status: 'error',
          durationMs: result.durationMs,
          error: result.error,
        });
        return { actor, line: null, tokens: null };
      }
      const line = sanitizeActorText(result.text, bCard.name);
      actor.line = line;
      const tokens = logBCall({ actor, order: actor.order, mode, line });
      return { actor, line, tokens };
    };

    try {
      // 1) 只读地准备 A 的记忆与提示词（供请求重写 / 共演块使用）
      const aState0 = readStateOf(info.slug);
      if (memEnabled) {
        memoryText = buildMemoryText({
          memoryFile: path.join(NPCS_DIR, info.slug, 'memory.md'),
          state: aState0,
          maxChars: effectiveInjectChars(c),
        });
      }
      if (c.prompts.enabled) {
        try {
          const local = loadNpcPrompt(info.slug);
          promptsText = buildPromptsText({
            global: local.useGlobal !== false ? c.prompts.global : '',
            npc: local.text,
          });
        } catch (err) {
          warnings.push('prompt_load_failed:' + err.message);
        }
      }

      // 2) 请求重写（实验性）：先改写游戏 system 与配角构造模块，再注入外置内容
      if (c.requestRewrite.enabled && (memoryText || promptsText)) {
        const { systems, skipped: factModules, mixed } = collectGameSystemMessages(body.messages);
        if (factModules.length) rewriteSkippedFacts = factModules.length;
        if (mixed.length) warnings.push('rewrite_skipped:mixed_fact_module');
        if (!systems.length) {
          warnings.push(
            factModules.length ? 'rewrite_skipped:only_fact_modules' : 'rewrite_skipped:no_text_system',
          );
        } else {
          const extras = [];
          if (bCard) {
            const nameLine = `姓名：${bCard.name}`;
            const idLine = `身份：${bCard.identity}`;
            const cardText = renderCard(bCard);
            if (bCard.world) extras.push({ key: 'B_WORLD', content: bCard.world });
            extras.push({
              key: 'B_CARD',
              content: cardText,
              guard: (orig, rew) => {
                if (!rew.includes(nameLine)) return 'rewrite_cast_name_changed';
                if (idLine && idLine !== '身份：' && !rew.includes(idLine)) return 'rewrite_cast_identity_changed';
                return null;
              },
            });
          }
          try {
            const rw = await requestRewriter.rewrite({
              slug: info.slug,
              systems,
              extras,
              memoryText,
              promptsText,
              signal: clientAc.signal,
            });
            // 命中缓存时本轮没有真实重写消耗；token 数记 0，原本要花的量放到 savedTokens。
            rewriteTokens = rw.cacheHit ? 0 : rw.tokens?.total ?? null;
            rewriteInfo = {
              status: rw.status,
              durationMs: rw.durationMs,
              cacheMode: rw.cache?.mode || 'none',
              cacheHit: !!rw.cacheHit,
              cacheAgeMs: rw.cacheAgeMs ?? null,
              savedDurationMs: rw.savedDurationMs || 0,
              savedTokens: rw.savedTokens || 0,
              cacheKey: rw.cache?.key || null,
              tokens: rw.tokens || null,
              skippedFacts: rewriteSkippedFacts,
              cachedModules: rw.cachedCount || 0,
              modules: rw.moduleCount,
              changedModules: rw.changedCount,
              repairedModules: rw.repairedCount,
              failedModules: rw.failedCount,
              droppedModules: rw.droppedCount || 0,
              originalChars: rw.originalChars,
              rewrittenChars: rw.rewrittenChars,
              removedLines: rw.removedCount,
              addedLines: rw.addedCount,
              ...(rw.error ? { error: rw.error } : {}),
            };
            // 失败时也保留草稿，便于在详情里排查
            detailRewrite = rw;
            for (const item of rw.items) {
              if (!item.ok) warnings.push(`rewrite_failed:module${item.id}:${item.error}`);
            }
            if (rw.ok) {
              const messages = body.messages.slice();
              const drops = [];
              for (const item of rw.items) {
                if (item.group !== 'game') continue;
                if (!item.ok || !item.changed) continue;
                // 整节都在冲突、重写模型删空：直接删掉这条 system，而不是留一条空消息
                if (item.droppedModule) {
                  drops.push(item.index);
                  continue;
                }
                messages[item.index] = { ...messages[item.index], content: item.rewritten };
                injected.set(item.rewritten, 'game_rewritten');
              }
              for (const idx of drops.sort((a, b) => b - a)) messages.splice(idx, 1);
              body = { ...body, messages };
              // 配角模块：只更新通过的改写
              for (const item of rw.items) {
                if (item.group !== 'cast' || !item.ok || !item.changed || !bCard) continue;
                if (item.key === 'B_WORLD') bCard.world = item.rewritten;
                if (item.key === 'B_CARD') bCard.rendered = item.rewritten;
              }
            } else {
              warnings.push('rewrite_failed:' + (rw.error || 'all_modules_failed'));
            }
          } catch (err) {
            warnings.push('rewrite_failed:' + (err?.message || String(err)));
            rewriteInfo = {
              status: 'failed',
              durationMs: null,
              error: err?.message || String(err),
            };
          }
        }
      }

      // 3) B 先说话：先跑 B，拿到公开台词后才请求 A
      if (cast && cast.shouldBSpeak && cast.order === 'B') {
        const r = await runActor({ mode: 'head' });
        bActor = r.actor;
        if (!r.actor || !r.actor.result?.ok) {
          // 整轮作废：A 未被调用、不落盘
          logger.append({
            ...baseLog,
            status: 'error',
            cast: castLog,
            warnings,
            durationMs: Date.now() - started,
            error: '配角请求失败，整轮作废',
          });
          return sendJsonError(res, 502, 'costar_failed', '配角请求失败，本轮已放弃（不会写入记忆）');
        }
        if (r.line) {
          castMode = 'head';
          castInjector = new ContentInjector({ mode: 'head', line: r.line });
        }
      }

      // 4) A 侧建档与装配（B 成功后才动 A 的状态文件）
      if (memEnabled) {
        bundle = openNpc(info.slug, info);
        try {
          if (c.memory.snapshotSystem) {
            snapshotChanged = snapshotSystem(info.slug, info.system, bundle.state);
            if (snapshotChanged) saveState(bundle.stateFile, bundle.state);
          }
        } catch (err) {
          warnings.push('snapshot_failed:' + err.message);
        }
        memoryText = buildMemoryText({
          memoryFile: bundle.memoryFile,
          state: bundle.state,
          maxChars: effectiveInjectChars(c),
        });
      }

      // 注入顺序：记忆 → 外置提示词 → 共演现场 → 格式提醒
      if (memoryText) {
        body = { ...body, messages: insertBeforeLastUser(body.messages, memoryText) };
        injectChars = memoryText.length;
        injected.set(memoryText, 'memory');
      }
      if (promptsText) {
        body = { ...body, messages: insertBeforeLastUser(body.messages, promptsText) };
        promptChars = promptsText.length;
        injected.set(promptsText, 'prompt');
      }

      if (cast || castNotes.length) {
        const parts = [];
        if (castNotes.length) parts.push('【本场变化】\n' + castNotes.join(''));
        if (cast && bCard) {
          parts.push(
            buildCastBlock({
              coStar: cast.coStar,
              known: cast.known,
              addressedB: cast.addressedB,
              outputStyle: ms.outputStyle || 'script',
              aName,
            }),
          );
        }
        if (bActor?.line) parts.push(buildObservationBlock({ coStar: cast.coStar, line: bActor.line }));
        const block = parts.join('\n\n');
        body = { ...body, messages: insertBeforeLastUser(body.messages, block) };
        castChars = block.length;
        injected.set(block, 'cast');
      }

      // 格式强化：实测 flash 偶发不遵守「## 输出格式」而回纯文本。
      if (/##\s*输出格式/.test(info.system)) {
        const messages = body.messages.slice();
        let at = messages.length;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i].role === 'user') {
            at = i;
            break;
          }
        }
        messages.splice(at, 0, { role: 'system', content: FORMAT_REMINDER });
        injected.set(FORMAT_REMINDER, 'format');
        body = { ...body, messages };
      }

      // 5) A 先说话、B 接话：尾部插槽，等 B 就绪后插入
      if (cast && bCard && cast.shouldBSpeak && cast.order === 'A' && !castInjector) {
        castMode = 'tail';
        castInjector = new ContentInjector({
          mode: 'tail',
          waitMs: Math.max(500, Number(ms.actorTailWaitMs) || 3000),
          getLine: async (aContent) => {
            const r = await runActor({ mode: 'tail', aContent });
            bActor = r.actor;
            return r.line;
          },
        });
      }
    } catch (err) {
      warnings.push('memory_init_failed:' + err.message);
      bundle = null;
      castInjector = null;
    }

    const finalBody = prepareUpstreamBody(body, c);
    // 非流式兜底：A 替配角写的台词行先剥掉；回复不是 JSON 时再按当轮输出格式模板包回去。
    let aImpersonated = false;
    let plainWrapped = false;
    const filterAssistantText =
      cast && bCard
        ? (text) => {
            const r = stripCostarSpeech(text, bCard.name);
            if (r.stripped) aImpersonated = true;
            return r.text;
          }
        : null;
    const wrapPlainContent = /##\s*输出格式/.test(info.system)
      ? (text) => {
          if (!text || !text.trim()) return null;
          try {
            const j = JSON.parse(text);
            if (j && typeof j === 'object') return null;
          } catch {}
          const wrapped = wrapPlainReply(text, info.system);
          if (wrapped) plainWrapped = true;
          return wrapped;
        }
      : null;
    const detail = {
      kind: 'npc',
      // 语音朗读要按 NPC 选音色；baseLog 里有 slug，但 detail 是另一个对象，必须单独带上
      slug: info.slug,
      turnId,
      request: requestMeta(finalBody),
      messages: buildDetailMessages(finalBody.messages, injected),
      reasoning: '',
      reasoningTruncated: false,
      reply: '',
      usage: null,
      tokens: null,
      timing: {},
      cast: (cast && bCard) || castNotes.length || castCommands.length
        ? {
            turnId,
            coStar: cast && bCard ? { slug: bCard.slug, name: bCard.name } : null,
            known: !!cast?.known,
            addressedB: !!cast?.addressedB,
            mentionedB: !!cast?.mentionedB,
            order: cast?.order || null,
            mode: castMode,
            stage: ((cast?.stage || castStage)?.onStage || []).map((x) => x.slug),
            stageChanged: castStageChanged ? 'yes' : 'no',
            commands: castCommands.map((x) => `${x.action}:${x.name}`),
            notes: castNotes,
            blockChars: castChars,
            bLine: bActor?.line || null,
            bLineChars: bActor?.line?.length || 0,
            inserted: !!castInjector?.inserted,
            slotFailed: !!castInjector?.failed,
            request: bActor?.messages ? requestMeta({ model: c.upstream.model, stream: false, messages: bActor.messages }) : null,
            messages: (bActor?.messages || []).map((m) => {
              const content = messageText(m);
              return { role: m.role, origin: 'internal', content, chars: content.length };
            }),
            reply: bActor?.result?.raw || '',
            usage: bActor?.result?.usage || null,
            tokens: bActor?.result
              ? tokenUsage({ usage: bActor.result.usage, messages: bActor.messages, reply: bActor.result.raw })
              : null,
            timing: { durationMs: bActor?.result?.durationMs ?? null },
            error: bActor?.result?.error || null,
          }
        : null,
      rewrite: detailRewrite
        ? {
            status: detailRewrite.status,
            request: detailRewrite.request,
            messages: (detailRewrite.messages || []).map((m) => {
              const content = messageText(m);
              return { role: m.role, origin: 'internal', content, chars: content.length };
            }),
            modules: (detailRewrite.items || []).map((x) => ({
              id: x.id,
              group: x.group || 'game',
              key: x.key || null,
              index: x.index,
              title: x.title,
              status: x.ok ? 'done' : 'failed',
              changed: !!x.changed,
              repaired: !!x.repaired,
              dropped: !!x.droppedModule,
              error: x.error || null,
              originalChars: x.originalChars,
              rewrittenChars: x.rewrittenChars,
              removed: x.removed,
              added: x.added,
              removedCount: x.removedCount,
              addedCount: x.addedCount,
              // 只保留变化/失败模块的全文；未改动模块的原文仍在最终 messages 里
              original: x.changed || !x.ok ? x.original : null,
              // 失败时保留模型草稿，便于排查校验为什么没通过
              draft: !x.ok ? x.draft : null,
              rewritten: x.changed || !x.ok ? x.rewritten : null,
            })),
            moduleCount: detailRewrite.moduleCount,
            changedCount: detailRewrite.changedCount,
            repairedCount: detailRewrite.repairedCount,
            failedCount: detailRewrite.failedCount,
            droppedCount: detailRewrite.droppedCount || 0,
            // 命中模块级缓存的模块数；全部命中时 duration 只含解析/校验，不含上游
            cachedModules: detailRewrite.cachedCount || 0,
            requestedModules: detailRewrite.requestedModules ?? detailRewrite.moduleCount,
            // 原样透传、未参与重写的游戏事实模块数（任务/经历/关系/结算）
            skippedFacts: rewriteSkippedFacts,
            originalChars: detailRewrite.originalChars,
            rewrittenChars: detailRewrite.rewrittenChars,
            removedCount: detailRewrite.removedCount,
            addedCount: detailRewrite.addedCount,
            usage: detailRewrite.usage || null,
            tokens: detailRewrite.tokens || null,
            timing: { durationMs: detailRewrite.durationMs },
            error: detailRewrite.error || null,
          }
        : null,
      error: null,
    };

    let result;
    try {
      result = await forwardUpstream(finalBody, res, c, {
        injector: castInjector,
        injectorMode: castMode || 'head',
        filterAssistantText,
        wrapPlainContent,
        // 传入当轮 system：截断回复也能按 `## 输出格式` 模板补齐字段，而不是只留 content。
        repairReply: (text) => repairNpcReplyText(text, info.system),
      });
    } catch (err) {
      detail.error = err?.message || String(err);
      logger.append(
        {
          ...baseLog,
          status: 'error',
          injectChars,
          promptChars,
          cast: castLog,
          castChars,
          rewrite: rewriteInfo,
          rewriteTokens,
          warnings,
          durationMs: Date.now() - started,
          error: detail.error,
        },
        detail,
      );
      sendJsonError(res, 502, 'upstream_error', `上游请求失败: ${err?.message || err}`);
      return;
    }

    const parsedA = parseNpcReply(result.assistantText);
    const bLine = castInjector?.bLine || bActor?.line || null;
    // result.assistantText 来自注入后的内容，已包含 B 的台词；重建分段时必须用注入前的 A 正文，
    // 否则 B 的台词会被重复写入展示文本、账本与摘要。
    let aText = castInjector?.inserted ? castInjector.aContentText() : '';
    if (!aText) {
      // 流式兜底等场景拿不到原文：从展示文本里把已知的 B 台词剥掉
      aText = parsedA.content;
      if (castInjector?.inserted && bLine) {
        if (castMode === 'head' && aText.startsWith(bLine)) {
          aText = aText.slice(bLine.length).replace(/^\r?\n/, '');
        } else if (castMode === 'tail' && aText.endsWith(bLine)) {
          aText = aText.slice(0, -bLine.length).replace(/\r?\n$/, '');
        }
      }
    }
    let finalContent = parsedA.content;
    let segments = null;
    if (cast && bCard && bLine) {
      if (castMode === 'head' && castInjector?.inserted) {
        segments = [
          { who: bCard.name, text: bLine },
          { who: aName, text: aText },
        ];
      } else if (castMode === 'tail' && castInjector?.inserted) {
        segments = [
          { who: aName, text: aText },
          { who: bCard.name, text: bLine },
        ];
      }
      if (segments) finalContent = segments.map((s) => s.text).join('\n');
    }

    if (cast && castInjector?.failed) warnings.push('costar_slot_missed');
    // 模型没按 JSON 输出、台词只能拼在纯文本里：游戏端这轮本来就解析不了，记一笔便于排查
    if (cast && castInjector?.inserted && !parsedA.jsonOk) warnings.push('costar_fallback');
    // 槽位缺失时 B 根本没被请求，不能再记“选择沉默”
    if (cast && cast.shouldBSpeak && !bLine && !castInjector?.failed) warnings.push('costar_silent');
    // A 在正文里替在场配角写了台词（非流式会被剥掉，仍记账便于定位）
    if (aImpersonated) warnings.push('cast_a_wrote_costar');
    // 非 JSON 回复：非流式会按当轮输出格式模板包回合法 JSON；流式只能记账
    if (plainWrapped) notes.push('reply_wrapped_json');
    else if (!parsedA.jsonOk) {
      // 流式已经逐字节发出，无法回改；单独记账，便于区分「可修复」与「已发出去」。
      warnings.push(result.isStream ? 'reply_not_json_stream' : 'reply_not_json');
    }
    // 模型违约（双层 JSON / content 内裸引号 / 截断）已由本地修复
    if (result.repaired) warnings.push('reply_repaired');

    const tokens = tokenUsage({
      usage: result.usage,
      messages: finalBody.messages,
      reply: finalContent,
      reasoning: result.reasoningText,
    });
    Object.assign(detail, {
      reasoning: result.reasoningText,
      reasoningTruncated: !!result.reasoningTruncated,
      reply: finalContent,
      usage: result.usage || null,
      tokens,
      timing: detailTiming(result),
      ...(detail.cast
        ? {
            cast: {
              ...detail.cast,
              bLine,
              bLineChars: bLine?.length || 0,
              inserted: !!castInjector?.inserted,
              slotFailed: !!castInjector?.failed,
              segments: segments ? segments.map((s) => s.who) : [],
              // A 先说话时，B 的请求要到流结束才存在：这里补全
              request: bActor?.messages
                ? requestMeta({ model: c.upstream.model, stream: false, messages: bActor.messages })
                : detail.cast.request,
              messages: bActor?.messages
                ? bActor.messages.map((m) => {
                    const content = messageText(m);
                    return { role: m.role, origin: 'internal', content, chars: content.length };
                  })
                : detail.cast.messages,
              reply: bActor?.result?.raw || detail.cast.reply,
              usage: bActor?.result?.usage || detail.cast.usage,
              tokens: bActor?.result
                ? tokenUsage({ usage: bActor.result.usage, messages: bActor.messages, reply: bActor.result.raw })
                : detail.cast.tokens,
              timing: { durationMs: bActor?.result?.durationMs ?? detail.cast.timing?.durationMs ?? null },
              error: bActor?.result?.error || detail.cast.error,
            },
          }
        : {}),
    });

    logger.append(
      {
        ...baseLog,
        status: result.ok ? 'done' : 'upstream_error',
        upstreamStatus: result.status,
        injectChars,
        promptChars,
        cast: castLog,
        castChars,
        rewrite: rewriteInfo,
        rewriteTokens,
        isNewNpc: bundle?.isNew || false,
        snapshotChanged,
        replyJsonOk: parsedA.jsonOk,
        warnings,
        ...(notes.length ? { notes } : {}),
        ttftMs: result.ttftMs,
        reasoningTtftMs: result.reasoningTtftMs,
        contentTtftMs: result.contentTtftMs,
        durationMs: Date.now() - started,
        replyChars: finalContent.length,
        replyPreview: finalContent.slice(0, 500),
        ...tokenFields(tokens),
      },
      detail,
    );

    // —— 落盘：整轮成功后才提交在场状态与对话 ——
    if (castStage && (castStageChanged || castStageTouched) && result.ok) {
      try {
        saveStage(info.slug, castStage);
      } catch (err) {
        logger.append({ kind: 'costar', turnId, status: 'error', error: 'stage_save_failed:' + err.message });
      }
    }

    if (!memEnabled || !bundle || !result.ok || !finalContent.trim()) return;

    queues
      .run('npc:' + info.slug, () => {
        const now = new Date().toISOString();
        const g = info.state || {};
        const common = { ts: now, game_time: g.gameTime || null, scene: g.scene || null };
        appendConversations(bundle.convFile, [
          {
            ...common,
            role: 'player',
            content: modelPlayerText,
            ...(castCommands.length ? { command: info.userText } : {}),
          },
          {
            ...common,
            role: 'npc',
            content: finalContent,
            emotion: parsedA.emotion,
            control: parsedA.control,
            gift_item: parsedA.giftItem,
            reply_json_ok: parsedA.jsonOk,
            variant: info.variant || null,
            ...(segments ? { segments } : {}),
            ...(segments ? { coStar: [bCard.slug] } : {}),
          },
        ]);

        let state;
        try {
          state = JSON.parse(fs.readFileSync(bundle.stateFile, 'utf8'));
        } catch {
          state = bundle.state;
        }
        state.turns = (state.turns || 0) + 1;
        state.lastGame = g;
        // 新版游戏只在相关轮次下发【任务接取】【任务交付】【相关经历】。留下一份待消费副本，
        // 让「这一轮没再下发同样内容」的摘要也能把它们写进长期记忆；摘要成功后清空。
        {
          const merged = mergePendingFacts(state.pendingFacts, g, { turn: state.turns, at: now });
          if (merged) state.pendingFacts = merged;
          else delete state.pendingFacts;
        }
        state.rawNames = state.rawNames || [];
        if (info.rawName && !state.rawNames.includes(info.rawName)) state.rawNames.push(info.rawName);
        if (info.variant && !(state.variants || []).includes(info.variant)) {
          state.variants = state.variants || [];
          state.variants.push(info.variant);
        }
        saveState(bundle.stateFile, state);

        summarizer.maybeRun(info.slug, bundle, state);

        // 配角写记忆（默认关闭）：只写 B 在场且有发言的轮次，带 speaker
        if (segments && bCard && ms.coStarWritesMemory) {
          const bBundle = openNpc(bCard.slug, {});
          appendConversations(bBundle.convFile, [
            {
              ...common,
              role: 'player',
              speaker: '玩家',
              content: modelPlayerText,
              via: 'costar',
              with: [info.slug],
            },
            {
              ...common,
              role: 'npc',
              speaker: bCard.name,
              content: bLine,
              via: 'costar',
              with: [info.slug],
            },
          ]);
          let bState;
          try {
            bState = JSON.parse(fs.readFileSync(bBundle.stateFile, 'utf8'));
          } catch {
            bState = bBundle.state;
          }
          bState.turns = (bState.turns || 0) + 1;
          bState.lastSeen = now;
          bState.lastGame = g;
          saveState(bBundle.stateFile, bState);
          summarizer.maybeRun(bCard.slug, bBundle, bState);
        }
      })
      .catch((err) => {
        logger.append({ kind: 'memory_write', slug: info.slug, status: 'error', error: err?.message || String(err) });
      });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      const normPath = pathname === '' ? '/' : pathname;

      // 健康检查（无需鉴权）
      if (req.method === 'GET' && (normPath === '/health' || normPath === '/v1/health')) {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, service: 'worldapart-npc-agent' }));
        return;
      }

      // 游戏侧 API（Key 鉴权）
      if (normPath === '/v1/chat/completions' || normPath === '/chat/completions') {
        if (req.method !== 'POST') return sendJsonError(res, 405, 'method_not_allowed', '仅支持 POST');
        if (!authed(req)) {
          logger.append({ kind: 'auth', status: 'error', path: normPath, ip: req.socket?.remoteAddress || '' });
          return sendJsonError(res, 401, 'invalid_api_key', 'API Key 无效或缺失');
        }
        const buf = await readBody(req);
        return await handleChat(req, res, buf);
      }

      if (normPath === '/v1/models' || normPath === '/models') {
        if (req.method !== 'GET') return sendJsonError(res, 405, 'method_not_allowed', '仅支持 GET');
        if (!authed(req)) return sendJsonError(res, 401, 'invalid_api_key', 'API Key 无效或缺失');
        res.setHeader('content-type', 'application/json; charset=utf-8');
        return res.end(
          JSON.stringify({ object: 'list', data: [{ id: cfg().server.servedModel, object: 'model', created: 0, owned_by: 'worldapart' }] }),
        );
      }

      // 管理 API / 页面：仅接受本机
      const remote = req.socket?.remoteAddress || '';
      const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!isLocal) return sendJsonError(res, 403, 'forbidden', '管理接口仅允许本机访问');

      if (normPath.startsWith('/api/')) {
        if (normPath === '/api/status' && req.method === 'GET') return handleStatus(req, res);
        if (normPath === '/api/config' && req.method === 'GET') return handleGetConfig(req, res);
        if (normPath === '/api/config' && req.method === 'PUT') return await handlePutConfig(req, res);
        if (normPath === '/api/logs' && req.method === 'GET') {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          return res.end(JSON.stringify({ records: logger.list(Number(url.searchParams.get('limit')) || 300) }));
        }
        const md = normPath.match(/^\/api\/logs\/([^/]+)\/detail$/);
        if (md && req.method === 'GET') {
          let rid;
          try {
            rid = decodeURIComponent(md[1]);
          } catch {
            rid = md[1];
          }
          const detail = logger.getDetail(rid);
          if (!detail) return sendJsonError(res, 404, 'detail_not_found', '详情已过期或不存在');
          res.setHeader('content-type', 'application/json; charset=utf-8');
          return res.end(JSON.stringify({ ok: true, detail }));
        }
        if (normPath === '/api/events' && req.method === 'GET') return handleEvents(req, res);
        // 语音朗读（TTS）
        if (normPath === '/api/tts/voices' && req.method === 'GET') return await handleTtsVoices(req, res, url);
        if (normPath === '/api/tts/install' && req.method === 'POST') return await handleTtsInstall(req, res);
        if (normPath === '/api/tts/install' && req.method === 'GET') return handleTtsInstallStatus(req, res);
        if (normPath === '/api/tts/preview' && req.method === 'POST') return await handleTtsPreview(req, res);
        const mtts = normPath.match(/^\/api\/tts\/audio\/([^/]+)$/);
        if (mtts && req.method === 'GET') return await handleTtsAudio(req, res, mtts[1], url);
        const mvoice = normPath.match(/^\/api\/npcs\/([^/]+)\/voice$/);
        if (mvoice && req.method === 'PUT') return await handlePutNpcVoice(req, res, mvoice[1]);
        if (normPath === '/api/npcs' && req.method === 'GET') return handleNpcList(req, res);
        // 外置提示词：/prompt 为正式路由，/style 保留为旧版兼容别名
        const ms = normPath.match(/^\/api\/npcs\/([^/]+)\/(prompt|style)$/);
        if (ms && req.method === 'PUT') return await handlePutNpcPrompt(req, res, ms[1]);
        const mstage = normPath.match(/^\/api\/npcs\/([^/]+)\/stage$/);
        if (mstage && req.method === 'GET') return handleGetStage(req, res, mstage[1]);
        if (mstage && req.method === 'DELETE') return handleDeleteStage(req, res, mstage[1]);
        const malias = normPath.match(/^\/api\/npcs\/([^/]+)\/aliases$/);
        if (malias && req.method === 'PUT') return await handlePutAliases(req, res, malias[1]);
        const mcast = normPath.match(/^\/api\/npcs\/([^/]+)\/cast$/);
        if (mcast && req.method === 'GET') return handleGetCast(req, res, mcast[1]);
        if (mcast && req.method === 'PUT') return await handlePutCast(req, res, mcast[1]);
        const mr = normPath.match(/^\/api\/npcs\/([^/]+)\/memory\/rewrite$/);
        if (mr && req.method === 'POST') return await handleRewriteMemory(req, res, mr[1]);
        const mp = normPath.match(/^\/api\/npcs\/([^/]+)\/memory$/);
        if (mp && req.method === 'PUT') return await handlePutMemory(req, res, mp[1]);
        const m = normPath.match(/^\/api\/npcs\/([^/]+)$/);
        if (m && req.method === 'GET') return await handleNpcDetail(req, res, m[1]);
        return sendJsonError(res, 404, 'not_found', '未知管理接口');
      }

      // 静态管理页
      if (req.method === 'GET') return serveStatic(req, res, normPath);
      sendJsonError(res, 404, 'not_found', '不支持的请求');
    } catch (err) {
      if (err?.code === 'payload_too_large') return sendJsonError(res, 413, 'payload_too_large', '请求体过大');
      logger.append({ kind: 'server', status: 'error', error: err?.stack || String(err) });
      sendJsonError(res, 500, 'internal_error', err?.message || '内部错误');
    }
  });

  // 空闲兜底：服务起来后开始定期扫描；随服务关闭而停止（定时器已 unref，不会拖住进程退出）
  server.on('close', () => {
    idleFlusher.stop();
    // 语音合成可能正在起 PowerShell：关服时必须杀掉，不能拖住进程退出
    ttsShutdown();
  });
  idleFlusher.start();

  return server;
}
