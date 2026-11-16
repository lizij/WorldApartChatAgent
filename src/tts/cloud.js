/**
 * 云端 TTS 引擎：目前只支持 DeepSeek（`POST /v1/tools/tts`）。
 *
 * 三条设计约束（见 docs/tts.md §20）：
 *   1. **不回落本地**：云端失败就返回错误、跳过本条朗读，绝不改用别的音色。
 *   2. **配置来源自动判定**：上游 Provider 若是 DeepSeek 就直接复用它的地址与 Key，
 *      否则用 tts.cloud.deepseek 里的独立配置。
 *   3. **磁盘缓存**：合成结果存到 data/npcs/<slug>/tts-cache/，避免同一句重复计费。
 *      缓存 key 只含 hash，文件名里不出现任何台词文本。
 *
 * 实测（2026-11，10 条真实回复）：
 *   - 首音 977~1259 ms（中位约 1050 ms），48 KB/秒（24 kHz / 16 bit / mono）
 *   - 返回的是**流式 WAV**：RIFF 与 data 的长度字段是 0xFFFFFFFF 占位，
 *     必须用 repairStreamingWav() 回填真实长度，否则播放器拒收。
 *   - 不支持 rate/pitch（官方接口没有对应参数）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NPCS_DIR } from '../memory/store.js';
import { repairStreamingWav, wavDataSize } from './util.js';

export const CLOUD_ENGINE_ID = 'deepseek';
export const CLOUD_LABEL = 'DeepSeek';

/** DeepSeek 官方只提供这两个音色（见 api-docs.deepseek.com/zh-cn/api/tts）。 */
export const DEEPSEEK_VOICES = [
  { id: 'stella', label: '海星', gender: 'female' },
  { id: 'tide', label: '暗潮', gender: 'male' },
];

export function voiceById(id) {
  return DEEPSEEK_VOICES.find((v) => v.id === id) || null;
}

/** 已知 DeeepSeek 官方域名——只有精确命中才允许"复用上游配置"。 */
const DEEPSEEK_HOST = 'api.deepseek.com';

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 解析当前生效的云端配置。
 *
 * mode=auto 时：上游 Provider 的 hostname 精确等于 api.deepseek.com 就复用它的
 * 地址与 Key（用户不必二次填写）；否则退回 tts.cloud.deepseek 自己的配置。
 * 不走反代/子域匹配——反代是否支持 TTS 无法确定（见方案讨论）。
 *
 * @param {object} cfg 完整配置
 * @returns {{ready:boolean, source:'upstream'|'manual'|'none', baseUrl:string, apiKey:string, timeoutMs:number, reason:string}}
 */
export function resolveCloudConfig(cfg) {
  const up = cfg?.upstream || {};
  const d = cfg?.tts?.cloud?.deepseek || {};
  const baseUrl = String(d.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const timeoutMs = Math.min(Math.max(Number(d.timeoutMs) || 60000, 5000), 300000);

  const upstreamIsDeepseek = hostOf(up.baseUrl) === DEEPSEEK_HOST;
  const upstreamKey = String(up.apiKey || '').trim();

  if (d.mode !== 'manual' && upstreamIsDeepseek && upstreamKey) {
    return {
      ready: true,
      source: 'upstream',
      baseUrl: String(up.baseUrl).replace(/\/+$/, ''),
      apiKey: upstreamKey,
      timeoutMs,
      reason: '已复用「上游 Provider」的地址与 API Key',
    };
  }

  const ownKey = String(d.apiKey || '').trim();
  if (ownKey) {
    return {
      ready: true,
      source: 'manual',
      baseUrl,
      apiKey: ownKey,
      timeoutMs,
      reason: '使用云端引擎的独立配置',
    };
  }

  return {
    ready: false,
    source: 'none',
    baseUrl,
    apiKey: '',
    timeoutMs,
    reason: upstreamIsDeepseek
      ? '上游 Provider 是 DeepSeek，但没有可用的 API Key'
      : '上游 Provider 不是 DeepSeek，请在本页填写 DeepSeek 的地址与 API Key',
  };
}

// —— 磁盘缓存 ——

/** 缓存目录随 NPC 走：data/npcs/<slug>/tts-cache/。没有 slug 时不缓存。 */
function cacheDirOf(slug) {
  if (!slug) return null;
  const dir = path.join(NPCS_DIR, slug, 'tts-cache');
  return dir;
}

function cacheKeyOf({ baseUrl, voiceId, text }) {
  // 云端不支持 rate/pitch，所以 key 里不需要它们。
  // 把 baseUrl 也算进去：用户换到别的兼容服务时不会拿到旧服务的音频。
  return crypto
    .createHash('sha1')
    .update(`${CLOUD_ENGINE_ID}\u0001${String(baseUrl || '')}\u0001${voiceId}\u0001${text}`)
    .digest('hex')
    .slice(0, 16);
}

function readCache(slug, key) {
  const dir = cacheDirOf(slug);
  if (!dir) return null;
  try {
    const buf = fs.readFileSync(path.join(dir, `${key}.wav`));
    if (wavDataSize(buf) <= 0) return null;
    // 命中后刷新 mtime（LRU 依据；当前不设上限，仅用于将来清理）
    const now = new Date();
    try {
      fs.utimesSync(path.join(dir, `${key}.wav`), now, now);
    } catch {}
    return buf;
  } catch {
    return null;
  }
}

function writeCache(slug, key, buf) {
  const dir = cacheDirOf(slug);
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.wav`), buf);
  } catch {
    // 缓存失败不影响朗读
  }
}

/** 清空某个 NPC 的云端语音缓存；返回删除的文件数。 */
export function clearCache(slug) {
  const dir = cacheDirOf(slug);
  if (!dir) return 0;
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.wav')) continue;
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        n += 1;
      } catch {}
    }
  } catch {}
  return n;
}

/** 统计缓存占用（界面显示用）。 */
export function cacheStats(slug) {
  const dir = cacheDirOf(slug);
  if (!dir) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.wav')) continue;
      try {
        bytes += fs.statSync(path.join(dir, f)).size;
        files += 1;
      } catch {}
    }
  } catch {}
  return { files, bytes };
}

// —— 合成 ——

/** 把 HTTP 状态映射成可读的 reason，方便界面与日志区分。 */
function reasonOfStatus(status) {
  if (status === 400) return 'cloud_content_risk';
  if (status === 401 || status === 403) return 'cloud_auth_failed';
  if (status === 429) return 'cloud_rate_limited';
  if (status === 503) return 'cloud_busy';
  if (status === 504) return 'cloud_timeout';
  return 'cloud_failed';
}

/**
 * 合成一段文本。
 * @param {{text:string, voiceId:string, slug?:string|null, cfg:object}} job
 * @returns {Promise<{ok:boolean, wav?:Buffer, mime?:string, reason?:string, detail?:string, synthMs?:number, cached?:boolean}>}
 */
export async function synthesize({ text, voiceId, slug = null, cfg }) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, reason: 'empty_text' };

  const voice = voiceById(voiceId);
  if (!voice) {
    return {
      ok: false,
      reason: 'voice_unavailable',
      detail: `云端音色「${voiceId}」不可用。程序不会改用其它音色；请到「实验功能 → 音色」重新选择。`,
    };
  }

  const cc = resolveCloudConfig(cfg);
  if (!cc.ready) {
    return {
      ok: false,
      reason: 'engine_unavailable',
      detail: `${cc.reason}。程序不会改用本地音色；请到「实验功能 → 音色 → 云端引擎」配置。`,
    };
  }

  const key = cacheKeyOf({ baseUrl: cc.baseUrl, voiceId: voice.id, text: clean });
  const hit = readCache(slug, key);
  if (hit) return { ok: true, wav: hit, mime: 'audio/wav', cached: true, synthMs: 0 };

  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('cloud_timeout')), cc.timeoutMs);
  try {
    const res = await fetch(`${cc.baseUrl}/v1/tools/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cc.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean, voice_id: voice.id, format: 'wav', filter_markdown: true }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
      return {
        ok: false,
        reason: reasonOfStatus(res.status),
        detail: `HTTP ${res.status}${body ? `：${body}` : ''}`,
        synthMs: Date.now() - started,
      };
    }

    const chunks = [];
    for await (const c of res.body) chunks.push(c);
    const buf = Buffer.concat(chunks);

    const dataBytes = repairStreamingWav(buf);
    if (dataBytes <= 0) {
      return { ok: false, reason: 'tts_empty_audio', detail: '云端返回的音频为空或不是 WAV', synthMs: Date.now() - started };
    }

    writeCache(slug, key, buf);
    return { ok: true, wav: buf, mime: 'audio/wav', synthMs: Date.now() - started };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''));
    return {
      ok: false,
      reason: aborted ? 'cloud_timeout' : 'cloud_failed',
      detail: aborted ? `超过 ${cc.timeoutMs} ms 未返回` : String(err?.message || err).slice(0, 200),
      synthMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 连通性测试：用极短文本探一次，返回状态与耗时（界面「测试」按钮用）。 */
export async function testConnection(cfg) {
  const cc = resolveCloudConfig(cfg);
  if (!cc.ready) return { ok: false, reason: 'engine_unavailable', detail: cc.reason };

  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('cloud_timeout')), Math.min(cc.timeoutMs, 20000));
  try {
    const res = await fetch(`${cc.baseUrl}/v1/tools/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cc.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好。', voice_id: 'stella', format: 'wav' }),
      signal: ac.signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
      return { ok: false, status: res.status, ms, reason: reasonOfStatus(res.status), detail: `HTTP ${res.status}${body ? `：${body}` : ''}` };
    }
    // 把响应体读完，确保音频真的可用
    const chunks = [];
    for await (const c of res.body) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const dataBytes = repairStreamingWav(buf);
    if (dataBytes <= 0) return { ok: false, status: res.status, ms, reason: 'tts_empty_audio', detail: '返回的不是可用音频' };
    return { ok: true, status: res.status, ms, source: cc.source, bytes: buf.length };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''));
    return {
      ok: false,
      ms: Date.now() - started,
      reason: aborted ? 'cloud_timeout' : 'cloud_failed',
      detail: String(err?.message || err).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}
