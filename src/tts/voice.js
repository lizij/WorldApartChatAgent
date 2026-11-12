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
    // Kokoro 专用：具体音色名（zf_xiaoxiao 等）；留空则按 gender 取全局默认
    voice: typeof raw.voice === 'string' ? raw.voice.trim().slice(0, 40) : '',
  };
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
    next.voice = typeof patch.voice === 'string' ? patch.voice.trim().slice(0, 40) : '';
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

const EXPLICIT_FEMALE = /(性别|性別)\s*[：:]\s*女|女(性|子之身)|女修|女性/;
const EXPLICIT_MALE = /(性别|性別)\s*[：:]\s*男|男(性|子之身)|男修|男性/;

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
 * 从 intake 判定 NPC 性别。
 *
 * 只用「角色本身」的材料：
 *   - voice.json 显式设置（由调用方优先处理）
 *   - ## 角色属性 / 【角色属性】（外貌、善恶、性格）
 *   - ## 角色设定 / ## 角色背景
 * **绝不**读取 `- 性别：` 行或 state.lastGame.player（那是玩家）。
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
  const own = [
    sections['角色属性'] || '',
    facts['角色属性'] || '',
    sections['角色设定'] || '',
    sections['角色背景'] || '',
  ]
    .filter(Boolean)
    .join('\n');

  if (!own.trim()) return { gender: 'female', reason: 'intake 里没有角色设定/属性，使用默认音色', decided: false };

  // ① 显式声明（仅限角色自身材料里出现）
  const mf = own.match(EXPLICIT_FEMALE);
  const mm = own.match(EXPLICIT_MALE);
  if (mf && !mm) return { gender: 'female', reason: `角色属性里写明「${mf[0]}」`, decided: true };
  if (mm && !mf) return { gender: 'male', reason: `角色属性里写明「${mm[0]}」`, decided: true };

  // ② 称谓关键词（只在外貌/性格这类角色自身描述里找）
  const look = [sections['角色属性'] || '', facts['角色属性'] || '', sections['角色背景'] || ''].join('\n');
  const fem = FEMALE_HINTS.reduce((n, h) => n + countOccurrences(look, h), 0);
  const male = MALE_HINTS.reduce((n, h) => n + countOccurrences(look, h), 0);
  if (fem > male) return { gender: 'female', reason: `角色描述里女性称谓 ${fem} 处 / 男性 ${male} 处`, decided: true };
  if (male > fem) return { gender: 'male', reason: `角色描述里男性称谓 ${male} 处 / 女性 ${fem} 处`, decided: true };

  // ③ 代词词频（只在角色自身材料里数，避免把玩家描述算进来）
  const she = countOccurrences(own, '她');
  const he = countOccurrences(own, '他');
  if (she > he) return { gender: 'female', reason: `角色描述里「她」×${she}、「他」×${he}`, decided: true };
  if (he > she) return { gender: 'male', reason: `角色描述里「他」×${he}、「她」×${she}`, decided: true };
  if (she && he) return { gender: 'female', reason: `「她」「他」各 ${she} 次，按默认处理`, decided: false };
  return { gender: 'female', reason: '没有性别线索，使用默认音色', decided: false };
}

/**
 * 解析某个 NPC 最终要用的音色。
 * 优先级：全局 male/female → 同性别第一个。
 *
 * **红线：用户显式选过音色名，就只认那一个。** 找不到时返回 `problem`
 * 而不是换成别的音色——静默换人会让玩家在对话中途听到另一个人的声音，
 * 比没有声音更糟（见 docs/tts.md §19）。
 * 只有「用户从没指定音色」时才按性别自动挑。
 *
 * @returns {Promise<{gender:string, voiceName:string|null, reason:string, available:Array, problem:{code:string, detail:string}|null}>}
 */
export async function resolveVoice(slug, cfg) {
  const voices = await listVoices();
  const globalVoices = (cfg && cfg.voices) || {};
  const setting = slug ? readVoice(slug) : { ...DEFAULT_VOICE, gender: 'auto' };

  let gender;
  let reason;
  if (setting.gender === 'male' || setting.gender === 'female') {
    gender = setting.gender;
    reason = `该 NPC 指定为${gender === 'male' ? '男声' : '女声'}`;
  } else {
    const d = slug ? detectGender(slug) : { gender: (cfg && cfg.defaultGender) || 'female', reason: '使用默认音色', decided: false };
    gender = d.gender;
    reason = d.reason;
    // 判定不出来时跟全局兜底（detectGender 固定回 female，这里改按 defaultGender）
    if (!d.decided && (cfg && cfg.defaultGender) === 'male') {
      gender = 'male';
      reason = d.reason + '（按默认男声）';
    }
  }

  // 全局男/女声默认。只要用户配了名字，就必须用它；配了却找不到 → 报错，不替换。
  const configured = String((gender === 'male' ? globalVoices.male : globalVoices.female) || '').trim();
  const genderWord = gender === 'male' ? '男' : '女';
  if (configured) {
    if (voices.some((v) => v.name === configured)) {
      return {
        gender,
        voiceName: configured,
        reason: `${reason}；使用你选择的音色「${configured}」`,
        available: voices,
        problem: null,
      };
    }
    return {
      gender,
      voiceName: null,
      reason,
      available: voices,
      problem: {
        code: 'voice_unavailable',
        detail:
          `你选择的${genderWord}声音色「${configured}」已不在系统语音列表里` +
          '（可能被卸载，或更换了系统语言包）。程序不会改用其它音色；' +
          '请到「实验功能 → 音色」重新选择。',
      },
    };
  }

  // 以下都是「用户没指定音色名」的情形，可以按性别自动挑。
  const sameGender = voices.find((v) => v.gender === gender);
  if (sameGender) {
    return { gender, voiceName: sameGender.name, reason: `${reason}；按性别自动选中`, available: voices, problem: null };
  }

  if (!voices.length) {
    return {
      gender,
      voiceName: null,
      reason: `${reason}；系统里没有可用的中文语音`,
      available: voices,
      problem: { code: 'tts_no_voice', detail: '系统里没有可用的中文语音。' },
    };
  }

  // 系统里没有该性别的语音。若这个性别是玩家为角色**显式指定的**，
  // 跨性别替换同样算"换了音色"，必须报错；自动判定出来的性别则允许兜底。
  if (setting.gender === 'male' || setting.gender === 'female') {
    return {
      gender,
      voiceName: null,
      reason,
      available: voices,
      problem: {
        code: 'voice_unavailable',
        detail: `你为该角色指定了${genderWord}声，但系统里没有${genderWord}声语音。程序不会改用其它性别的声音。`,
      },
    };
  }

  return {
    gender,
    voiceName: voices[0].name,
    reason: `${reason}；系统里没有${genderWord}声，按第一个语音兜底`,
    available: voices,
    problem: null,
  };
}

/** 该 NPC 是否参与自动朗读（逐 NPC 静音开关）。 */
export function isVoiceEnabled(slug) {
  return slug ? readVoice(slug).enabled : true;
}

export { runPowershell };
