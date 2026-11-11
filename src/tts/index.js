/**
 * TTS 门面：把「文本清洗 + 选音色 + 合成」串成一次调用。
 * 对外只暴露这一层，server.js 不直接碰 synth/voice 的细节。
 */
import { buildSpeechText } from './text.js';
import { listVoices, resolveVoice, readVoice, saveVoice, isVoiceEnabled, invalidateVoiceCache } from './voice.js';
import { synthesize, shutdown, reset } from './synth.js';

export {
  listVoices,
  resolveVoice,
  readVoice,
  saveVoice,
  isVoiceEnabled,
  invalidateVoiceCache,
  buildSpeechText,
  synthesize,
  shutdown,
  reset,
};

/**
 * 把一条 NPC 回复合成为 WAV。
 *
 * @param {{raw:string, slug?:string|null, cfg:object, mode?:'all'|'dialogue'|null}} args
 * @returns {Promise<{ok:boolean, wav?:Buffer, reason?:string, chars:number, text:string,
 *   mode:string, voiceName:string|null, gender:string, synthMs?:number, cached?:boolean,
 *   fallback?:string}>}
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
    return { ok: false, reason: prepared.reason, chars: 0, text: '', mode: prepared.mode, voiceName: null, gender: 'female' };
  }

  const resolved = await resolveVoice(slug, t);
  // 逐 NPC 的语速/音调覆盖全局
  const per = slug ? readVoice(slug) : null;
  const rate = Number.isFinite(per?.rate) ? per.rate : Number(t.rate);
  const pitch = Number.isFinite(per?.pitch) ? per.pitch : Number(t.pitch);

  const r = await synthesize({
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
    ...(prepared.fallback ? { fallback: prepared.fallback } : {}),
  };
}
