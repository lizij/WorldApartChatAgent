/**
 * 流内台词插入：
 * 上游 SSE 的 delta.content 是**整段回复 JSON 的字符流**（例如 `{"content":"…","emotion":"…"}`），
 * 因此 B 的台词必须插进 `content` 字符串值内部，而不是拼在 JSON 外层。
 *
 * 本模块只做两件事：
 *  1) 用极小的状态机定位第一个顶层 `"content":"` 与它的闭合引号；
 *  2) 在正确位置插入 **JSON 转义后** 的配角台词。
 *
 * 缓冲：B 先说话时，先按住最多 256 字符以定位开头（通常第一个事件就命中）；
 * A 先说话时，只在闭合引号处按住当前片段，等 B 就绪（有超时）。
 */

const CONTENT_RE = /"content"\s*:\s*"/;
const HEAD_HOLD_MAX = 256;

export function escapeJsonText(text) {
  return String(text ?? '').replace(/[\\"\u0000-\u001f]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
    }
  });
}

export function unescapeJsonText(text) {
  const s = String(text ?? '');
  return s.replace(/\\(\\|"|\/|b|f|n|r|t|u[0-9a-fA-F]{4})/g, (m, g) => {
    if (g === 'n') return '\n';
    if (g === 'r') return '\r';
    if (g === 't') return '\t';
    if (g === 'b') return '\b';
    if (g === 'f') return '\f';
    if (g === '\\' || g === '"' || g === '/') return g;
    if (g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
    return m;
  });
}

function withTimeout(promise, ms, fallback = null) {
  if (!promise) return Promise.resolve(fallback);
  if (!ms || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(fallback), ms);
      if (typeof t?.unref === 'function') t.unref();
    }),
  ]);
}

export class ContentInjector {
  /**
   * @param {'head'|'tail'} mode head = B 先说话；tail = A 先说话、B 接话
   * @param {string|null} line head 模式下预先拿到的 B 台词（已清洗，未转义）
   * @param {(aContent:string)=>Promise<string|null>} getLine tail 模式下拿到 A 内容后再请求 B
   * @param {number} waitMs tail 模式等待 B 的上限
   */
  constructor({ mode = 'head', line = null, getLine = null, waitMs = 3000 } = {}) {
    this.mode = mode;
    this.line = line;
    this.getLine = getLine;
    this.waitMs = waitMs;

    this.state = 0; // 0=定位 content 开头；1=content 内；2=已结束
    this.pending = ''; // 定位阶段按住的小缓冲
    this.escapedContent = ''; // content 的转义原文（用于还原 A 文本）
    this.inserted = false;
    this.failed = false;
    this.bLine = mode === 'head' ? line : null;
    this.escapeBuf = '';
  }

  /** 拼接要插入的片段（已转义）。head 在台词后补换行；tail 在台词前补换行。 */
  #piece() {
    if (!this.bLine) return '';
    const esc = escapeJsonText(this.bLine);
    if (this.mode === 'head') return esc + '\\n';
    return (this.escapedContent ? '\\n' : '') + esc;
  }

  async feed(fragment) {
    const frag = String(fragment ?? '');
    if (!frag) return '';
    let out = '';

    if (this.state === 0) {
      this.pending += frag;
      const m = CONTENT_RE.exec(this.pending);
      if (!m) {
        if (this.mode === 'head') {
          if (this.pending.length > HEAD_HOLD_MAX) {
            // 结构不符（不是预期的 JSON），B 已经观测过，不能只显示 A → 标记失败
            this.failed = true;
            const all = this.pending;
            this.pending = '';
            return all;
          }
          return '';
        }
        // tail 模式：可以先把旧字节放出去，只留下可能跨片的尾部
        const keep = 24;
        if (this.pending.length > keep) {
          out += this.pending.slice(0, this.pending.length - keep);
          this.pending = this.pending.slice(-keep);
        }
        return out;
      }
      const headEnd = m.index + m[0].length;
      out += this.pending.slice(0, headEnd);
      this.state = 1;
      if (this.mode === 'head' && this.bLine) {
        out += this.#piece();
        this.inserted = true;
      }
      const rest = this.pending.slice(headEnd);
      this.pending = '';
      return out + (await this.#feedContent(rest));
    }

    if (this.state === 1) return await this.#feedContent(frag);
    return frag;
  }

  async #feedContent(fragment) {
    if (!fragment) return '';
    if (this.escapeBuf) {
      fragment = this.escapeBuf + fragment;
      this.escapeBuf = '';
    }
    let out = '';
    let i = 0;
    while (i < fragment.length) {
      const ch = fragment[i];
      if (ch === '\\') {
        // 转义序列可能被 delta 边界切开：先攒着，等下一段再处理
        const nxt = fragment[i + 1];
        if (nxt == null) {
          this.escapeBuf = fragment.slice(i);
          return out;
        }
        const len = nxt === 'u' ? 6 : 2;
        if (i + len > fragment.length) {
          this.escapeBuf = fragment.slice(i);
          return out;
        }
        const seg = fragment.slice(i, i + len);
        this.escapedContent += seg;
        out += seg;
        i += len;
        continue;
      }
      if (ch === '"') {
        // content 字符串结束
        if (this.mode === 'tail' && !this.inserted) {
          const aContent = unescapeJsonText(this.escapedContent);
          let line = null;
          try {
            line = await withTimeout(
              Promise.resolve(this.getLine ? this.getLine(aContent) : null),
              this.waitMs,
              null,
            );
          } catch {
            line = null;
          }
          if (line) {
            this.bLine = line;
            out += this.#piece();
            this.inserted = true;
          }
        }
        out += ch;
        i += 1;
        this.state = 2;
        out += fragment.slice(i);
        return out;
      }
      this.escapedContent += ch;
      out += ch;
      i += 1;
    }
    return out;
  }

  /** 流结束后调用：返回还压着的字节；结构不完整时标记失败。 */
  async finish() {
    const rest = this.pending + this.escapeBuf;
    this.pending = '';
    this.escapeBuf = '';
    if (this.state === 0 || this.state === 1) this.failed = true;
    return rest;
  }

  /** A 的正文（未转义）。流结束时才完整。 */
  aContentText() {
    return unescapeJsonText(this.escapedContent);
  }
}

/** 非流式响应：对整段回复文本做同样的插入。 */
export async function injectIntoWholeText(text, opts) {
  const injector = new ContentInjector(opts);
  const out = (await injector.feed(text)) + (await injector.finish());
  return { text: out, injector };
}
