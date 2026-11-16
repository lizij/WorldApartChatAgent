/**
 * TTS 门面：清洗文本 → 解析音色 → 按音色 ID 派发到对应引擎 → 合成。
 * server.js 只调这一层，不直接碰各引擎细节。
 *
 * 引擎（音色 ID 形如 `<engine>:<voice>`）：
 *   windows  — 系统自带 WinRT 语音（零下载、极快）
 *   kokoro   — sherpa-onnx + Kokoro-82M int8（需下载约 159 MB，音质最好但慢）
 *   deepseek — 云端 DeepSeek TTS（联网、按字符计费、首音约 1 秒）
 *
 * 任一引擎不可用或合成失败时**都不换音色**：直接返回错误，
 * 由管理页提示玩家重选或修引擎。静默换成另一个人的声音比没声音更糟。
 * 见 docs/tts.md §19「选定的音色不得被替换」。
 */
import { buildSpeechText } from './text.js';
import { readVoice, saveVoice, isVoiceEnabled, detectGender, listVoices } from './voice.js';
import * as windowsEngine from './synth.js';
import * as kokoroEngine from './kokoro.js';
import * as cloudEngine from './cloud.js';
import * as registry from './engine.js';
import { install as installKokoro, status as kokoroStatus, installState } from './install.js';

export { listVoices, readVoice, saveVoice, isVoiceEnabled, buildSpeechText, detectGender };
export { installKokoro, kokoroStatus, installState };
export const KOKORO_VOICES = kokoroEngine.KOKORO_VOICES;
export const DEEPSEEK_VOICES = cloudEngine.DEEPSEEK_VOICES;
export const isKokoroInstalled = kokoroEngine.isInstalled;
export const synthesizeKokoro = kokoroEngine.synthesize;
/** Windows 引擎的合成入口（试听/调试用；日常朗读走 speak()）。 */
export const synthesize = windowsEngine.synthesize;

export const ENGINE_IDS = registry.ENGINE_IDS;
export const ENGINE_LABEL = registry.ENGINE_LABEL;
export const ENGINE_KIND = registry.ENGINE_KIND;
export const parseVoiceId = registry.parseVoiceId;
export const makeVoiceId = registry.makeVoiceId;
export const listAllVoices = registry.listAllVoices;
export const resolveVoiceById = registry.resolveVoiceById;
export const engineStatus = registry.engineStatus;
export const synthesizeById = registry.synthesizeById;

/** 云端引擎：配置解析、连通性测试、缓存管理。 */
export const resolveCloudConfig = cloudEngine.resolveCloudConfig;
export const testCloudConnection = cloudEngine.testConnection;
export const clearCloudCache = cloudEngine.clearCache;
export const cloudCacheStats = cloudEngine.cacheStats;

/** 兼容旧调用方：取某引擎的显示名。 */
export function engineLabel(id) {
  return registry.ENGINE_LABEL[id] || id || 'Windows';
}

export function shutdown() {
  windowsEngine.shutdown();
  kokoroEngine.shutdown();
}

export function reset() {
  windowsEngine.reset();
  kokoroEngine.reset();
}

/** 该 NPC 的性别与依据：逐 NPC 指定优先，其次 detectGender，最后 defaultGender。 */
function genderOf(slug, t) {
  const setting = slug ? readVoice(slug) : { gender: 'auto' };
  if (setting.gender === 'male' || setting.gender === 'female') {
    return { gender: setting.gender, reason: `该 NPC 指定为${setting.gender === 'male' ? '男声' : '女声'}` };
  }
  if (!slug) return { gender: t?.defaultGender === 'male' ? 'male' : 'female', reason: '使用默认音色' };
  const d = detectGender(slug);
  if (d.decided) return { gender: d.gender, reason: d.reason };
  return {
    gender: t?.defaultGender === 'male' ? 'male' : 'female',
    reason: d.reason + (t?.defaultGender === 'male' ? '（按默认男声）' : '（按默认女声）'),
  };
}

/**
 * 选出某个 NPC 最终要用的音色（统一 ID）。
 *
 * **红线**：逐 NPC 指定 / 全局男女声如果配了具体音色，就只认那一个；
 * 拿不到就报错，不换音色、不换引擎。只有从没配过时才按性别自动挑。
 *
 * @returns {Promise<{voice:object|null, gender:string, reason:string, problem:object|null}>}
 */
export async function pickVoice(slug, cfg) {
  const t = cfg?.tts || {};
  const g = genderOf(slug, t);
  const gender = g.gender;
  const setting = slug ? readVoice(slug) : null;

  // ① 逐 NPC 显式指定
  const explicit = setting && typeof setting.voice === 'string' ? setting.voice.trim() : '';
  if (explicit) {
    const r = await registry.resolveVoiceById(explicit, cfg);
    if (r.problem) {
      return {
        voice: null,
        gender,
        reason: g.reason,
        problem: {
          code: r.problem.code,
          detail: r.problem.detail.replace('请重新选择', '请到「NPC 记忆」页重新选择'),
        },
      };
    }
    return { voice: r.voice, gender: r.voice.gender, reason: `${g.reason}；该角色指定了音色`, problem: null };
  }

  // ② 全局男/女声
  const configured = String((gender === 'male' ? t.voices?.male : t.voices?.female) || '').trim();
  if (configured) {
    const r = await registry.resolveVoiceById(configured, cfg);
    if (r.problem) {
      return {
        voice: null,
        gender,
        reason: g.reason,
        problem: {
          code: r.problem.code,
          detail: r.problem.detail.replace('请重新选择', '请到「实验功能 → 音色」重新选择'),
        },
      };
    }
    return { voice: r.voice, gender, reason: `${g.reason}；使用你选择的音色「${r.voice.label}」`, problem: null };
  }

  // ③ 从没配过：按性别自动挑（这不算"替换用户的选择"）
  const all = await registry.listAllVoices(cfg);
  const pick = all.find((v) => v.gender === gender && v.available) || all.find((v) => v.available);
  if (!pick) {
    return {
      voice: null,
      gender,
      reason: g.reason,
      problem: { code: 'tts_no_voice', detail: '没有任何可用的音色，请先在「实验功能 → 音色」里配置。' },
    };
  }
  return { voice: pick, gender, reason: `${g.reason}；自动选中第一个可用音色`, problem: null };
}

/**
 * 朗读一条 NPC 回复。
 * @param {{raw:string, slug?:string|null, cfg:object, mode?:'all'|'dialogue'|null}} args
 */
export async function speak({ raw, slug = null, cfg, mode = null }) {
  const t = cfg?.tts || {};
  const readMode = mode === 'dialogue' || mode === 'all' ? mode : t.readMode === 'dialogue' ? 'dialogue' : 'all';

  const prepared = buildSpeechText(raw, {
    mode: readMode,
    skipActions: t.skipActions !== false,
    maxChars: t.maxChars || 600,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      reason: prepared.reason,
      chars: 0,
      text: '',
      mode: prepared.mode,
      voiceId: null,
      voiceName: null,
      gender: 'female',
      engine: 'windows',
    };
  }

  const per = slug ? readVoice(slug) : null;
  const rate = Number.isFinite(per?.rate) ? per.rate : Number(t.rate);
  const pitch = Number.isFinite(per?.pitch) ? per.pitch : Number(t.pitch);

  const picked = await pickVoice(slug, cfg);
  if (picked.problem) {
    return {
      ok: false,
      reason: picked.problem.code,
      detail: picked.problem.detail,
      synthMs: 0,
      chars: prepared.chars,
      text: prepared.text,
      mode: prepared.mode,
      voiceId: null,
      voiceName: null,
      gender: picked.gender,
      engine: null,
      ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
    };
  }

  const v = picked.voice;
  const r = await registry.synthesizeById({ voice: v, text: prepared.text, slug, cfg, rate, pitch });

  return {
    ...r,
    ok: !!r.ok,
    chars: prepared.chars,
    text: prepared.text,
    mode: prepared.mode,
    voiceId: v.id,
    voiceName: v.voice,
    voiceLabel: v.label,
    engine: v.engine,
    engineLabel: v.engineLabel,
    kind: v.kind,
    gender: v.gender,
    ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
  };
}
