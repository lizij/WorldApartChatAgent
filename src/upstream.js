/**
 * 上游转发：把（可能已注入记忆的）请求体转发给真实 Provider，
 * 流式响应原样直通客户端，同时旁路 Tee 解析出 assistant 文本用于落盘。
 */
import { upstreamChatUrl } from './config.js';

/** 从消息里取纯文本（兼容 string / content 数组）。 */
export function messageText(m) {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) {
    return m.content
      .map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

/** 粗估 token：实测中文约 1.4 汉字/token，其他字符按 4 字符/token。 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.ceil(cjk / 1.4 + (s.length - cjk) / 4);
}

/** 从单个上游 usage 对象取总数；取不到返回 null。 */
export function usageTotal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = Number(raw.total_tokens);
  if (Number.isFinite(total) && total >= 0) return total;
  const prompt = Number(raw.prompt_tokens);
  const completion = Number(raw.completion_tokens);
  if (Number.isFinite(prompt) && Number.isFinite(completion)) return prompt + completion;
  return null;
}

/**
 * 计算日志展示用的 token 总数。
 * 有上游 usage 用精确值；没有则按消息 + 回复 + 思维链字符数估算（estimated=true）。
 * @returns {{total:number, estimated:boolean}}
 */
export function tokenUsage({ usage, messages, reply = '', reasoning = '' }) {
  const exact = usageTotal(usage);
  if (exact != null) return { total: exact, estimated: false };

  let prompt = 0;
  if (Array.isArray(messages)) {
    for (const m of messages) prompt += estimateTokens(messageText(m)) + 4;
  }
  const completion = estimateTokens(reply) + estimateTokens(reasoning);
  return { total: prompt + completion, estimated: true };
}

/** 多次调用（摘要超限重试）的 usage 总数；全部有精确值时返回精确值。 */
export function sumUsageTotals(list) {
  let total = 0;
  let seen = false;
  for (const raw of Array.isArray(list) ? list : [list]) {
    const n = usageTotal(raw);
    if (n != null) {
      total += n;
      seen = true;
    }
  }
  return seen ? total : null;
}

const RESPONSE_STRIP = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

/** 思维链捕获上限：详情本身还有总字数上限，这里避免异常上游无限累积。 */
const MAX_CAPTURE_REASONING = 128 * 1024;

/** 从 SSE data 行累积 assistant 文本、思维链与 usage。 */
function createSseCapture() {
  let text = '';
  let reasoning = '';
  let usage = null;
  let pending = Buffer.alloc(0);

  let sawContent = false;
  let sawReasoning = false;
  let reasoningTruncated = false;

  /** 返回 true 表示这是第一段思维链。 */
  function appendReasoning(piece) {
    const room = MAX_CAPTURE_REASONING - reasoning.length;
    if (room > 0) {
      reasoning += piece.slice(0, room);
      if (piece.length > room) reasoningTruncated = true;
    } else {
      reasoningTruncated = true;
    }
    if (!sawReasoning) {
      sawReasoning = true;
      return true;
    }
    return false;
  }

  function feed(buf, onContent, onReasoning) {
    pending = pending.length ? Buffer.concat([pending, buf]) : buf;
    for (;;) {
      const idxLF = pending.indexOf('\n\n');
      const idxCRLF = pending.indexOf('\r\n\r\n');
      let idx = idxLF;
      if (idxCRLF >= 0 && (idx < 0 || idxCRLF < idx)) idx = idxCRLF;
      if (idx < 0) break;
      const eventBuf = pending.subarray(0, idx);
      pending = pending.subarray(idx + 2);
      for (const rawLine of eventBuf.toString('utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          if (obj?.usage && typeof obj.usage === 'object') usage = obj.usage;
          const delta = obj?.choices?.[0]?.delta;
          const piece = delta?.content;
          if (typeof piece === 'string' && piece) {
            text += piece;
            if (!sawContent) {
              sawContent = true;
              onContent?.();
            }
          }
          const rp =
            typeof delta?.reasoning_content === 'string'
              ? delta.reasoning_content
              : typeof delta?.reasoning === 'string'
                ? delta.reasoning
                : typeof obj?.choices?.[0]?.reasoning_content === 'string'
                  ? obj.choices[0].reasoning_content
                  : '';
          if (rp && appendReasoning(rp)) onReasoning?.();
        } catch {}
      }
    }
  }

  return {
    feed,
    text: () => text,
    reasoning: () => reasoning,
    usage: () => usage,
    reasoningTruncated: () => reasoningTruncated,
  };
}

/**
 * 转发并直通响应。
 * @param {object} options
 * @param {object} [options.injector] 共演台词注入器（ContentInjector）：有它时启用流内改写，其余情况逐字节直通
 * @param {'head'|'tail'} [options.injectorMode]
 * @returns {Promise<{status:number, ok:boolean, isStream:boolean, assistantText:string, reasoningText:string, usage:object|null, reasoningTruncated:boolean, ttftMs:number, reasoningTtftMs:number, contentTtftMs:number, durationMs:number, injected:boolean}>}
 */
export async function forwardUpstream(
  body,
  clientRes,
  config,
  {
    onFirstByte,
    onFirstContent,
    onFirstReasoning,
    injector = null,
    injectorMode = 'head',
    filterAssistantText = null,
    wrapPlainContent = null,
    repairReply = null,
  } = {},
) {
  const up = config.upstream;
  const url = upstreamChatUrl(up.baseUrl);
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('上游总超时')), up.requestTimeoutMs || 300000);
  let idleTimer = null;
  let settled = false;

  clientRes.on('close', () => {
    if (!settled && !clientRes.writableEnded) ac.abort(new Error('客户端已断开'));
  });

  try {
    let upstreamRes;
    const connectTimer = setTimeout(
      () => ac.abort(new Error('连接上游超时')),
      up.connectTimeoutMs || 15000,
    );
    try {
      upstreamRes = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: body.stream ? 'text/event-stream' : 'application/json',
          authorization: `Bearer ${up.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
        redirect: 'manual',
      });
    } finally {
      clearTimeout(connectTimer);
    }

    const ct = upstreamRes.headers.get('content-type') || '';
    const isStream = ct.includes('text/event-stream');

    clientRes.statusCode = upstreamRes.status;
    for (const [k, v] of upstreamRes.headers) {
      if (RESPONSE_STRIP.has(k.toLowerCase())) continue;
      try {
        clientRes.setHeader(k, v);
      } catch {}
    }
    if (isStream) {
      clientRes.setHeader('cache-control', 'no-cache, no-transform');
      clientRes.setHeader('connection', 'keep-alive');
      clientRes.setHeader('x-accel-buffering', 'no');
    }
    // head 模式要先确认能定位 content 再发头，避免失败时已经 flush 无法回错误
    const delayHeaders = !!injector && injectorMode === 'head';
    if (!delayHeaders && typeof clientRes.flushHeaders === 'function') clientRes.flushHeaders();

    const touchIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ac.abort(new Error('上游空闲超时')), up.requestTimeoutMs || 300000);
    };
    touchIdle();

    let assistantText = '';
    let reasoningText = '';
    let usage = null;
    let reasoningTruncated = false;
    let ttftMs = null;
    let reasoningTtftMs = null;
    let contentTtftMs = null;
    let headersFlushed = !delayHeaders;
    let injected = false;
    let repaired = false;
    const markFirst = () => {
      if (ttftMs == null) {
        ttftMs = Date.now() - started;
        onFirstByte?.(ttftMs);
      }
    };
    const markReasoning = () => {
      if (reasoningTtftMs == null) {
        reasoningTtftMs = Date.now() - started;
        onFirstReasoning?.(reasoningTtftMs);
      }
    };
    const markContent = () => {
      if (contentTtftMs == null) {
        contentTtftMs = Date.now() - started;
        onFirstContent?.(contentTtftMs);
      }
    };

    const flushHeadersOnce = () => {
      if (headersFlushed) return;
      headersFlushed = true;
      if (typeof clientRes.flushHeaders === 'function') clientRes.flushHeaders();
    };

    if (isStream) {
      const cap = createSseCapture();
      if (upstreamRes.body) {
        if (!injector) {
          for await (const chunk of upstreamRes.body) {
            touchIdle();
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            markFirst();
            cap.feed(buf, markContent, markReasoning);
            clientRes.write(buf);
          }
        } else {
          const sse = createSseInjector({ injector, injectorMode, clientRes, flushHeadersOnce });
          for await (const chunk of upstreamRes.body) {
            touchIdle();
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            markFirst();
            cap.feed(buf, markContent, markReasoning);
            await sse.feed(buf);
          }
          await sse.finish();
          injected = !!injector.inserted;
          if (injector.failed && injectorMode === 'head' && !sse.wroteAny()) {
            throw new Error('配角台词插入失败：未能定位 content 字段');
          }
        }
      }
      assistantText = cap.text();
      reasoningText = cap.reasoning();
      usage = cap.usage();
      reasoningTruncated = cap.reasoningTruncated();
    } else {
      const raw = await upstreamRes.text();
      markFirst();
      let out = raw;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {}
      const msg = parsed?.choices?.[0]?.message;
      if (msg && typeof msg.content === 'string') {
        let content = msg.content;
        // 非流式：先修复模型违约的回复（双层 JSON / content 内裸引号 / 截断），
        // 否则游戏端会把原始 JSON 当正文显示。
        if (typeof repairReply === 'function') {
          const fixed = repairReply(content);
          if (typeof fixed === 'string' && fixed && fixed !== content) {
            content = fixed;
            repaired = true;
          }
        }
        // 非流式：可先做确定性清理（例如剥掉 A 替配角写的台词），再注入/兜底包装。
        if (typeof filterAssistantText === 'function') {
          const filtered = filterAssistantText(content);
          if (typeof filtered === 'string' && filtered) content = filtered;
        }
        if (injector) {
          // 非流式：整段文本一次注入（含 JSON 槽位定位与纯文本兜底）
          content = await injector.injectWholeText(content);
          injected = !!injector.inserted;
          if (injector.failed && injectorMode === 'head') {
            throw new Error('配角台词插入失败：未能定位 content 字段');
          }
        }
        if (typeof wrapPlainContent === 'function') {
          const wrapped = wrapPlainContent(content);
          if (typeof wrapped === 'string' && wrapped) content = wrapped;
        }
        msg.content = content;
        out = JSON.stringify(parsed);
      }
      flushHeadersOnce();
      clientRes.write(out);
      try {
        const j = JSON.parse(out);
        assistantText = j.choices?.[0]?.message?.content || '';
        reasoningText =
          j.choices?.[0]?.message?.reasoning_content || j.choices?.[0]?.message?.reasoning || '';
        usage = j.usage || null;
        if (reasoningText) markReasoning();
      } catch {}
    }
    if (assistantText) markContent();

    if (idleTimer) clearTimeout(idleTimer);
    settled = true;
    clientRes.end();
    return {
      status: upstreamRes.status,
      ok: upstreamRes.ok,
      isStream,
      assistantText,
      reasoningText,
      usage,
      reasoningTruncated,
      ttftMs,
      reasoningTtftMs,
      contentTtftMs,
      durationMs: Date.now() - started,
      injected,
      repaired,
    };
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    settled = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SSE 注入器：解析事件 → 取 delta.content → 过 ContentInjector → 重新合成事件写回。
 * 只在共演模式下使用；普通请求仍走原始字节直通。
 */
function createSseInjector({ injector, injectorMode, clientRes, flushHeadersOnce }) {
  let pending = Buffer.alloc(0);
  let envelope = null;
  let wrote = false;
  // head 模式：定位到 content 之前不向客户端写任何字节，失败时才能干净地回错误
  const held = [];

  const writeRaw = (text) => {
    flushHeadersOnce();
    clientRes.write(text);
    wrote = true;
  };

  const writeEvent = (obj, outText) => {
    const next = JSON.parse(JSON.stringify(obj));
    const choice = Array.isArray(next.choices) ? next.choices[0] : null;
    if (choice) {
      choice.delta = { content: outText };
      choice.finish_reason = null;
      if (choice.index == null) choice.index = 0;
    }
    writeRaw(`data: ${JSON.stringify(next)}\n\n`);
  };

  const flushText = (text) => {
    if (!text) return;
    if (!envelope) {
      // 还没有可复制的信封：构造一个最小 OpenAI chunk
      writeEvent({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: null }] }, text);
      return;
    }
    writeEvent(envelope, text);
  };

  const flushHeld = () => {
    if (!held.length) return;
    for (const item of held) writeRaw(item);
    held.length = 0;
  };

  const holdOrWrite = (raw) => {
    if (injectorMode === 'head' && !injector.inserted && !injector.failed) held.push(raw);
    else writeRaw(raw);
  };

  const handleEvent = async (eventBuf) => {
    const text = eventBuf.toString('utf8');
    const lines = text.split(/\r?\n/);
    const dataLines = lines.filter((l) => l.trim().startsWith('data:'));
    if (!dataLines.length) {
      holdOrWrite(text + '\n\n');
      return;
    }
    let payload = '';
    for (const l of dataLines) payload += l.trim().slice(5).trim();
    if (!payload || payload === '[DONE]') {
      holdOrWrite(text + '\n\n');
      return;
    }
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      holdOrWrite(text + '\n\n');
      return;
    }
    const delta = obj?.choices?.[0]?.delta;
    if (!delta || typeof delta.content !== 'string') {
      // 没有正文（例如只有 reasoning 或 usage）：原样转发；head 模式下先按住
      if (injectorMode === 'head' && !injector.inserted && !injector.failed) held.push(`data: ${JSON.stringify(obj)}\n\n`);
      else writeRaw(`data: ${JSON.stringify(obj)}\n\n`);
      return;
    }
    envelope = obj;
    const emitted = await injector.feed(delta.content);
    if (injector.failed && injectorMode === 'head' && !wrote) {
      // 交给上层抛错，此时尚未写出任何字节
      return;
    }
    if (injector.inserted) flushHeld();
    flushText(emitted);
  };

  return {
    async feed(buf) {
      pending = pending.length ? Buffer.concat([pending, buf]) : buf;
      for (;;) {
        const idxLF = pending.indexOf('\n\n');
        const idxCRLF = pending.indexOf('\r\n\r\n');
        let idx = idxLF;
        let sep = 2;
        if (idxCRLF >= 0 && (idx < 0 || idxCRLF < idx)) {
          idx = idxCRLF;
          sep = 4;
        }
        if (idx < 0) break;
        const eventBuf = pending.subarray(0, idx);
        pending = pending.subarray(idx + sep);
        await handleEvent(eventBuf);
      }
    },
    async finish() {
      if (pending.length) {
        await handleEvent(pending);
        pending = Buffer.alloc(0);
      }
      const rest = await injector.finish();
      // 流里始终没出现可定位的 content 槽（模型回了纯文本）：兜底把 B 的台词补进正文，
      // 而不是丢掉这一轮或整轮作废。
      if (injector.failed && !injector.inserted) {
        const aText = injector.aContentText();
        const line = await injector.resolveLine(aText);
        if (line) {
          injector.bLine = line;
          injector.inserted = true;
          injector.failed = false;
          injector.plainContent = aText || null;
          if (injectorMode === 'head') {
            flushText(line + '\n');
            flushHeld();
            if (rest) flushText(rest);
          } else {
            flushHeld();
            if (rest) flushText(rest);
            flushText('\n' + line);
          }
          return;
        }
      }
      // head 模式没定位到 content：不能把半截字节写出去，交给上层整轮作废
      if (injectorMode === 'head' && injector.failed) {
        held.length = 0;
        return;
      }
      flushHeld();
      if (rest) flushText(rest);
    },
    wroteAny: () => wrote,
  };
}

export function sendJsonError(res, status, code, message) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      error: { message, type: 'worldapart_npc_agent_error', code },
    }),
  );
}
