/**
 * Kokoro 引擎：sherpa-onnx + Kokoro-82M（int8）离线神经 TTS。
 *
 * 为什么单开一个文件：它与 Windows 引擎的差别很大——
 *   - 走独立的 C++ 可执行文件（sherpa-onnx-offline-tts.exe），不是 PowerShell + WinRT；
 *   - 运行时 + 模型共约 159 MB，因此**不进 exe**，放在 exe 同层的 tts-engines/ 里，
 *     由管理页点一下下载（见 docs/tts.md §14.5）。放 exe 同层而不是 data/ 内，
 *     是为了让正式档与测试档共用一份，避免重复下载 144 MB；
 *   - 每次调用都要重新加载模型（实测约 1.6 s），且合成速度约为实时的 0.9 倍（RTF≈1.11），
 *     所以 MUST 单并发、长超时，并给足进度反馈。
 *
 * 只暴露 3 个中文音色（玩家选定）：
 *   zf_xiaoxiao(47, 女) / zf_xiaoyi(48, 女) / zm_yunxi(50, 男)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { ensureTmpDir, wavDataSize } from './util.js';
import { ensureModelAssembled } from './assemble.js';

const TIMEOUT_MS = 180000;
/** 只允许一个 Kokoro 进程在跑：它会吃满 CPU，并发只会互相拖慢。 */
const MAX_CONCURRENCY = 1;
const CACHE_MAX = 8;

export const ENGINE_ROOT = path.join(path.dirname(DATA_DIR), 'tts-engines');
export const ENGINE_DIR = path.join(ENGINE_ROOT, 'kokoro');
export const RUNTIME_DIR = path.join(ENGINE_DIR, 'runtime');
export const EXE_PATH = path.join(RUNTIME_DIR, 'sherpa-onnx-offline-tts.exe');
export const DLL_PATH = path.join(RUNTIME_DIR, 'onnxruntime.dll');

/** 模型文件（放在 ENGINE_DIR 下）。 */
export const MODEL_FILES = [
  'model.int8.onnx',
  'voices.bin',
  'tokens.txt',
  'lexicon-zh.txt',
  'lexicon-us-en.txt',
  'number-zh.fst',
  'date-zh.fst',
  'phone-zh.fst',
];

/**
 * 可选音色（玩家挑选的 3 个）。
 * sid 与 Kokoro 说话人编号一一对应，改动前请核对官方 speaker 映射。
 */
export const KOKORO_VOICES = [
  { name: 'zf_xiaoxiao', sid: 47, gender: 'female', label: '晓晓（女）' },
  { name: 'zf_xiaoyi', sid: 48, gender: 'female', label: '小艺（女）' },
  { name: 'zm_yunxi', sid: 50, gender: 'male', label: '云希（男）' },
];

export function voiceByName(name) {
  return KOKORO_VOICES.find((v) => v.name === name) || null;
}

/** 是否已做过一次分片检查（避免每次 isInstalled 都扫目录）。 */
let assembledChecked = false;

/** 运行时 + 模型是否齐备。 */
export function isInstalled() {
  // 仓库里存的是模型分片（单文件超 GitHub 100 MiB 限制），首次检查时拼回完整模型。
  // 只会真正拼接一次：完整文件存在后直接跳过。
  if (!assembledChecked) {
    assembledChecked = true;
    const r = ensureModelAssembled(ENGINE_DIR);
    if (r.assembled) {
      console.log(`[tts] 已由分片拼回模型（${(fs.statSync(path.join(ENGINE_DIR, 'model.int8.onnx')).size / 1048576).toFixed(1)} MB）`);
    }
  }
  if (!fs.existsSync(EXE_PATH) || !fs.existsSync(DLL_PATH)) return false;
  return MODEL_FILES.every((f) => {
    try {
      return fs.statSync(path.join(ENGINE_DIR, f)).size > 0;
    } catch {
      return false;
    }
  });
}

function filePath(name) {
  return path.join(ENGINE_DIR, name);
}

// —— 缓存 / 队列 ——

const cache = new Map();
let running = 0;
const waiting = [];
const inflight = new Set();
let stopping = false;

function acquire() {
  if (stopping) return Promise.reject(new Error('tts_stopping'));
  if (running < MAX_CONCURRENCY) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
}

function release() {
  running = Math.max(0, running - 1);
  if (stopping) return;
  const next = waiting.shift();
  if (next) {
    running += 1;
    next.resolve();
  }
}

function fingerprint(parts) {
  return crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex');
}

/** 供上层判断"这条要等多久"：按实测 RTF 粗估（毫秒）。 */
export function estimateMs({ chars }) {
  const audioSec = chars * 0.21; // 实测中文约 0.21 s/字
  return Math.round(1600 + audioSec * 1100);
}

/**
 * 合成一段文本。
 * @param {{text:string, voice:string, rate?:number|null, threads?:number}} job
 * @returns {Promise<{ok:boolean, wav?:Buffer, reason?:string, synthMs?:number, cached?:boolean, detail?:string}>}
 */
export async function synthesize(job) {
  const text = String(job.text || '').trim();
  if (!text) return { ok: false, reason: 'empty_text' };
  if (!isInstalled()) return { ok: false, reason: 'kokoro_not_installed' };

  const voice = voiceByName(job.voice) || voiceByName('zf_xiaoxiao');
  const threads = Math.min(Math.max(Number(job.threads) || 4, 1), 8);
  // rate 越大越快；长度缩放与它相反
  const rate = Number.isFinite(Number(job.rate)) && Number(job.rate) > 0 ? Number(job.rate) : 1;
  const lengthScale = Math.round((1 / rate) * 100) / 100;

  const key = fingerprint([text, voice.name, String(lengthScale), String(threads)]);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return { ok: true, wav: hit, cached: true };
  }

  try {
    await acquire();
  } catch {
    return { ok: false, reason: 'tts_stopping' };
  }

  const dir = ensureTmpDir();
  const seq = crypto.randomBytes(4).toString('hex');
  const outFile = path.join(dir, `kokoro-${process.pid}-${seq}.wav`);
  const started = Date.now();

  try {
    const args = [
      `--kokoro-model=${filePath('model.int8.onnx')}`,
      `--kokoro-voices=${filePath('voices.bin')}`,
      `--kokoro-tokens=${filePath('tokens.txt')}`,
      `--kokoro-lexicon=${[filePath('lexicon-us-en.txt'), filePath('lexicon-zh.txt')].join(',')}`,
      `--tts-rule-fsts=${[filePath('number-zh.fst'), filePath('date-zh.fst'), filePath('phone-zh.fst')].join(',')}`,
      `--kokoro-length-scale=${lengthScale}`,
      `--num-threads=${threads}`,
      `--sid=${voice.sid}`,
      `--output-filename=${outFile}`,
      text,
    ];

    await new Promise((resolve, reject) => {
      let child;
      const done = (err, _stdout, stderr) => {
        if (child) inflight.delete(child);
        if (err) {
          const killed = err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
          const e = new Error(killed ? 'tts_timeout' : 'kokoro_failed');
          e.detail = String(stderr || err.message || '').slice(0, 240);
          return reject(e);
        }
        resolve();
      };
      try {
        child = execFile(EXE_PATH, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, cwd: RUNTIME_DIR }, done);
      } catch (err) {
        const e = new Error('kokoro_failed');
        e.detail = String(err?.message || err).slice(0, 240);
        return reject(e);
      }
      if (child) inflight.add(child);
    });

    let buf = null;
    try {
      buf = fs.readFileSync(outFile);
    } catch {}
    if (!buf || wavDataSize(buf) <= 0) {
      return { ok: false, reason: 'tts_empty_audio', synthMs: Date.now() - started };
    }

    cache.set(key, buf);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { ok: true, wav: buf, synthMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message === 'tts_timeout' ? 'tts_timeout' : err?.message === 'tts_stopping' ? 'tts_stopping' : 'kokoro_failed',
      detail: err?.detail || null,
      synthMs: Date.now() - started,
    };
  } finally {
    try {
      fs.rmSync(outFile, { force: true });
    } catch {}
    release();
  }
}

export function shutdown() {
  stopping = true;
  for (const c of inflight) {
    try {
      c.kill();
    } catch {}
  }
  inflight.clear();
  for (const w of waiting.splice(0)) {
    try {
      w.reject(new Error('tts_stopping'));
    } catch {}
  }
  running = 0;
  cache.clear();
}

export function reset() {
  stopping = false;
  running = 0;
  for (const w of waiting.splice(0)) {
    try {
      w.reject(new Error('tts_reset'));
    } catch {}
  }
  inflight.clear();
}
