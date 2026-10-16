/**
 * 上游转发：把（可能已注入记忆的）请求体转发给真实 Provider，
 * 流式响应原样直通客户端，同时旁路 Tee 解析出 assistant 文本用于落盘。
 */
import { upstreamChatUrl } from './config.js';

const RESPONSE_STRIP = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

/** 从 SSE data 行累积 assistant 文本。 */
function createSseCapture() {
  let text = '';
  let pending = Buffer.alloc(0);

  let sawContent = false;
  function feed(buf, onContent) {
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
          const piece = obj.choices?.[0]?.delta?.content;
          if (typeof piece === 'string' && piece) {
            text += piece;
            if (!sawContent) {
              sawContent = true;
              onContent?.();
            }
          }
        } catch {}
      }
    }
  }

  return { feed, text: () => text };
}

/**
 * 转发并直通响应。
 * @returns {Promise<{status:number, ok:boolean, isStream:boolean, assistantText:string, ttftMs:number, contentTtftMs:number, durationMs:number}>}
 */
export async function forwardUpstream(body, clientRes, config, { onFirstByte, onFirstContent } = {}) {
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
    if (typeof clientRes.flushHeaders === 'function') clientRes.flushHeaders();

    const touchIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ac.abort(new Error('上游空闲超时')), up.requestTimeoutMs || 300000);
    };
    touchIdle();

    let assistantText = '';
    let ttftMs = null;
    let contentTtftMs = null;
    const markFirst = () => {
      if (ttftMs == null) {
        ttftMs = Date.now() - started;
        onFirstByte?.(ttftMs);
      }
    };
    const markContent = () => {
      if (contentTtftMs == null) {
        contentTtftMs = Date.now() - started;
        onFirstContent?.(contentTtftMs);
      }
    };
    if (isStream) {
      const cap = createSseCapture();
      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) {
          touchIdle();
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          markFirst();
          cap.feed(buf, markContent);
          clientRes.write(buf);
        }
      }
      assistantText = cap.text();
    } else {
      const raw = await upstreamRes.text();
      markFirst();
      clientRes.write(raw);
      try {
        const j = JSON.parse(raw);
        assistantText = j.choices?.[0]?.message?.content || '';
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
      ttftMs,
      contentTtftMs,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    settled = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
