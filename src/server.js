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
import { DATA_DIR, IS_TEST, PUBLIC_DIR, VERSION, upstreamChatUrl } from './config.js';
import { classify } from './identify.js';
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
  NPCS_DIR,
} from './memory/store.js';
import { buildMemoryText, buildPromptsText, insertBeforeLastUser } from './memory/inject.js';
import { Summarizer } from './memory/summarizer.js';
import { MemoryRewriter } from './memory/rewriter.js';
import { RequestRewriter } from './requestRewrite.js';
import { IdleFlusher } from './memory/idleFlusher.js';
import { forwardUpstream, messageText, sendJsonError, tokenUsage } from './upstream.js';
import { KeyedQueue } from './locks.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 外置提示词字数上限（全局与逐 NPC 同一上限；防止误粘贴超长文本挤占 token）。 */
const PROMPT_MAX_CHARS = 4000;

/** 「AI 修改记忆」一次性指令上限（字）。 */
const MEMORY_EDIT_MAX_CHARS = 4000;

/** 手工保存记忆正文的上限（字）；防止误粘贴超长文本。 */
const MEMORY_TEXT_MAX_CHARS = 200000;

/** 输出格式强化提醒（注入与日志来源标注共用同一常量）。 */
const FORMAT_REMINDER =
  '再次提醒：本轮必须且只能输出系统要求的那个 JSON 对象（不要 JSON 代码围栏、不要解释、不要输出 JSON 之外的文字）。';

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
 * 收集游戏下发的全部纯文本 system 模块（此时尚未注入外置内容）。
 * 真实游戏会把设定拆成多条 system 消息，甚至与历史消息交错，因此必须全部处理。
 */
function collectGameSystemMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || m.role !== 'system' || typeof m.content !== 'string') continue;
    if (!m.content.trim()) continue;
    out.push({ index: i, content: m.content });
  }
  return out;
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

export function createServer({ config, logger }) {
  const queues = new KeyedQueue();
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
        log: c.log,
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
      if (patch.upstream.insecureTLS !== undefined) safe.upstream.insecureTLS = !!patch.upstream.insecureTLS;
      if (patch.upstream.disableThinking !== undefined) safe.upstream.disableThinking = !!patch.upstream.disableThinking;
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
      });
    }
    out.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ npcs: out }));
  }

  function handleNpcDetail(req, res, slugRaw) {
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
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ slug, state, memory, prompt: loadNpcPrompt(slug), conversations }));
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
    let bundle = null;
    let memoryText = '';
    let promptsText = '';
    let injectChars = 0;
    let promptChars = 0;
    let snapshotChanged = false;
    const warnings = [];
    // 记录注入内容 → 来源，用于日志详情标注「游戏原始 / 游戏重写后 / 外置记忆 / 外置提示词 / 格式提醒」
    const injected = new Map();
    let rewriteInfo = null;
    let detailRewrite = null;
    let rewriteTokens = null;

    // 客户端断开时中止重写调用，避免白白消耗 token
    const clientAc = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) clientAc.abort();
    });

    try {
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
          maxChars: c.memory.injectMaxChars,
        });
      }

      // 外置设定提示词：玩家设定的全局 + 逐 NPC 个人提示词，独立于记忆开关。
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

      // 请求重写（实验性）：先改写游戏的全部 system 模块，再注入外置内容——
      // 这样外置内容不会被模型二次改写，且注入位置仍在重写结果之后。
      if (c.requestRewrite.enabled && (memoryText || promptsText)) {
        const systems = collectGameSystemMessages(body.messages);
        if (!systems.length) {
          warnings.push('rewrite_skipped:no_text_system');
        } else {
          try {
            const rw = await requestRewriter.rewrite({
              slug: info.slug,
              systems,
              memoryText,
              promptsText,
              signal: clientAc.signal,
            });
            rewriteTokens = rw.tokens?.total ?? null;
            rewriteInfo = {
              status: rw.status,
              durationMs: rw.durationMs,
              tokens: rw.tokens || null,
              modules: rw.moduleCount,
              changedModules: rw.changedCount,
              failedModules: rw.failedCount,
              originalChars: rw.originalChars,
              rewrittenChars: rw.rewrittenChars,
              removedLines: rw.removedCount,
              addedLines: rw.addedCount,
              ...(rw.error ? { error: rw.error } : {}),
            };
            // 失败时也保留草稿，便于在详情里排查
            detailRewrite = rw;
            if (rw.ok) {
              const messages = body.messages.slice();
              for (const item of rw.items) {
                if (!item.ok) {
                  warnings.push(`rewrite_failed:module${item.id}:${item.error}`);
                  continue;
                }
                if (!item.changed) continue;
                messages[item.index] = { ...messages[item.index], content: item.rewritten };
                injected.set(item.rewritten, 'game_rewritten');
              }
              body = { ...body, messages };
            } else {
              warnings.push('rewrite_failed:' + (rw.error || 'unknown'));
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

      // 注入顺序：记忆 → 外置提示词（后者更靠近玩家本轮，权重更高）
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

      // 格式强化：实测 flash 偶发不遵守「## 输出格式」而回纯文本。
      // 在最后一条 user 消息前补一条极简提醒（不改动游戏原始消息），保持真流式。
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
    } catch (err) {
      warnings.push('memory_init_failed:' + err.message);
      bundle = null;
    }

    const finalBody = prepareUpstreamBody(body, c);
    const detail = {
      kind: 'npc',
      request: requestMeta(finalBody),
      messages: buildDetailMessages(finalBody.messages, injected),
      reasoning: '',
      reasoningTruncated: false,
      reply: '',
      usage: null,
      tokens: null,
      timing: {},
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
              index: x.index,
              title: x.title,
              status: x.ok ? 'done' : 'failed',
              changed: !!x.changed,
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
            failedCount: detailRewrite.failedCount,
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
      result = await forwardUpstream(finalBody, res, c);
    } catch (err) {
      detail.error = err?.message || String(err);
      logger.append(
        {
          ...baseLog,
          status: 'error',
          injectChars,
          promptChars,
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
        status: result.ok ? 'done' : 'upstream_error',
        upstreamStatus: result.status,
        injectChars,
        promptChars,
        rewrite: rewriteInfo,
        rewriteTokens,
        isNewNpc: bundle?.isNew || false,
        snapshotChanged,
        warnings,
        ttftMs: result.ttftMs,
        reasoningTtftMs: result.reasoningTtftMs,
        contentTtftMs: result.contentTtftMs,
        durationMs: Date.now() - started,
        replyChars: result.assistantText.length,
        replyPreview: result.assistantText.slice(0, 500),
        ...tokenFields(tokens),
      },
      detail,
    );

    if (!memEnabled || !bundle || !result.ok || !result.assistantText.trim()) return;

    queues
      .run('npc:' + info.slug, () => {
        const now = new Date().toISOString();
        const g = info.state || {};
        const parsed = parseNpcReply(result.assistantText);
        const common = { ts: now, game_time: g.gameTime || null, scene: g.scene || null };
        appendConversations(bundle.convFile, [
          { ...common, role: 'player', content: info.userText },
          {
            ...common,
            role: 'npc',
            content: parsed.content,
            emotion: parsed.emotion,
            control: parsed.control,
            gift_item: parsed.giftItem,
            reply_json_ok: parsed.jsonOk,
            variant: info.variant || null,
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
        state.rawNames = state.rawNames || [];
        if (info.rawName && !state.rawNames.includes(info.rawName)) state.rawNames.push(info.rawName);
        if (info.variant && !(state.variants || []).includes(info.variant)) {
          state.variants = state.variants || [];
          state.variants.push(info.variant);
        }
        saveState(bundle.stateFile, state);

        summarizer.maybeRun(info.slug, bundle, state);
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
        if (normPath === '/api/npcs' && req.method === 'GET') return handleNpcList(req, res);
        // 外置提示词：/prompt 为正式路由，/style 保留为旧版兼容别名
        const ms = normPath.match(/^\/api\/npcs\/([^/]+)\/(prompt|style)$/);
        if (ms && req.method === 'PUT') return await handlePutNpcPrompt(req, res, ms[1]);
        const mr = normPath.match(/^\/api\/npcs\/([^/]+)\/memory\/rewrite$/);
        if (mr && req.method === 'POST') return await handleRewriteMemory(req, res, mr[1]);
        const mp = normPath.match(/^\/api\/npcs\/([^/]+)\/memory$/);
        if (mp && req.method === 'PUT') return await handlePutMemory(req, res, mp[1]);
        const m = normPath.match(/^\/api\/npcs\/([^/]+)$/);
        if (m && req.method === 'GET') return handleNpcDetail(req, res, m[1]);
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
  server.on('close', () => idleFlusher.stop());
  idleFlusher.start();

  return server;
}
