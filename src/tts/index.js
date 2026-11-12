/**
 * TTS 门面：选引擎 → 清洗文本 → 选音色 → 合成。
 * server.js 只调这一层，不直接碰各引擎细节。
 *
 * 引擎：
 *   windows  — 系统自带 WinRT 语音（默认，零下载、极快）
 *   kokoro   — sherpa-onnx + Kokoro-82M int8（需下载约 156 MB，音质最好但慢）
 *
 * 任一引擎不可用或合成失败时**都不换音色**：直接返回错误（reason 见下），
 * 由管理页提示玩家重选或修引擎。静默换成另一个人的声音比没声音更糟。
 * 见 docs/tts.md §19「选定的音色不得被替换」。
 */
import { buildSpeechText } from './text.js';
import { listVoices, resolveVoice, readVoice, saveVoice, isVoiceEnabled, detectGender } from './voice.js';
import * as windowsEngine from './synth.js';
import * as kokoroEngine from './kokoro.js';
import { install as installKokoro, status as kokoroStatus, installState } from './install.js';

export { listVoices, resolveVoice, readVoice, saveVoice, isVoiceEnabled, buildSpeechText };
export { installKokoro, kokoroStatus, installState };
export const KOKORO_VOICES = kokoroEngine.KOKORO_VOICES;
export const isKokoroInstalled = kokoroEngine.isInstalled;
export const synthesizeKokoro = kokoroEngine.synthesize;
/** Windows 引擎的合成入口（试听/调试用；日常朗读走 speak()）。 */
export const synthesize = windowsEngine.synthesize;

export const ENGINE_IDS = ['windows', 'kokoro'];

export function engineLabel(id) {
  return id === 'kokoro' ? 'Kokoro（离线神经语音）' : 'Windows 内置语音';
}

/** 当前实际可用/被选中的引擎。 */
export function activeEngine(cfg) {
  const want = cfg?.tts?.engine === 'kokoro' ? 'kokoro' : 'windows';
  if (want === 'kokoro' && kokoroEngine.isInstalled()) return 'kokoro';
  return 'windows';
}

export function shutdown() {
  windowsEngine.shutdown();
  kokoroEngine.shutdown();
}

export function reset() {
  windowsEngine.reset();
  kokoroEngine.reset();
}

/** Kokoro 下按性别选音色：逐 NPC 指定优先，其次 detectGender，最后全局默认。 */
function kokoroGenderOf(slug, t) {
  const setting = slug ? readVoice(slug) : { gender: 'auto' };
  if (setting.gender === 'male' || setting.gender === 'female') {
    return { gender: setting.gender, reason: '该 NPC 指定' };
  }
  if (!slug) return { gender: t?.defaultGender === 'male' ? 'male' : 'female', reason: '默认音色' };
  const d = detectGender(slug);
  if (d.decided) return { gender: d.gender, reason: d.reason };
  return { gender: t?.defaultGender === 'male' ? 'male' : 'female', reason: d.reason };
}

/** Kokoro 音色（逐 NPC 指定优先，其次按性别取全局默认）。 */
function kokoroVoiceFor(slug, cfg, gender) {
  const per = slug ? readVoice(slug) : null;
  const explicit = per && typeof per.voice === 'string' ? per.voice.trim() : '';
  if (explicit) {
    const v = kokoroEngine.voiceByName(explicit);
    if (v) return { voice: v, problem: null };
    // 用户显式指定过 Kokoro 音色，但名字不认识（改过 config / 引擎版本变化）→ 报错，不替换
    return {
      voice: null,
      problem: {
        code: 'voice_unavailable',
        detail: `该角色指定的 Kokoro 音色「${explicit}」不可用。程序不会改用其它音色；请到「NPC 记忆」页重新选择。`,
      },
    };
  }
  const k = cfg?.tts?.kokoro || {};
  const want = gender === 'male' ? k.voiceMale : k.voiceFemale;
  if (want) {
    const v = kokoroEngine.voiceByName(want);
    if (v) return { voice: v, problem: null };
    return {
      voice: null,
      problem: {
        code: 'voice_unavailable',
        detail: `你配置的 Kokoro ${gender === 'male' ? '男' : '女'}声音色「${want}」不可用。程序不会改用其它音色；请到「实验功能 → 音色」重新选择。`,
      },
    };
  }
  // 用户没配 Kokoro 音色：按性别自动挑（这不是"用户选择了音色"）
  const fallback = kokoroEngine.voiceByName(gender === 'male' ? 'zm_yunxi' : 'zf_xiaoxiao');
  return { voice: fallback, problem: null };
}

/** 供 server 复用同一套严格解析（NPC 详情页要显示"音色已失效"）。 */
export const pickKokoroVoice = kokoroVoiceFor;
export const kokoroGenderFor = kokoroGenderOf;
export const resolveWindowsVoice = resolveVoice;

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
    return { ok: false, reason: prepared.reason, chars: 0, text: '', mode: prepared.mode, voiceName: null, gender: 'female', engine: 'windows' };
  }

  const per = slug ? readVoice(slug) : null;
  const rate = Number.isFinite(per?.rate) ? per.rate : Number(t.rate);
  const pitch = Number.isFinite(per?.pitch) ? per.pitch : Number(t.pitch);

  const wanted = t.engine === 'kokoro' ? 'kokoro' : 'windows';
  // 用户选了 Kokoro 就必须是 Kokoro。引擎缺失时**不**改用系统语音，
  // 否则等于把用户选的音色偷偷换掉（见 docs/tts.md §19）。
  if (wanted === 'kokoro' && !kokoroEngine.isInstalled()) {
    return {
      ok: false,
      reason: 'engine_unavailable',
      detail:
        '你选择了 Kokoro 音色，但没找到 Kokoro 引擎（tts-engines/kokoro）。' +
        '程序不会改用系统语音；请重新安装引擎，或到「实验功能 → 音色」改选系统语音。',
      synthMs: 0,
      chars: prepared.chars,
      text: prepared.text,
      mode: prepared.mode,
      voiceName: null,
      gender: t?.defaultGender === 'male' ? 'male' : 'female',
      engine: 'kokoro',
      ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
    };
  }

  if (wanted === 'kokoro') {
    const g = kokoroGenderOf(slug, t);
    const picked = kokoroVoiceFor(slug, cfg, g.gender);
    if (picked.problem) {
      return {
        ok: false,
        reason: picked.problem.code,
        detail: picked.problem.detail,
        synthMs: 0,
        chars: prepared.chars,
        text: prepared.text,
        mode: prepared.mode,
        voiceName: null,
        gender: g.gender,
        engine: 'kokoro',
        ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
      };
    }
    const v = picked.voice;
    const r = await kokoroEngine.synthesize({
      text: prepared.text,
      voice: v.name,
      rate: Number.isFinite(rate) ? rate : 1,
      threads: t.kokoro?.threads,
    });
    if (r.ok) {
      return {
        ...r,
        chars: prepared.chars,
        text: prepared.text,
        mode: prepared.mode,
        voiceName: v.name,
        voiceLabel: v.label,
        gender: v.gender,
        engine: 'kokoro',
        ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
      };
    }
    // Kokoro 合成失败同样**不**回退系统语音：换了音色比没声音更糟。
    return {
      ...r,
      ok: false,
      reason: r.reason || 'kokoro_failed',
      chars: prepared.chars,
      text: prepared.text,
      mode: prepared.mode,
      voiceName: v.name,
      voiceLabel: v.label,
      gender: v.gender,
      engine: 'kokoro',
      ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
    };
  }

  const resolved = await resolveVoice(slug, t);
  if (resolved.problem) {
    return {
      ok: false,
      reason: resolved.problem.code,
      detail: resolved.problem.detail,
      synthMs: 0,
      chars: prepared.chars,
      text: prepared.text,
      mode: prepared.mode,
      voiceName: null,
      gender: resolved.gender,
      engine: 'windows',
      ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
    };
  }
  const r = await windowsEngine.synthesize({
    text: prepared.text,
    voice: resolved.voiceName,
    rate: Number.isFinite(rate) ? rate : null,
    pitch: Number.isFinite(pitch) ? pitch : null,
  });

  return {
    ...r,
    chars: prepared.chars,
    text: prepared.text,
    mode: prepared.mode,
    voiceName: resolved.voiceName,
    gender: resolved.gender,
    engine: 'windows',
    ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
  };
}
