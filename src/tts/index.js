/**
 * TTS 门面：选引擎 → 清洗文本 → 选音色 → 合成。
 * server.js 只调这一层，不直接碰各引擎细节。
 *
 * 引擎：
 *   windows  — 系统自带 WinRT 语音（默认，零下载、极快）
 *   kokoro   — sherpa-onnx + Kokoro-82M int8（需下载约 156 MB，音质最好但慢）
 *
 * 任一引擎失败/未安装时**自动回退**到 windows，只记一条日志，不打断朗读。
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
  const explicit = per && typeof per.voice === 'string' ? per.voice : '';
  if (explicit && kokoroEngine.voiceByName(explicit)) return kokoroEngine.voiceByName(explicit);
  const k = cfg?.tts?.kokoro || {};
  const want = gender === 'male' ? k.voiceMale : k.voiceFemale;
  return kokoroEngine.voiceByName(want) || kokoroEngine.voiceByName(gender === 'male' ? 'zm_yunxi' : 'zf_xiaoxiao');
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
    return { ok: false, reason: prepared.reason, chars: 0, text: '', mode: prepared.mode, voiceName: null, gender: 'female', engine: 'windows' };
  }

  const per = slug ? readVoice(slug) : null;
  const rate = Number.isFinite(per?.rate) ? per.rate : Number(t.rate);
  const pitch = Number.isFinite(per?.pitch) ? per.pitch : Number(t.pitch);

  const wanted = t.engine === 'kokoro' ? 'kokoro' : 'windows';
  let engine = wanted === 'kokoro' && kokoroEngine.isInstalled() ? 'kokoro' : 'windows';
  // 引擎回退原因与「文本回退到全部内容」是两个不同的信号：
  // 前者放 engineFallback，避免与 text.js 的 fallback（dialogue_empty）互相覆盖。
  let engineFallback = null;

  if (engine === 'kokoro') {
    const g = kokoroGenderOf(slug, t);
    const v = kokoroVoiceFor(slug, cfg, g.gender);
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
    // Kokoro 失败：回退到系统语音，别让玩家没声音
    engine = 'windows';
    engineFallback = r.reason || 'kokoro_failed';
  }

  const resolved = await resolveVoice(slug, t);
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
    ...(engineFallback ? { engineFallback } : {}),
    ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
  };
}
