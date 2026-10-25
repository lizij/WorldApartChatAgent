/**
 * 在场状态与玩家指令解析（确定性正则，不调模型）。
 *
 * 约定：
 *  - 入场 / 离场只认**括号内**的显式动作，避免把普通叙述误判成调度；
 *  - 点名可以在括号内（“对X说”“看向X”），也可以在正文（“X，你怎么看”“X你来了”）；
 *  - 点名的先后决定谁先开口；入场括号里的名字不算点名；
 *  - 同一句既点名又写离场时，以离场为准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NPCS_DIR } from '../memory/store.js';

const ENTRY_VERBS = /(走过来|走了过来|走进|走了进来|进来|推门|赶来|赶到|出现|到场|来到|过来|上前|站在|立在|探进|迈步)/;
const SPEAK_VERBS = /^(?:\s*(?:说|道|问|答|喊|叫|开口|低声|插话|笑道|答道|问道))/;
// 离场动词必须紧跟在名字之后（允许“她/他/你”与“就/便/先”等虚词），
// 避免“抓住清月的腰让她无法离开”这类从句被当成离场。
const EXIT_AFTER =
  /^[ \t]*[，,、]?[ \t]*(?:[他她你妳][ \t]*)?(?:就|便|要|想|先|也|已|已经)?[ \t]*(离开|走了|告辞|退下|出去|离去|先回|退开|转身走)/;
// 名字前面的点名词：允许“对着/朝着/向着”这类双字形式，也允许中间夹空格（“我对着 弦娘说”）。
const ADDRESS_VERB_BEFORE = /(?:对|朝|冲|向|问)(?:着)?[ \t]*$|(?:看向|望着|看着|叫|喊|招呼)[ \t]*$/;
const COMMAND_RE = /\/(invite|add|leave|remove)[ \t]+([^\s，,。！？!?、（）()\[\]【】「」『』“”"'《》<>]+)/gi;
// 名字后面的点名后缀：允许前置空格（“弦娘 ，你怎么看”）。
const ADDRESS_SUFFIX = /^[ \t]*(?:[，,、]|[你妳]|在吗|在不在|呢|啊|呀|[？?])/;
const MENTION_SUFFIX = /^(?:的|家|最近|那|这边|那边|铺子|的事|怎么样的时候)/;
// 只有“X 的卧房/铺子/家”这类所属地点才不算点到人；
// “X 的手/肩”是对她本人的动作，算被提及。
const MENTION_OWNERSHIP =
  /^[ \t]*(?:的(?:卧房|房间|屋子|宅子|院子|铺子|铺|店|家|住处|东西)|家|那边|这边)/;

const PUNCT_BEFORE = /[\s，。！？、,.!?：:；;「」『』“”"'（）()\[\]【】]/;

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function stageFile(slug) {
  return path.join(NPCS_DIR, slug, 'stage.json');
}

/** 读在场状态；文件缺失/损坏时返回空状态。 */
export function loadStage(slug) {
  const v = loadJson(stageFile(slug), null);
  if (!v || typeof v !== 'object') return { sceneKey: null, onStage: [], updatedAt: 0 };
  return {
    sceneKey: typeof v.sceneKey === 'string' ? v.sceneKey : null,
    onStage: Array.isArray(v.onStage)
      ? v.onStage.filter((x) => x && typeof x.slug === 'string').map((x) => ({
          slug: x.slug,
          name: typeof x.name === 'string' ? x.name : x.slug,
          since: typeof x.since === 'string' ? x.since : '',
        }))
      : [],
    updatedAt: Number(v.updatedAt) || 0,
  };
}

export function saveStage(slug, stage) {
  try {
    fs.mkdirSync(path.dirname(stageFile(slug)), { recursive: true });
    fs.writeFileSync(stageFile(slug), JSON.stringify(stage, null, 2), 'utf8');
  } catch {}
}

/** 括号内指令：入场 / 离场 / 括内点名。 */
function parseParens(text, names) {
  const entries = [];
  const exits = [];
  const addresses = [];
  const used = []; // 已匹配的名字区间，避免长短名重叠（“奈宝·江楚弦”里再匹配“江楚弦”）
  const re = /（([^）]*)）|\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1] ?? m[2] ?? '';
    if (!body) continue;
    const start = m.index;
    for (const name of names) {
      let at = body.indexOf(name);
      while (at >= 0) {
        const abs = start + at;
        const end = abs + name.length;
        const clash = used.some((r) => abs < r[1] && r[0] < end);
        if (!clash) {
          used.push([abs, end]);
          const after = body.slice(at + name.length);
          // 入场 / 离场：动词必须跟在名字**后面**（“章籽梦走过来”），
          // 不能拿名字前面的动词判断，否则“我走进来，看见章籽梦”会误判为配角入场。
          if (ENTRY_VERBS.test(after.slice(0, 12)) || SPEAK_VERBS.test(after)) {
            entries.push({ slug: null, name, pos: abs, raw: name });
          } else if (EXIT_AFTER.test(after)) {
            exits.push({ name, pos: abs });
          }
          const before = body.slice(0, at);
          if (ADDRESS_VERB_BEFORE.test(before)) {
            addresses.push({ name, pos: abs });
          }
        }
        at = body.indexOf(name, at + name.length);
      }
    }
  }
  return { entries, exits, addresses };
}

/** 正文点名：名字在句首/分句首，后面紧跟第二人称或问句。 */
function parsePlainAddresses(text, names) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const name = names.find((n) => text.startsWith(n, i));
    if (!name) {
      i += 1;
      continue;
    }
    const prev = i === 0 ? '' : text[i - 1];
    const okBefore = i === 0 || PUNCT_BEFORE.test(prev);
    const after = text.slice(i + name.length);
    if (okBefore && ADDRESS_SUFFIX.test(after) && !MENTION_SUFFIX.test(after)) {
      out.push({ name, pos: i });
    }
    i += name.length;
  }
  return out;
}

/**
 * 解析玩家本轮发言里的调度指令。
 * @param {{text:string, names:string[]}} args names 必须按长度降序
 * @returns {{entries:Array, exits:Array, addresses:Array, mentions:Array}}
 */
export function parseDirectives({ text, names } = {}) {
  const raw = String(text || '');
  const list = Array.isArray(names) ? names : [];
  if (!raw || !list.length) {
    return { entries: [], exits: [], addresses: [], mentions: [], invites: [], removes: [], commands: [], cleanText: raw };
  }

  // 显式系统指令：/invite、/add 入场；/leave、/remove 离场（从玩家输入里剥离）
  const commands = [];
  let cleanText = raw;
  for (const m of raw.matchAll(COMMAND_RE)) {
    const word = m[1].toLowerCase();
    commands.push({
      action: word === 'add' ? 'invite' : word === 'leave' ? 'remove' : word,
      name: m[2].trim(),
      pos: m.index,
    });
  }
  if (commands.length) {
    cleanText = raw
      .replace(COMMAND_RE, ' ')
      .replace(/[（(]\s*[)）]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/^[，,。！？!?、）)\s]+/, '')
      .trim();
  }
  const invites = commands.filter((c) => c.action === 'invite');
  const removes = commands.filter((c) => c.action === 'remove');

  const paren = parseParens(cleanText, list);
  const plain = parsePlainAddresses(cleanText, list);

  const addresses = [...paren.addresses, ...plain].sort((a, b) => a.pos - b.pos);
  // 去重（同一名字同一位置）
  const seen = new Set();
  const addr = addresses.filter((a) => {
    const k = a.name + '@' + a.pos;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 仅提及：全文出现过名字，但既不是入场/离场，也不是点名
  // 已匹配到的名字会占用一段区间，避免「纪澜之」里的「澜之」被当成另一次提及
  const spans = [...paren.entries, ...paren.exits, ...addr].map((x) => [x.pos, x.pos + x.name.length]);
  const overlaps = (s, e) => spans.some(([a, b]) => s < b && a < e);
  const mentions = [];
  for (const n of list) {
    let at = cleanText.indexOf(n);
    while (at >= 0) {
      const end = at + n.length;
      // “X的卧房”“X家”这类所属/方位描述只是提及，不算在叫这个人
      if (!overlaps(at, end) && !MENTION_OWNERSHIP.test(cleanText.slice(end))) {
        mentions.push({ name: n, pos: at });
        break;
      }
      at = cleanText.indexOf(n, at + n.length);
    }
  }

  return {
    entries: paren.entries,
    exits: paren.exits,
    addresses: addr,
    mentions,
    invites,
    removes,
    commands,
    cleanText,
  };
}

/**
 * 计算新的在场状态（纯函数）。
 * @param {{prev:object, directives:object, sceneKey:string|null, now:number, maxCoStars:number, idleMs:number, resolveSlug:Function}} args
 * @returns {{stage:object, changed:boolean, touched:boolean, cleared:string|null, entered:string[], left:string[]}}
 */
export function nextStage({ prev, directives, sceneKey, now, maxCoStars, idleMs, resolveSlug }) {
  const before = JSON.stringify(prev?.onStage || []);
  const beforeScene = prev?.sceneKey || null;
  const beforeUpdatedAt = Number(prev?.updatedAt) || 0;
  const stage = {
    sceneKey: prev?.sceneKey || null,
    onStage: Array.isArray(prev?.onStage) ? prev.onStage.map((x) => ({ ...x })) : [],
    updatedAt: beforeUpdatedAt,
  };

  // 换场 / 长时间空闲：清空（记下原因，便于日志排查）
  let cleared = null;
  if (stage.sceneKey && sceneKey && stage.sceneKey !== sceneKey) {
    if (stage.onStage.length) cleared = 'scene';
    stage.onStage = [];
  }
  if (stage.updatedAt && now - stage.updatedAt > idleMs) {
    if (stage.onStage.length) cleared = 'idle';
    stage.onStage = [];
  }
  if (sceneKey) stage.sceneKey = sceneKey;

  const entered = [];
  const resolve = (name) => (typeof resolveSlug === 'function' ? resolveSlug(name) : name);

  // 入场（显式 + 点名自动入场）
  const wants = [...(directives.entries || []), ...(directives.addresses || [])];
  for (const x of wants) {
    const slug = resolve(x.name);
    if (!slug) continue;
    if (stage.onStage.some((s) => s.slug === slug)) continue;
    if (stage.onStage.length >= maxCoStars) break;
    stage.onStage.push({ slug, name: x.name, since: new Date(now).toISOString() });
    entered.push(slug);
  }

  // 离场（优先级最高）
  const left = [];
  for (const x of directives.exits || []) {
    const slug = resolve(x.name);
    if (!slug) continue;
    const idx = stage.onStage.findIndex((s) => s.slug === slug);
    if (idx >= 0) {
      stage.onStage.splice(idx, 1);
      left.push(slug);
    }
  }

  // 上限兜底（保留最近入场的）
  if (stage.onStage.length > maxCoStars) stage.onStage = stage.onStage.slice(-maxCoStars);

  const after = JSON.stringify(stage.onStage);
  const changed = before !== after || beforeScene !== stage.sceneKey;
  // 只要本轮还有配角在场，就刷新时间戳：超时清场衡量的是“多久没来往”，
  // 而不是“多久没换人”，否则聊得久一点就会被误判为离场。
  if (stage.onStage.length) stage.updatedAt = now;
  else if (changed || directives.addresses?.length) stage.updatedAt = now;
  const touched = stage.updatedAt !== beforeUpdatedAt;

  return { stage, changed, touched, cleared, entered, left };
}
