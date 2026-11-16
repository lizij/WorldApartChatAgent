/**
 * 系统语音：枚举、缓存、音色解析、逐 NPC 设置、性别判定。
 *
 * 关键约束（见 docs/tts.md）：
 *   - 中文男声只有 WinRT 能选到，经典 SAPI 只有女声 → 一律走 WinRT。
 *   - 枚举要起一次 PowerShell（约 0.4s），缓存 10 分钟，不放进 /api/status。
 *   - **禁止**用 `- 性别：` 那一行判定 NPC 性别：identify.js 的 extractGameState()
 *     取的是**玩家**性别（state.lastGame.player.gender）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { NPCS_DIR } from '../memory/store.js';
import { sectionsOf, latestIntake } from '../cast/card.js';
import { extractFactBlocks } from '../identify.js';

const VOICE_CACHE_MS = 10 * 60 * 1000;

/** 枚举脚本：只输出 JSON 数组，不依赖 stderr。 */
const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$out = @()
foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
  $out += [pscustomobject]@{ name = $v.DisplayName; gender = [string]$v.Gender; language = $v.Language }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

let listCache = { at: 0, voices: [] };

function runPowershell(script, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err.message || err) });
        resolve({ ok: true, stdout: String(stdout || '') });
      },
    );
  });
}

/** 列出系统中文语音（zh*）。失败或没有中文语音时返回空数组。 */
export async function listVoices({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - listCache.at < VOICE_CACHE_MS) return listCache.voices;

  const r = await runPowershell(LIST_SCRIPT, 6000);
  if (!r.ok) {
    // 失败也要缓存：否则 PowerShell 被安全策略拦截时，每次打开 NPC 页都会重试并卡 15 秒
    listCache = { at: now, voices: [] };
    return [];
  }

  let parsed = [];
  try {
    parsed = JSON.parse(r.stdout.trim() || '[]');
  } catch {
    listCache = { at: now, voices: [] };
    return [];
  }
  if (!Array.isArray(parsed)) parsed = [parsed];
  const voices = parsed
    .filter((v) => v && typeof v.name === 'string' && /^zh/i.test(String(v.language || '')))
    .map((v) => ({
      name: v.name,
      gender: String(v.gender || '').toLowerCase() === 'male' ? 'male' : 'female',
      language: String(v.language || ''),
    }));
  listCache = { at: now, voices };
  return voices;
}

export function invalidateVoiceCache() {
  listCache = { at: 0, voices: [] };
}

// —— 逐 NPC 设置 ——

const DEFAULT_VOICE = { enabled: true, gender: 'auto', rate: null, pitch: null, voice: '' };

function voiceFile(slug) {
  return path.join(NPCS_DIR, slug, 'voice.json');
}

function numOrNull(v) {
  // 注意：Number(null) === 0、Number('') === 0，必须先排除"空"
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function readVoice(slug) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(voiceFile(slug), 'utf8'));
  } catch {
    return { ...DEFAULT_VOICE };
  }
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_VOICE };
  return {
    enabled: raw.enabled !== false,
    gender: raw.gender === 'male' || raw.gender === 'female' ? raw.gender : 'auto',
    rate: numOrNull(raw.rate),
    pitch: numOrNull(raw.pitch),
    // 音色：统一 ID（<引擎>:<音色>）；旧版的裸值在 normalizeVoiceId 里升级
    voice: normalizeVoiceId(raw.voice),
  };
}

// —— 旧格式升级 ——

/** Kokoro 的说话人名（与 kokoro.js 的 KOKORO_VOICES 一致）。 */
const KOKORO_NAMES = new Set(['zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunxi']);
/** DeepSeek 的音色 id。 */
const DEEPSEEK_IDS = new Set(['stella', 'tide']);

/**
 * 把 `voice.json` 里的旧值升级成统一 ID。
 *
 * 0.19.x 的 voice.voice 存的是裸音色名，只有 Kokoro 会用它，
 * 所以旧值必须按 Kokoro 归属——否则 `zm_yunxi` 会被当成 Windows 语音名而永久失效。
 */
export function normalizeVoiceId(raw) {
  const s = typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
  if (!s) return '';
  if (s.includes(':')) return s; // 已经是统一 ID
  if (KOKORO_NAMES.has(s)) return `kokoro:${s}`;
  if (DEEPSEEK_IDS.has(s)) return `deepseek:${s}`;
  // 其余裸名按 Windows 系统语音处理（0.19.x 的 Windows 音色就是这个格式）
  return `windows:${s}`;
}

export function saveVoice(slug, patch = {}) {
  const cur = readVoice(slug);
  const next = { ...cur };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.gender === 'male' || patch.gender === 'female' || patch.gender === 'auto') next.gender = patch.gender;
  if (patch.rate !== undefined) {
    const v = numOrNull(patch.rate);
    next.rate = v === null ? null : Math.round(Math.min(Math.max(v, 0.5), 3) * 100) / 100;
  }
  if (patch.pitch !== undefined) {
    const v = numOrNull(patch.pitch);
    next.pitch = v === null ? null : Math.round(Math.min(Math.max(v, 0.5), 2) * 100) / 100;
  }
  if (patch.voice !== undefined) {
    next.voice = normalizeVoiceId(patch.voice);
  }
  // 全默认值时不落盘，保持目录干净
  const isDefault =
    next.enabled === DEFAULT_VOICE.enabled &&
    next.gender === DEFAULT_VOICE.gender &&
    next.rate == null &&
    next.pitch == null &&
    !next.voice;
  const file = voiceFile(slug);
  if (isDefault) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  }
  return next;
}

// —— 性别判定 ——

/** 称谓关键词：命中即给分。顺序固定，先命中先生效。 */
const FEMALE_HINTS = ['少女', '女子', '姑娘', '仙子', '师娘', '娘亲', '母亲', '小姐', '夫人', '妇人'];
const MALE_HINTS = ['少年', '男子', '公子', '老汉', '老丈', '父亲', '师兄', '师弟', '少爷', '夫君'];

/** 「- **身份**：女，人」/「- 性别：男」——游戏下发的权威字段。 */
const PERSONA_LINE = /^[-*]?\s*\**\s*(?:身份|性别|性別)\**\s*[：:]\s*(女|男)/;

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * 从「角色属性」块里读游戏下发的权威性别字段。
 *
 * 两种写法都要认（实测 21/21 个 NPC 都有，覆盖率 100%）：
 *   ① `- **身份**：女，人`           —— 不带名字，就是本角色自己的
 *   ② `李清月（npc:190102）：…基础：女/…` —— 带名字，必须按 slug 精确匹配
 *
 * 为什么要按名字过滤：角色属性里会混进其他 NPC 的档案行
 * （如李清月的档案里带有「宓青苓（npc:190802）：…基础：女/…」），
 * 不过滤会把别人的性别算到自己头上。
 *
 * @returns {{gender:'male'|'female', reason:string}|null}
 */
function personaGenderOf(attrText, slug) {
  if (!attrText) return null;

  // ① 无名字的「身份/性别」行（优先级最高）
  for (const raw of attrText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 带「X（npc:NNN）：」的行交给 ② 处理，这里跳过，避免误读别人的档案
    if (/（npc:\d+）/.test(line)) continue;
    const m = line.match(PERSONA_LINE);
    if (m) {
      // 文案里只保留干净的中文，别把 markdown 星号带出去
      return {
        gender: m[1] === '男' ? 'male' : 'female',
        reason: `角色属性写明「身份：${m[1]}」`,
      };
    }
  }

  // ② 带名字的档案行：「<slug>（npc:NNN）：…基础：女/…」
  if (slug) {
    const prefix = slug + '（npc:';
    for (const raw of attrText.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith(prefix)) continue;
      const m = line.match(/基础[：:]\s*(女|男)/);
      if (m) {
        return { gender: m[1] === '男' ? 'male' : 'female', reason: `人物档案「${slug}」基础为${m[1]}` };
      }
    }
  }

  return null;
}

/**
 * 从角色自身的叙述文本里找「她是…」「作为女子」这类显式声明。
 *
 * 只认**主语是角色自己**的句子：材料里大量出现「他这句…」「他自己下过山」
 * 这类指代玩家的句子，不加限制会直接把女角色判成男。
 */
function narrativeGenderOf(own, slug) {
  if (!own) return null;
  const sentences = own
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  let fem = 0;
  let male = 0;
  for (const s of sentences) {
    // 只统计主语为角色名/「她」「他」开头的句子，且长度合理
    const isSubjectFem = new RegExp(`^(?:${slug}|她)`).test(s);
    const isSubjectMale = new RegExp(`^(?:${slug}|他)`).test(s);
    if (isSubjectFem && /她|女|姑娘|少女|女子/.test(s)) fem += 1;
    if (isSubjectMale && /他|男|少年|男子/.test(s)) male += 1;
  }
  if (fem > male) return { gender: 'female', reason: `角色自述里偏向女性 ${fem} 句 / 男性 ${male} 句` };
  if (male > fem) return { gender: 'male', reason: `角色自述里偏向男性 ${male} 句 / 女性 ${fem} 句` };
  return null;
}

/**
 * 从 intake 判定 NPC 性别。
 *
 * 优先级（越靠前越可信）：
 *   ① 角色属性里的「身份/性别」字段（21/21 覆盖，最可靠）
 *   ② 人物档案里按 slug 精确匹配的「基础：女/男」
 *   ③ 角色自述里主语明确的性别句
 *   ④ 称谓关键词（少女/公子…）
 *   ⑤ 兜底 defaultGender（decided=false）
 *
 * **刻意不用代词词频**：实测李清月 she=5/he=9、索雅 she=5/he=7，
 * 那些「他」全都指向玩家或其他男性角色，计数法在这种数据结构下必然误判。
 *
 * 绝不读取 `- 性别：` 里属于**玩家**的那一份（identify.js 的 extractGameState 取的是玩家性别）。
 *
 * @returns {{gender:'male'|'female', reason:string, decided:boolean}}
 */
export function detectGender(slug) {
  const file = latestIntake(slug);
  if (!file) return { gender: 'female', reason: '没有 intake 存档，使用默认音色', decided: false };

  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { gender: 'female', reason: '读取 intake 失败，使用默认音色', decided: false };
  }

  const sections = sectionsOf(raw);
  const facts = extractFactBlocks(raw);
  const attr = [sections['角色属性'] || '', facts['角色属性'] || ''].filter(Boolean).join('\n');
  const own = [sections['角色设定'] || '', sections['角色背景'] || ''].filter(Boolean).join('\n');

  // ① / ② 游戏下发的权威字段
  const persona = personaGenderOf(attr, slug);
  if (persona) return { gender: persona.gender, reason: persona.reason, decided: true };

  // ③ 角色自述（主语必须是角色自己）
  const narrative = narrativeGenderOf(own, slug);
  if (narrative) return { gender: narrative.gender, reason: narrative.reason, decided: true };

  if (!attr.trim() && !own.trim()) {
    return { gender: 'female', reason: 'intake 里没有角色设定/属性，使用默认音色', decided: false };
  }

  // ④ 称谓关键词（只在外貌/性格这类角色自身描述里找）
  const fem = FEMALE_HINTS.reduce((n, h) => n + countOccurrences(attr, h), 0);
  const male = MALE_HINTS.reduce((n, h) => n + countOccurrences(attr, h), 0);
  if (fem > male) return { gender: 'female', reason: `角色描述里女性称谓 ${fem} 处 / 男性 ${male} 处`, decided: true };
  if (male > fem) return { gender: 'male', reason: `角色描述里男性称谓 ${male} 处 / 女性 ${fem} 处`, decided: true };

  // ⑤ 兜底：不猜，交给调用方按 defaultGender 处理并提示
  return { gender: 'female', reason: '没有可用的性别线索，使用默认音色', decided: false };
}

/** 该 NPC 是否参与自动朗读（逐 NPC 静音开关）。 */
export function isVoiceEnabled(slug) {
  return slug ? readVoice(slug).enabled : true;
}

export { runPowershell };
