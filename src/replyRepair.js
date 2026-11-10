/**
 * 回复修复（非流式，游戏侧请求为 stream:false 时生效）：
 * 模型偶发不守「只输出一个 JSON」的约定，表现为三类：
 *   1) 把整段游戏 JSON 又包进 `content`（双层 JSON）；
 *   2) 外套 JSON 合法，但 `content` 里直接写了未转义的双引号，导致整段无法解析；
 *   3) 输出被截断（`{"content":"…` 没有收尾）。
 * 这三种都会让游戏把原始 JSON 当正文显示。这里做确定性修复：只在“确实像一个
 * 含 content 字段的 JSON”时动手，解析不出来就返回 null（调用方原样转发）。
 *
 * 2026-11 游戏更新后 `## 输出格式` 的字段会增删（observe / control 枚举随当轮变化），
 * 因此不再硬编码 `","emotion"` 之类的分隔串，而是扫描“任何合法字段边界”。
 */
import { wrapPlainReply } from './requestRewrite.js';

/** `"content"` 值的起始位置（第一个字符之后）。 */
function contentValueStart(text) {
  const m = /"content"\s*:\s*"/.exec(text);
  return m ? m.index + m[0].length : -1;
}

/** 某个引号是否被反斜杠转义（只看紧邻的连续反斜杠）。 */
function isEscaped(text, i, from) {
  let bs = 0;
  for (let j = i - 1; j >= from && text[j] === '\\'; j -= 1) bs += 1;
  return bs % 2 === 1;
}

/**
 * 找出所有“可能是 content 结束引号”的位置：其后紧跟 `, "字段名":` 或 `}`。
 * 不依赖字段名与顺序，新格式多出 observe / 少掉 control 都能识别。
 */
function candidateContentEnds(text, start) {
  const out = [];
  for (let i = start; i < text.length; i += 1) {
    if (text[i] !== '"') continue;
    if (isEscaped(text, i, start)) continue;
    const rest = text.slice(i + 1, i + 120);
    if (/^\s*(?:,\s*"[^"\\\r\n]{1,40}"\s*:|})/.test(rest)) out.push(i);
  }
  return out;
}

/** 把未转义的双引号补上反斜杠（已经转义的保持不动）。 */
function escapeBareQuotes(s) {
  return String(s).replace(/(?<!\\)"/g, '\\"');
}

/**
 * 尝试把一段“像 JSON”的文本修成合法对象；失败返回 null。
 * 从最早的候选结束引号往后试：先按「content 之后的第一个字段边界」切分。
 * 反过来从最后一个引号试，会把 `","emotion":"happy",…` 整段吞进 content——
 * 虽然也能解析成功，但游戏会把这串字段名当正文显示。
 */
function repairJsonish(text) {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.content === 'string') return obj;
  } catch {}
  const start = contentValueStart(text);
  if (start < 0) return null;
  const ends = candidateContentEnds(text, start);
  for (const end of ends) {
    const fixed =
      text.slice(0, start) + escapeBareQuotes(text.slice(start, end)) + text.slice(end);
    try {
      const obj = JSON.parse(fixed);
      if (obj && typeof obj.content === 'string') return obj;
    } catch {}
  }
  return null;
}

/**
 * 修复 NPC 回复文本；返回修复后的 JSON 字符串，无法/无需修复时返回 null。
 * @param {string} text 上游返回的 message.content（即游戏期望的回复 JSON 文本）
 * @param {string} [system] 当轮游戏 system；提供时，截断回复会按 `## 输出格式` 模板补齐字段
 * @returns {string|null}
 */
export function repairNpcReplyText(text, system = '') {
  const src = String(text ?? '').trim();
  if (!src.startsWith('{')) return null;

  // 1) 双层 JSON：外层合法，content 是一整段 JSON 文本
  let outer = null;
  try {
    outer = JSON.parse(src);
  } catch {}
  if (outer && typeof outer.content === 'string' && outer.content.trim().startsWith('{')) {
    const inner = repairJsonish(outer.content.trim());
    if (inner) return JSON.stringify(inner);
  }

  // 2) 外壳本身就非法（content 里有裸引号）：原样修复
  try {
    JSON.parse(src);
    return null; // 本来就合法，不动
  } catch {}
  const fixed = repairJsonish(src);
  if (fixed) return JSON.stringify(fixed);

  // 3) 被截断的 JSON：只有 `{"content":"…` 开头、没有收尾
  const head = /^\{\s*"content"\s*:\s*"/.exec(src);
  if (head) {
    let body = src.slice(head[0].length);
    if (!body.includes('","')) {
      body = body.replace(/"\s*\}?\s*$/, ''); // 已有结尾引号/花括号就剥掉
      if (body.trim()) {
        // 有当轮模板时按模板补全字段（emotion/control/intent…），避免游戏读到缺字段的 JSON。
        const packed = system ? wrapPlainReply(body, system) : null;
        if (packed) return packed;
        return JSON.stringify({ content: body });
      }
    }
  }
  return null;
}
