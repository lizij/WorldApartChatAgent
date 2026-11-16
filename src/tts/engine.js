/**
 * TTS 引擎注册表：把所有引擎的音色汇总成一份**统一清单**，音色 ID 为
 * `<engine>:<voice>`（如 `windows:Microsoft Huihui`、`deepseek:stella`）。
 *
 * 这样男声可以用本地引擎、女声用云端引擎，混合搭配不需要额外结构；
 * 以后加新引擎只要在这里注册，配置与界面都不用改。
 *
 * 见 docs/tts.md §20。
 */
import * as windowsEngine from './synth.js';
import * as kokoroEngine from './kokoro.js';
import * as cloudEngine from './cloud.js';
import { listVoices as listWindowsVoices } from './voice.js';

export const ENGINE_KIND = { windows: 'local', kokoro: 'local', deepseek: 'cloud' };
export const ENGINE_LABEL = { windows: 'Windows', kokoro: 'Kokoro', deepseek: 'DeepSeek' };
export const ENGINE_IDS = Object.keys(ENGINE_LABEL);

/** 统一音色 ID 的解析：`<engine>:<voice>`；没有前缀时按 windows 处理（兼容旧值）。 */
export function parseVoiceId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const i = s.indexOf(':');
  if (i < 0) return { engine: 'windows', voice: s, id: `windows:${s}` };
  const engine = s.slice(0, i);
  const voice = s.slice(i + 1).trim();
  if (!ENGINE_IDS.includes(engine) || !voice) return null;
  return { engine, voice, id: `${engine}:${voice}` };
}

export function makeVoiceId(engine, voice) {
  return `${engine}:${voice}`;
}

/**
 * 列出全部可选音色（含不可用的，前端据此置灰而不是隐藏）。
 *
 * 每项：{ id, engine, engineLabel, kind, voice, label, gender, available, note }
 *   available=false 时 note 说明原因（Kokoro 未安装 / 云端未配置…）
 */
export async function listAllVoices(cfg, { force = false } = {}) {
  const out = [];

  // —— Windows 内置语音 ——
  const win = await listWindowsVoices({ force });
  const winReady = win.length > 0;
  for (const v of win) {
    out.push({
      id: makeVoiceId('windows', v.name),
      engine: 'windows',
      engineLabel: ENGINE_LABEL.windows,
      kind: 'local',
      voice: v.name,
      label: v.name,
      gender: v.gender,
      available: true,
      note: '',
    });
  }
  if (!winReady) {
    out.push({
      id: 'windows:',
      engine: 'windows',
      engineLabel: ENGINE_LABEL.windows,
      kind: 'local',
      voice: '',
      label: '（系统里没有可用的中文语音）',
      gender: 'female',
      available: false,
      note: '请在 Windows「设置 → 时间和语言 → 语音」中添加中文语音包',
    });
  }

  // —— Kokoro ——
  const kokoroReady = kokoroEngine.isInstalled();
  for (const v of kokoroEngine.KOKORO_VOICES) {
    out.push({
      id: makeVoiceId('kokoro', v.name),
      engine: 'kokoro',
      engineLabel: ENGINE_LABEL.kokoro,
      kind: 'local',
      voice: v.name,
      label: v.label,
      gender: v.gender,
      available: kokoroReady,
      note: kokoroReady ? '' : 'Kokoro 引擎未安装，请先在下方下载',
    });
  }

  // —— DeepSeek（云端）——
  const cloud = cloudEngine.resolveCloudConfig(cfg);
  for (const v of cloudEngine.DEEPSEEK_VOICES) {
    out.push({
      id: makeVoiceId('deepseek', v.id),
      engine: 'deepseek',
      engineLabel: ENGINE_LABEL.deepseek,
      kind: 'cloud',
      voice: v.id,
      label: v.label,
      gender: v.gender,
      available: cloud.ready,
      note: cloud.ready ? '' : cloud.reason,
    });
  }

  return out;
}

/** 按统一 ID 查音色；找不到或不可用时返回 null 之外的信息，便于给出精确原因。 */
export async function resolveVoiceById(id, cfg, { force = false } = {}) {
  const parsed = parseVoiceId(id);
  if (!parsed) return { voice: null, problem: { code: 'voice_unavailable', detail: `音色「${id}」格式不正确。` } };

  const all = await listAllVoices(cfg, { force });
  const hit = all.find((v) => v.id === parsed.id);
  if (!hit) {
    return {
      voice: null,
      problem: {
        code: 'voice_unavailable',
        detail: `音色「${parsed.id}」不在可选清单里。程序不会改用其它音色；请重新选择。`,
      },
    };
  }
  if (!hit.available) {
    return {
      voice: null,
      problem: {
        code: hit.kind === 'cloud' ? 'engine_unavailable' : 'voice_unavailable',
        detail: `音色「${hit.id}」当前不可用：${hit.note || '原因未知'}。程序不会改用其它音色。`,
      },
    };
  }
  return { voice: hit, problem: null };
}

/** 各引擎的可用状态（界面显示与 /api/tts/voices 用）。 */
export function engineStatus(cfg) {
  const cloud = cloudEngine.resolveCloudConfig(cfg);
  const kokoro = kokoroEngine.isInstalled() ? { installed: true, bytes: 0 } : { installed: false, bytes: 0 };
  return {
    windows: { kind: 'local', label: ENGINE_LABEL.windows, ready: true },
    kokoro: { kind: 'local', label: ENGINE_LABEL.kokoro, ready: kokoro.installed },
    deepseek: {
      kind: 'cloud',
      label: ENGINE_LABEL.deepseek,
      ready: cloud.ready,
      source: cloud.source,
      reason: cloud.reason,
      cache: 'disk',
    },
  };
}

/**
 * 按音色 ID 合成。
 * @returns {Promise<{ok:boolean, wav?:Buffer, mime?:string, reason?:string, detail?:string, ...}>}
 */
export async function synthesizeById({ voice: v, text, slug = null, cfg, rate, pitch }) {
  const engine = v.engine;
  if (engine === 'windows') {
    const r = await windowsEngine.synthesize({ text, voice: v.voice, rate, pitch });
    return { ...r, mime: 'audio/wav' };
  }
  if (engine === 'kokoro') {
    const r = await kokoroEngine.synthesize({
      text,
      voice: v.voice,
      rate: Number.isFinite(rate) ? rate : 1,
      threads: cfg?.tts?.kokoro?.threads,
    });
    return { ...r, mime: 'audio/wav' };
  }
  if (engine === 'deepseek') {
    // 云端不支持 rate/pitch，忽略即可（界面会说明）
    return cloudEngine.synthesize({ text, voiceId: v.voice, slug, cfg });
  }
  return { ok: false, reason: 'engine_unavailable', detail: `未知引擎「${engine}」` };
}
