/**
 * 朗读文本清洗：纯函数，无 IO，便于模块级回归。
 *
 * 处理顺序（每一步都可单独测试）：
 *   1) JSON 兜底解包 —— 流式路径下 parsedA.content 可能仍是内层 JSON
 *   2) 去 markdown / 表情
 *   3) 按模式抽取：all（全部）或 dialogue（只抽对白）
 *   4) 截断到 maxChars（按句切，不切半个词）
 *
 * 任何一步得到空结果都返回 ok:false，调用方据此跳过合成
 * （实测空文本会产出 46 字节的空 WAV）。
 */

/** 语音引擎不支持的表情/符号：只保留有读音的字符。 */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

/** markdown 标记（标题、强调、引用、列表、代码围栏、行内代码）。 */
function stripMarkdown(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/(^|[\s（(])\*([^*\n]+)\*(?=$|[\s，。！？）)])/g, '$1$2')
    .replace(/~~([^~]*)~~/g, '$1');
}

/**
 * 全角/半角括号内容的删除，支持一层嵌套。
 * 例：「（她抿了口茶（很轻））你好」→「你好」
 */
function stripBrackets(s) {
  let out = '';
  let depth = 0;
  for (const ch of String(s)) {
    if (ch === '（' || ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === '）' || ch === ')') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

const QUOTE_PAIRS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
];

/** 抽取所有引号内的文字，按出现顺序拼接；支持嵌套「『』」。 */
export function extractDialogue(s) {
  const text = String(s || '');
  const parts = [];
  let i = 0;
  while (i < text.length) {
    const pair = QUOTE_PAIRS.find((p) => text[i] === p[0]);
    if (!pair) {
      i += 1;
      continue;
    }
    const [open, close] = pair;
    // 半角双引号开闭同形：不能按"嵌套计数"，直接找下一个同形引号，
    // 否则会被当成无限嵌套，把后文整段吞进来。
    if (open === close) {
      const end = text.indexOf(close, i + 1);
      if (end < 0) break;
      const t = text.slice(i + 1, end).trim();
      if (t) parts.push(t);
      i = end + 1;
      continue;
    }
    // 找配对的收尾引号（同类型嵌套则计数）
    let depth = 1;
    let j = i + 1;
    let buf = '';
    while (j < text.length) {
      if (text[j] === open) depth += 1;
      else if (text[j] === close) {
        depth -= 1;
        if (depth === 0) break;
      }
      buf += text[j];
      j += 1;
    }
    if (depth === 0) {
      const t = buf.trim();
      if (t) parts.push(t);
      i = j + 1;
    } else {
      // 引号不闭合：把剩下的都当正文，避免整篇丢弃
      const t = (open + text.slice(i + 1)).trim();
      if (t) parts.push(t);
      break;
    }
  }
  return parts.join('\n');
}

/**
 * 按句切分并截断到 maxChars：优先在 。！？!?；; 或换行处断开，
 * 保留最后一段完整句子；一个句子就超长时才硬切（避免整条读不出来）。
 */
export function clampSentences(s, maxChars) {
  const text = String(s || '').trim();
  const max = Math.max(1, Number(maxChars) || 600);
  if (text.length <= max) return text;
  const out = [];
  let used = 0;
  const re = /[^。！？!?；;\n]*[。！？!?；;\n]?/g;
  let m;
  while ((m = re.exec(text))) {
    const piece = m[0];
    if (!piece) break;
    if (used + piece.length > max) break;
    out.push(piece);
    used += piece.length;
  }
  const joined = out.join('').trim();
  if (joined) return joined;
  return text.slice(0, max).trim();
}

/**
 * 尝试把「看起来是 JSON」的文本解包成纯台词，最多 2 层。
 * @returns {{text:string, unwrapped:boolean, notPlainText:boolean}}
 */
export function unwrapJsonText(raw) {
  let text = String(raw == null ? '' : raw).trim();
  let unwrapped = false;
  for (let i = 0; i < 2; i += 1) {
    if (!text.startsWith('{') || !text.includes('"content"')) break;
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      // 解析不了但明显是 JSON 外壳（模型违约）：不朗读，避免念出 {"content":...
      return { text, unwrapped, notPlainText: true };
    }
    if (obj && typeof obj === 'object' && typeof obj.content === 'string') {
      text = obj.content.trim();
      unwrapped = true;
      continue;
    }
    return { text, unwrapped, notPlainText: true };
  }
  // 解包后仍是 JSON 外壳 → 不可朗读（避免把 {"emotion":"calm"} 念出来）
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object') return { text, unwrapped, notPlainText: true };
    } catch {}
    if (text.includes('"content"')) return { text, unwrapped, notPlainText: true };
  }
  return { text, unwrapped, notPlainText: false };
}

/**
 * 生成待朗读文本。
 * @param {string} raw 原始回复（detail.reply）
 * @param {{mode?:'all'|'dialogue', skipActions?:boolean, maxChars?:number}} opts
 * @returns {{ok:boolean, text:string, mode:'all'|'dialogue', reason?:string, fallback?:string, chars:number}}
 */
export function buildSpeechText(raw, opts = {}) {
  const mode = opts.mode === 'dialogue' ? 'dialogue' : 'all';
  const skipActions = opts.skipActions !== false;
  const maxChars = Number(opts.maxChars) || 600;

  const un = unwrapJsonText(raw);
  if (un.notPlainText) {
    return { ok: false, text: '', mode, reason: 'not_plain_text', chars: 0 };
  }

  let text = stripMarkdown(un.text);
  text = text.replace(EMOJI_RE, ' ');

  let fallback = null;
  if (mode === 'dialogue') {
    const dialogue = extractDialogue(text).trim();
    if (dialogue) {
      text = dialogue;
    } else {
      // 没有引号台词（模型很少用引号）：退回全部内容，并在界面提示
      fallback = 'dialogue_empty';
      if (skipActions) text = stripBrackets(text);
    }
  } else if (skipActions) {
    text = stripBrackets(text);
  }

  text = text
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) return { ok: false, text: '', mode, reason: 'empty_text', chars: 0 };

  const clamped = clampSentences(text, maxChars);
  return {
    ok: true,
    text: clamped,
    mode,
    chars: clamped.length,
    ...(fallback ? { fallback } : {}),
  };
}
