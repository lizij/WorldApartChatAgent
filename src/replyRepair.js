/**
 * 回复修复（非流式，游戏侧请求为 stream:false 时生效）：
 * 模型偶发不守「只输出一个 JSON」的约定，表现为两类：
 *   1) 把整段游戏 JSON 又包进 `content`（双层 JSON）；
 *   2) 外套 JSON 合法，但 `content` 里直接写了未转义的双引号，导致整段无法解析。
 * 两种情况都会让游戏把原始 JSON 当正文显示。这里做确定性修复：只在“确实像一个
 * 含 content 字段的 JSON”时动手，解析不出来就返回 null（调用方原样转发）。
 */

/** 找 `"content":"` 之后、结构标记之前的内容区间（不能靠扫引号：里面可能有裸引号）。 */
function findContentSpan(text) {
  const m = /"content"\s*:\s*"/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const marks = ['","emotion"', '","control"', '","intent"', '","observe"', '"}}', '"}'];
  let end = -1;
  for (const mark of marks) {
    const i = text.indexOf(mark, start);
    if (i >= 0 && (end < 0 || i < end)) end = i;
  }
  if (end < 0) return null;
  return { start, end };
}

/** 把未转义的双引号补上反斜杠（已经转义的保持不动）。 */
function escapeBareQuotes(s) {
  return String(s).replace(/(?<!\\)"/g, '\\"');
}

/** 尝试把一段“像 JSON”的文本修成合法对象；失败返回 null。 */
function repairJsonish(text) {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.content === 'string') return obj;
  } catch {}
  const span = findContentSpan(text);
  if (!span) return null;
  const fixed =
    text.slice(0, span.start) + escapeBareQuotes(text.slice(span.start, span.end)) + text.slice(span.end);
  try {
    const obj = JSON.parse(fixed);
    return obj && typeof obj.content === 'string' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 修复 NPC 回复文本；返回修复后的 JSON 字符串，无法/无需修复时返回 null。
 * @param {string} text 上游返回的 message.content（即游戏期望的回复 JSON 文本）
 * @returns {string|null}
 */
export function repairNpcReplyText(text) {
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
      if (body.trim()) return JSON.stringify({ content: body, emotion: null, control: null });
    }
  }
  return null;
}
