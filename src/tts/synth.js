/**
 * 语音合成：Node → 内联 PowerShell 脚本 → WinRT SpeechSynthesizer → WAV。
 *
 * 为什么这么绕：中文男声（Microsoft Kangkang）只在 WinRT 里注册，经典
 * System.Speech 只有女声（Huihui）。而 Node 没有直接调 WinRT 的零依赖方案，
 * 所以借一次 powershell.exe 过去。运行时仍是零第三方依赖。
 *
 * 硬性约束（实测得出，见 docs/tts.md §12）：
 *   - 文本/音色只放 job 文件，路径走环境变量，不拼命令行（避免转义与注入）；
 *   - 成功时 stderr 也有 CLIXML 噪音 → 只看退出码 + 文件大小（> 44 字节）；
 *   - 空文本会产出 46 字节空 WAV → 调用方必须先拒绝空文本；
 *   - 子进程必须可被杀（关窗即退），因此全部登记在 inflight 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { ensureTmpDir, wavDataSize, numOrNull } from './util.js';

const TIMEOUT_MS = 20000;
const MAX_CONCURRENCY = 2;
const CACHE_MAX = 20;

const TMP_DIR = path.join(DATA_DIR, 'tmp', 'tts');

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -Encoding UTF8 $env:WFC_TTS_JOB | ConvertFrom-Json
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait()
  $t.Result
}
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
if ($spec.voice) {
  $v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $spec.voice } | Select-Object -First 1
  if ($v) { $synth.Voice = $v }
}
if ($null -ne $spec.rate) { $synth.Options.SpeakingRate = [double]$spec.rate }
if ($null -ne $spec.pitch) { $synth.Options.AudioPitch = [double]$spec.pitch }
$stream = Await ($synth.SynthesizeTextToStreamAsync([string]$spec.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
$fs = [System.IO.File]::Create([string]$spec.out)
$net.CopyTo($fs)
$fs.Close()
$synth.Dispose()
Write-Output 'WFC_TTS_OK'
`;

const encodedScript = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

/** 在飞的子进程（关服时要全部杀掉）。 */
const inflight = new Set();
let stopping = false;

/** 简单队列 + 并发上限。 */
let running = 0;
const waiting = [];

function ensureTmp() {
  return ensureTmpDir();
}

/** 内存 LRU：指纹 → WAV Buffer。 */
const cache = new Map();

function fingerprint({ text, voice, rate, pitch }) {
  return crypto
    .createHash('sha1')
    .update([voice || '', String(rate ?? ''), String(pitch ?? ''), text].join('\u0001'))
    .digest('hex');
}

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

/**
 * 读 WAV 里 data 块的长度（实现在 util.js，与 Kokoro 共用）。
 */

/**
 * 合成一段文本。
 * @param {{text:string, voice?:string|null, rate?:number|null, pitch?:number|null}} job
 * @returns {Promise<{ok:boolean, wav?:Buffer, reason?:string, synthMs?:number, cached?:boolean}>}
 */
export async function synthesize(job) {
  const text = String(job.text || '').trim();
  if (!text) return { ok: false, reason: 'empty_text' };

  const voice = job.voice || null;
  const rate = numOrNull(job.rate);
  const pitch = numOrNull(job.pitch);

  const key = fingerprint({ text, voice, rate, pitch });
  const hit = cache.get(key);
  if (hit) {
    // LRU：命中后挪到末尾
    cache.delete(key);
    cache.set(key, hit);
    return { ok: true, wav: hit, cached: true };
  }

  ensureTmp();
  try {
    await acquire();
  } catch {
    return { ok: false, reason: 'tts_stopping' };
  }

  const seq = crypto.randomBytes(4).toString('hex');
  const jobFile = path.join(TMP_DIR, `job-${process.pid}-${seq}.json`);
  const outFile = path.join(TMP_DIR, `out-${process.pid}-${seq}.wav`);
  const started = Date.now();

  try {
    fs.writeFileSync(jobFile, JSON.stringify({ text, voice, rate, pitch, out: outFile }), 'utf8');

    await new Promise((resolve, reject) => {
      let child;
      const done = (err, _stdout, stderr) => {
        if (child) inflight.delete(child);
        if (err) {
          const killed = err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
          const e = new Error(killed ? 'tts_timeout' : 'tts_powershell_failed');
          e.detail = String(stderr || err.message || '').slice(0, 200);
          return reject(e);
        }
        resolve();
      };
      try {
        child = execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript],
          {
            timeout: TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, WFC_TTS_JOB: jobFile },
          },
          done,
        );
      } catch (err) {
        // 例如 powershell.exe 被组策略完全禁用：同步抛出，不能让它挂着不返回
        const e = new Error('tts_powershell_failed');
        e.detail = String(err?.message || err).slice(0, 200);
        return reject(e);
      }
      if (child) inflight.add(child);
    });

    let buf;
    try {
      buf = fs.readFileSync(outFile);
    } catch {
      return { ok: false, reason: 'tts_empty_audio', synthMs: Date.now() - started };
    }
    if (!buf || wavDataSize(buf) <= 0) {
      return { ok: false, reason: 'tts_empty_audio', synthMs: Date.now() - started };
    }

    cache.set(key, buf);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { ok: true, wav: buf, synthMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message === 'tts_timeout' ? 'tts_timeout' : err?.message === 'tts_stopping' ? 'tts_stopping' : 'tts_powershell_failed',
      detail: err?.detail || null,
      synthMs: Date.now() - started,
    };
  } finally {
    for (const f of [jobFile, outFile]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
    release();
  }
}

/**
 * 关服：杀掉在飞的 PowerShell 并清空等待队列。
 * 对应 contributing.md 约束 7「任何后台工作不能拖住进程退出」。
 *
 * 注意：会置 `stopping`，同一进程内若再次启动服务（测试 / 重启）必须先调
 * `reset()` 复位，否则所有合成都会立刻返回 tts_stopping。
 */
export function shutdown() {
  stopping = true;
  for (const child of inflight) {
    try {
      child.kill();
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

/** 重新启用合成（每次服务实例启动时调用，抵消上一次 shutdown 的影响）。 */
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
