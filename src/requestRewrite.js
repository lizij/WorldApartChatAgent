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
  '（角色设定、场景、任务、输出格式等）；本工具还可能在同一次请求里附带**配角角色卡**',
  '（世界规则 / 姓名 / 身份 / 说话习惯 / 性格）。两类模块的处理方式相同：',
  '删改其中与外置设定、外置长期记忆冲突的描述。',
  '',
  '【优先级】外置设定 > 外置长期记忆 > 待处理 system 模块中的全部内容。',
  '唯一例外：任何模块里出现的「## 输出格式」都是游戏解析回复的技术契约，必须逐字保留。',
  '',
  '【配角模块的额外限制】',
  '1. 不得改动配角的**姓名与身份**（“姓名：X”“身份：…”这两行必须逐字保留）；',
  '2. 只允许删除或改写性格、口吻、态度类描述，使其符合玩家的外置设定；',
  '3. 不得给配角新增任何事实、关系、经历或剧情。',
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

/** 枚举串（含 `|`）的保守默认值：优先回落到“无动作/中性”的取值。 */
function enumDefault(value) {
  const parts = String(value)
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const preferred of ['none', 'normal', 'false', '0']) {
    if (parts.includes(preferred)) return preferred;
  }
  return parts[0] ?? '';
}

/** 按游戏当轮输出格式模板补全默认值（不硬编码任何字段名或枚举）。 */
function fillTemplate(node) {
  if (Array.isArray(node)) return node.map((x) => fillTemplate(x));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = fillTemplate(node[k]);
    return out;
  }
  if (typeof node === 'string') return node.includes('|') ? enumDefault(node) : node;
  return node;
}

/**
 * 模型偶尔会把整个输出格式 JSON 当成“字符串”再转义一遍（`{\"content\":\"…\"}`），
 * 这种文本不是合法 JSON，直接当纯文本包回去会把反斜杠原样显示给玩家。
 * 这里先按“它本来是一个 JSON 字符串”解一层，再解析成对象。
 */
function reviveEscapedJson(text) {
  let s = String(text ?? '');
  // 少数情况外面还套了一层 JSON 字符串引号：先去掉。
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const inner = JSON.parse(s);
      if (typeof inner === 'string') s = inner;
    } catch {}
  }
  // 去壳后可能已经是合法的游戏 JSON 文本。
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.content === 'string') return j;
  } catch {}
  if (!s.includes('\\"')) return null;
  try {
    const unescaped = JSON.parse(`"${s.replace(/\r?\n/g, '\\n')}"`);
    const j = JSON.parse(unescaped);
    if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.content === 'string') return j;
  } catch {}
  return null;
}

/**
 * 模型没按 `## 输出格式` 输出 JSON 时，按当轮模板把正文包成合法 JSON。
 * 只用于非流式响应（流式已经边收边发，无法回头改写）；拿不到模板时返回 null。
 * 其余字段一律取模板默认值：枚举串回落到 none/normal，布尔/数字保持模板值。
 */
export function wrapPlainReply(text, system) {
  const contract = formatContract(system || '');
  if (!contract || !contract.schema) return null;
  let template;
  try {
    template = JSON.parse(contract.schema);
  } catch {
    return null;
  }
  if (!template || typeof template !== 'object' || typeof template.content !== 'string') return null;

  // 纯文本里如果只是把 JSON 包在代码围栏里，直接去掉围栏即可，不要二次包装。
  const body = String(text ?? '').trim();
  const unfenced = stripFences(body);
  if (unfenced !== body) {
    try {
      const j = JSON.parse(unfenced);
      if (j && typeof j === 'object') return unfenced;
    } catch {}
  }

  const out = fillTemplate(template);
  // 输出被整体转义过（`{\"content\":…}`）：解析回对象，保留模型给出的字段值。
  const revived = reviveEscapedJson(unfenced);
  if (revived) {
    Object.assign(out, revived);
    if (typeof revived.content !== 'string') out.content = body;
    // 台词里出现 {GIFT} 占位符说明模型想赠礼；补默认值时不能把它当成“不赠礼”。
    applyGiftHint(out, out.content);
    return JSON.stringify(out);
  }
  out.content = body;
  applyGiftHint(out, out.content);
  return JSON.stringify(out);
}

/** 模板里 <intent> 下与赠礼有关的布尔字段（按字段名识别，不硬编码游戏枚举）。 */
function applyGiftHint(out, content) {
  if (!/\{GIFT\}/.test(String(content ?? ''))) return;
  const intent = out && typeof out.intent === 'object' ? out.intent : null;
  if (!intent) return;
  for (const key of Object.keys(intent)) {
    if (/gift/i.test(key) && typeof intent[key] === 'boolean') intent[key] = true;
  }
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
  if (!rewritten.trim()) {
    // 整节都在冲突时，重写模型会把它删空；这是合法结果，按“删除该模块”处理。
    // 例外：`## 输出格式` 是游戏解析回复的技术契约，绝不能整节删除。
    const a = normalize(original);
    if (/^##[ \t]*输出格式/m.test(a)) return { error: 'rewrite_empty' };
    return { error: null, text: '', dropped: true, repaired: false, noop: false };
  }
  const a = normalize(original);
  const b = normalize(rewritten);
  const fmt = repairFormat(a, b);
  if (!fmt.ok) return { error: fmt.error };
  if (a.length >= 200 && b.length < a.length * 0.3) return { error: 'rewrite_too_short' };
  if (b.length > a.length * 1.5) return { error: 'rewrite_too_long' };
  return { error: null, text: fmt.text, repaired: fmt.repaired, noop: !!fmt.noop };
}

/**
 * 配角模块的校验：没有 `## 输出格式` 契约，但必须保住姓名与身份。
 * @param {(original:string, rewritten:string)=>string|null} guard 返回错误码或 null
 */
function validateExtra(original, rewritten, guard) {
  const base = validateModule(original, rewritten);
  if (base.error) return base;
  if (typeof guard === 'function') {
    const err = guard(original, base.text);
    if (err) return { error: err };
  }
  return base;
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
   * 重写 system 模块。
   * `systems` 是游戏下发的模块；`extras` 是本工具构造的模块（B 的世界规则 / 角色卡），
   * 它们同样可以对照外置提示词与记忆做删改，但必须保住姓名与身份（由 guard 校验）。
   * 网络/上游错误直接抛出；解析/校验失败通过返回值表达，调用方按模块回退。
   * @param {{slug?:string, systems:Array<{index:number,content:string}>, extras?:Array<{key:string,content:string,guard?:Function}>, memoryText?:string, promptsText?:string, signal?:AbortSignal}} args
   * @returns {Promise<object>}
   */
  async rewrite({ slug, systems, extras = [], memoryText = '', promptsText = '', signal } = {}) {
    const started = Date.now();
    const c = this.config.requestRewrite;
    const up = this.config.upstream;
    if (up.insecureTLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const list = Array.isArray(systems) ? systems : [];
    const extraList = Array.isArray(extras) ? extras.filter((x) => x && typeof x.content === 'string') : [];
    const all = [
      ...list.map((s) => ({ content: s.content, group: 'game', index: s.index })),
      ...extraList.map((x) => ({ content: x.content, group: 'cast', key: x.key, guard: x.guard })),
    ];
    const totalChars = all.reduce((n, s) => n + normalize(s.content).length, 0);

    const blocks = all.map(
      (s, id) => `<<<SYSTEM id=${id}>>>\n${s.content}\n<<<END SYSTEM id=${id}>>>`,
    );

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `NPC：${slug || '（未知）'}`,
          `待处理 system 模块数：${all.length}（游戏 ${list.length} + 构造 ${extraList.length}）`,
          '',
          '【外置设定（最高优先级）】',
          promptsText || '（无）',
          '',
          '【外置长期记忆】',
          memoryText || '（无）',
          '',
          '【待处理 system 模块（逐条输出，保持 id 与顺序）】',
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

      const parsed = parseModules(stripFences(raw), new Set(all.map((_, id) => id)));
      const items = all.map((s, id) => {
        const original = s.content;
        const parsedText = parsed.map?.get(id);
        let invalid = null;
        let candidate = original;
        let repaired = false;
        let dropped = false;
        if (parsed.error) {
          invalid = parsed.error;
        } else if (parsedText == null) {
          invalid = 'rewrite_module_missing';
        } else {
          const check =
            s.group === 'cast' ? validateExtra(original, parsedText, s.guard) : validateModule(original, parsedText);
          if (check.error) invalid = check.error;
          else {
            candidate = check.noop ? original : check.text;
            repaired = !!check.repaired;
            dropped = !!check.dropped;
          }
        }
        const effective = invalid ? original : candidate;
        const diff = lineDiff(original, effective);
        return {
          id,
          group: s.group,
          key: s.key || null,
          index: s.index == null ? null : s.index,
          title: moduleTitle(original),
          ok: !invalid,
          error: invalid || null,
          original,
          draft: parsedText ?? null,
          rewritten: effective,
          repaired,
          droppedModule: dropped && !invalid,
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
        droppedCount: items.filter((x) => x.droppedModule).length,
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
