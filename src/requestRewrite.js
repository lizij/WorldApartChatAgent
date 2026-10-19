/**
 * 请求重写（实验性）：转发前额外调用一次上游模型，把游戏 system 中与本工具
 * 外置设定 / 长期记忆冲突的描述删除或改写，再交给 NPC 回复调用。
 *
 * 游戏真实请求会把设定与规则拆成**多条 system 消息**（角色主设定、场景、任务、
 * 输出格式等，且可能与历史消息交错），因此这里按“模块”逐条重写：
 *   - 一次上游调用处理全部模块，用稳定标记 <<<SYSTEM id=N>>> 分隔；
 *   - 每个模块独立校验（含 `## 输出格式` 的模块必须逐字保留该节）；
 *   - 单个模块校验失败时只回退该模块，其余模块照常生效；
 *   - 外置内容不参与重写（它们在重写之后才注入），避免被模型二次改写。
 */
import { upstreamChatUrl } from './config.js';
import { tokenUsage } from './upstream.js';

const SYSTEM_PROMPT = [
  '你是游戏 NPC 对话请求的预处理器。游戏会把 NPC 的设定与规则拆成多条 system 模块',
  '（角色设定、场景、任务、输出格式等）。玩家另外配置了一个外置 Agent：它会在请求中',
  '额外注入「外置设定」和「外置长期记忆」。',
  '你的任务是逐条检查这些模块，把其中与外置内容冲突的描述删除或改写，避免干扰模型扮演；',
  '没有冲突的模块必须原样返回，不要润色。',
  '',
  '【优先级】外置设定 > 外置长期记忆 > 游戏 system 中的全部内容。',
  '唯一例外：任何模块里出现的「## 输出格式」都是游戏解析回复的技术契约，必须逐字保留。',
  '',
  '【输出格式（必须严格遵守）】',
  '对输入的每一条模块，按原顺序输出下面这一对标记及其中内容：',
  '<<<SYSTEM id=输入中的 id>>>',
  '（该模块重写后的完整内容）',
  '<<<END SYSTEM id=输入中的 id>>>',
  '不得遗漏任何模块，不得合并、拆分或新增模块；不得输出标记之外的任何文字。',
  '',
  '【重写规则】',
  '1. 只做“删除或改写冲突描述”，不得新增任何事实、设定、人物或剧情；无冲突的模块原样输出。',
  '2. 冲突包括：身份与称呼、性格与说话方式、表演尺度、感情与关系状态、世界观限制，',
  '   以及与本轮不符的时间、地点、场景描述。',
  '   注意：记忆中的时间、地点多是「过去某次见面」的状态，游戏 system 的当前时间/地点与它',
  '   不同只是时间推移，不算冲突；只有外置设定明确要求，或记忆明确否定当前场景时才改写。',
  '3. 冲突时优先删除游戏侧的冲突句；若整节都在冲突，可连同标题删除整节。',
  '4. 无法判断是否冲突时，保留原文。',
  '5. 任何模块中出现 `## 输出格式`，该节（标题、字段名、枚举取值、格式说明）必须逐字保留。',
  '6. 模块之间不得搬运内容；每个模块独立处理，不得因为另一模块的要求而改写本模块。',
  '7. 只输出带标记的模块内容本身：不要解释、不要前言后语、不要 Markdown 代码围栏。',
].join('\n');

/** 统一换行并去掉行尾空白，便于比较与 diff。 */
function normalize(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/** 取出 `## 输出格式` 整节（含标题），没有则返回 null。 */
function outputFormatSection(text) {
  const m = normalize(text).match(/(^|\n)##[ \t]*输出格式[ \t]*\n[\s\S]*?(?=\n##[ \t]|$)/);
  return m ? m[0].trim() : null;
}

/**
 * 从输出格式节里提取第一个配平的 JSON 对象（忽略字符串内的花括号）。
 * 游戏会把「最高优先级规则」等说明也塞在 `## 输出格式` 标题下，但它们不是解析契约；
 * 真正必须逐字保留的只有这个 JSON 结构。
 */
function balancedJsonBlock(section) {
  const start = section.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < section.length; i += 1) {
    const ch = section[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return section.slice(start, i + 1);
    }
  }
  return null;
}

/** 输出格式契约：标题存在 + 其中的 JSON 结构。 */
function formatContract(text) {
  const section = outputFormatSection(text);
  if (!section) return null;
  return { section, schema: balancedJsonBlock(section) };
}

/**
 * 用原 schema 覆盖草稿 schema：
 *  - 字段名、层级、类型必须一致（草稿多出字段视为契约变更）；
 *  - 原 schema 里的枚举串（含 `|`）一律还原，避免模型漏写某个取值；
 *  - 非枚举的字符串/布尔/数字保留草稿值。
 * @returns {{value:any}|{error:true}}
 */
function coverSchema(original, draft) {
  if (Array.isArray(original) || Array.isArray(draft)) {
    if (!Array.isArray(original) || !Array.isArray(draft) || original.length !== draft.length) {
      return { error: true };
    }
    const out = [];
    for (let i = 0; i < original.length; i += 1) {
      const r = coverSchema(original[i], draft[i]);
      if (r.error) return r;
      out.push(r.value);
    }
    return { value: out };
  }
  if (original && typeof original === 'object') {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { error: true };
    for (const key of Object.keys(draft)) {
      if (!(key in original)) return { error: true };
    }
    const out = { ...draft };
    for (const key of Object.keys(original)) {
      if (!(key in out)) {
        out[key] = original[key];
        continue;
      }
      const r = coverSchema(original[key], out[key]);
      if (r.error) return r;
      out[key] = r.value;
    }
    return { value: out };
  }
  if (typeof original === 'string') {
    if (typeof draft !== 'string') return { error: true };
    return { value: original.includes('|') ? original : draft };
  }
  if (typeof original === 'boolean') return typeof draft === 'boolean' ? { value: draft } : { error: true };
  if (typeof original === 'number') return typeof draft === 'number' ? { value: draft } : { error: true };
  return { value: draft };
}

/** 去掉输出格式里的 JSON 块，便于比较“结构之外”的文本是否变化。 */
function outsideSchema(text) {
  const n = normalize(text);
  const section = outputFormatSection(n);
  const block = section ? balancedJsonBlock(section) : null;
  return block ? n.replace(block, '') : n;
}

/**
 * 校验并尽量修复输出格式：
 *  - 结构无法对齐 → 返回错误，由调用方回退；
 *  - 只是枚举漏值/字段缺失 → 用原 schema 补回，保留草稿里其它改写；
 *  - 修复后与原模块完全等价（仅结构被补回）→ noop，不产生无意义的改写。
 * @returns {{ok:true,text:string,repaired:boolean,noop?:boolean}|{ok:false,error:string}}
 */
function repairFormat(originalText, draftText) {
  const ca = formatContract(originalText);
  const cb = formatContract(draftText);
  if (!ca) return { ok: true, text: draftText, repaired: false };
  if (!cb) return { ok: false, error: 'rewrite_output_format_missing' };
  if (!ca.schema) {
    if (ca.section !== cb.section) return { ok: false, error: 'rewrite_output_format_changed' };
    return { ok: true, text: draftText, repaired: false };
  }
  let oa;
  let ob;
  try {
    oa = JSON.parse(ca.schema);
    ob = JSON.parse(cb.schema);
  } catch {
    return { ok: false, error: 'rewrite_output_format_changed' };
  }
  const covered = coverSchema(oa, ob);
  if (covered.error) return { ok: false, error: 'rewrite_output_format_changed' };
  const schemaRestored = JSON.stringify(covered.value) === JSON.stringify(oa);
  if (schemaRestored && outsideSchema(originalText) === outsideSchema(draftText)) {
    // 草稿只是漏了枚举/字段，补回后与原模块等价：直接沿用原文，避免无意义改写。
    return { ok: true, text: originalText, repaired: true, noop: true };
  }
  const semanticChanged = JSON.stringify(covered.value) !== JSON.stringify(ob);
  if (!semanticChanged) return { ok: true, text: draftText, repaired: false };
  const repairedBlock = JSON.stringify(covered.value, null, 2);
  return { ok: true, text: draftText.replace(cb.schema, repairedBlock), repaired: true };
}

/** 模型偶尔会用代码围栏包裹结果，防御性剥掉。 */
function stripFences(text) {
  let t = String(text || '').trim();
  const m = t.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/);
  if (m) t = m[1].trim();
  return t;
}

function dedupe(list) {
  return [...new Set(list)];
}

/**
 * 行级差异（按出现次数计，忽略空行）。
 * removed/added 为去重后的展示列表；removedCount/addedCount 是真实行数（含重复出现）。
 */
function lineDiff(before, after) {
  const counts = new Map();
  for (const l of normalize(before).split('\n')) {
    const s = l.trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  for (const l of normalize(after).split('\n')) {
    const s = l.trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) - 1);
  }
  const removedAll = [];
  const addedAll = [];
  for (const [line, n] of counts) {
    if (n > 0) for (let i = 0; i < n; i += 1) removedAll.push(line);
    else if (n < 0) for (let i = 0; i < -n; i += 1) addedAll.push(line);
  }
  return {
    removed: dedupe(removedAll).slice(0, 80),
    added: dedupe(addedAll).slice(0, 80),
    removedCount: removedAll.length,
    addedCount: addedAll.length,
  };
}

/** 模块标题：优先第一个 `## ` 标题，否则取首行。 */
function moduleTitle(content) {
  const n = normalize(content);
  const h = n.match(/^##[ \t]*(.+)$/m);
  if (h) return h[1].trim();
  const first = n.split('\n').find((l) => l.trim()) || '';
  return first.replace(/^[*#\s]+/, '').slice(0, 40) || '（无标题模块）';
}

/** 校验单个模块；能修复的格式问题先修复，不能修复才返回错误。 */
function validateModule(original, rewritten) {
  if (!rewritten.trim()) return { error: 'rewrite_empty' };
  const a = normalize(original);
  const b = normalize(rewritten);
  const fmt = repairFormat(a, b);
  if (!fmt.ok) return { error: fmt.error };
  if (a.length >= 200 && b.length < a.length * 0.3) return { error: 'rewrite_too_short' };
  if (b.length > a.length * 1.5) return { error: 'rewrite_too_long' };
  return { error: null, text: fmt.text, repaired: fmt.repaired, noop: !!fmt.noop };
}

/**
 * 解析模型输出中的模块标记。
 * @returns {{map: Map<number,string>}|{error:string}}
 */
function parseModules(text, expectedIds) {
  const re = /<<<SYSTEM id=(\d+)>>>\s*([\s\S]*?)\s*<<<END SYSTEM id=\1>>>/g;
  const map = new Map();
  let m;
  let seenMarker = false;
  while ((m = re.exec(text))) {
    seenMarker = true;
    const id = Number(m[1]);
    if (!expectedIds.has(id)) continue;
    if (map.has(id)) return { error: 'rewrite_duplicate_module:' + id };
    map.set(id, m[2].trim());
  }
  if (!seenMarker) return { error: 'rewrite_parse_failed' };
  return { map };
}

export class RequestRewriter {
  constructor({ config }) {
    // config 是 ConfigStore：每次取值都 get()，保证管理页热更新即时生效
    this.store = config;
  }

  get config() {
    return this.store.get();
  }

  /**
   * 重写全部游戏 system 模块。
   * 网络/上游错误直接抛出；解析/校验失败通过返回值表达，调用方按模块回退。
   * @param {{slug?:string, systems:Array<{index:number,content:string}>, memoryText?:string, promptsText?:string, signal?:AbortSignal}} args
   * @returns {Promise<object>}
   */
  async rewrite({ slug, systems, memoryText = '', promptsText = '', signal } = {}) {
    const started = Date.now();
    const c = this.config.requestRewrite;
    const up = this.config.upstream;
    if (up.insecureTLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const list = Array.isArray(systems) ? systems : [];
    const totalChars = list.reduce((n, s) => n + normalize(s.content).length, 0);

    const blocks = list.map(
      (s, id) => `<<<SYSTEM id=${id}>>>\n${s.content}\n<<<END SYSTEM id=${id}>>>`,
    );

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `NPC：${slug || '（未知）'}`,
          `游戏 system 模块数：${list.length}`,
          '',
          '【外置设定（最高优先级）】',
          promptsText || '（无）',
          '',
          '【外置长期记忆】',
          memoryText || '（无）',
          '',
          '【游戏 system 模块（逐条输出，保持 id 与顺序）】',
          blocks.join('\n\n'),
        ].join('\n'),
      },
    ];

    // 多模块重写输出接近整个 system 的体量；按字符数估算下限，避免被 max_tokens 截断。
    const configuredMax = Math.max(500, Number(c.maxTokens) || 6000);
    const needed = Math.ceil(totalChars / 1.2) + 800;
    const maxTokens = Math.min(Math.max(configuredMax, needed), 20000);
    const timeoutMs = Math.max(1000, Number(c.timeoutMs) || 60000);
    const temperature = Number.isFinite(Number(c.temperature)) ? Number(c.temperature) : 0.2;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('请求重写超时')), timeoutMs);
    const onAbort = () => ac.abort(new Error('客户端已断开'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetch(upstreamChatUrl(up.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${up.apiKey}` },
        body: JSON.stringify({
          model: up.model,
          temperature,
          max_tokens: maxTokens,
          stream: false,
          thinking: { type: 'disabled' },
          messages,
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`上游 ${res.status}: ${text}`);
      }
      const json = await res.json();
      const raw = json?.choices?.[0]?.message?.content || '';
      const usage = json?.usage || null;
      const durationMs = Date.now() - started;

      const parsed = parseModules(stripFences(raw), new Set(list.map((_, id) => id)));
      const items = list.map((s, id) => {
        const original = s.content;
        const parsedText = parsed.map?.get(id);
        let invalid = null;
        let candidate = original;
        let repaired = false;
        if (parsed.error) {
          invalid = parsed.error;
        } else if (parsedText == null) {
          invalid = 'rewrite_module_missing';
        } else {
          const check = validateModule(original, parsedText);
          if (check.error) invalid = check.error;
          else {
            candidate = check.noop ? original : check.text;
            repaired = !!check.repaired;
          }
        }
        const effective = invalid ? original : candidate;
        const diff = lineDiff(original, effective);
        return {
          id,
          index: s.index,
          title: moduleTitle(original),
          ok: !invalid,
          error: invalid || null,
          original,
          draft: parsedText ?? null,
          rewritten: effective,
          repaired,
          changed: normalize(original) !== normalize(effective),
          originalChars: original.length,
          rewrittenChars: effective.length,
          ...diff,
        };
      });

      const okCount = items.filter((x) => x.ok).length;
      const changedCount = items.filter((x) => x.ok && x.changed).length;
      const repairedCount = items.filter((x) => x.ok && x.repaired).length;
      const failedCount = items.length - okCount;
      const status = parsed.error
        ? 'failed'
        : failedCount === 0
          ? 'done'
          : okCount > 0
            ? 'partial'
            : 'failed';
      const reply = items.map((x) => x.draft ?? x.rewritten).join('\n');

      return {
        ok: status !== 'failed',
        status,
        error: parsed.error || null,
        items,
        moduleCount: items.length,
        okCount,
        changedCount,
        repairedCount,
        failedCount,
        originalChars: items.reduce((n, x) => n + x.originalChars, 0),
        rewrittenChars: items.reduce((n, x) => n + x.rewrittenChars, 0),
        removedCount: items.reduce((n, x) => n + x.removedCount, 0),
        addedCount: items.reduce((n, x) => n + x.addedCount, 0),
        durationMs,
        usage,
        tokens: tokenUsage({ usage, messages, reply }),
        messages,
        request: {
          model: up.model,
          stream: false,
          temperature,
          max_tokens: maxTokens,
          thinking: { type: 'disabled' },
          messageCount: messages.length,
        },
      };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}
