/**
 * 语音引擎安装器：下载运行时与模型，校验完整性。
 *
 * 国内网络实测（2026-11-12，见 docs/tts.md §14.2）：
 *   - HuggingFace 直连超时，必须走 hf-mirror.com（实测 0.8~13 MB/s）；
 *   - GitHub Releases 速度波动大（0.08~0.5 MB/s），因此配多个反代兜底；
 *   - 大模型绝不从 GitHub 下载。
 *
 * 全部使用 Node 原生 API（fetch / fs）+ 系统自带 tar，不引入第三方依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { ENGINE_DIR, RUNTIME_DIR, EXE_PATH, DLL_PATH, isInstalled, KOKORO_VOICES } from './kokoro.js';

const KOKORO_VOICE_COUNT = KOKORO_VOICES.length;

const HF_MIRROR = 'https://hf-mirror.com';
const HF_REPO = 'csukuangfj/kokoro-int8-multi-lang-v1_0';

/** 模型文件清单（含 sha256，下载后校验）。 */
const MODEL_MANIFEST = [
  { path: 'model.int8.onnx', size: 114202993, sha256: '75635ea3b85a32d00094dcdd61a258aba87c160f7c264c304a7b3ae9d734195e' },
  { path: 'voices.bin', size: 28200960, sha256: '1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29' },
  { path: 'tokens.txt', size: 687, sha256: '6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425' },
  { path: 'lexicon-zh.txt', size: 2365182, sha256: '902bc2d20ac7c449c5ecbbbb23c89d12119c03ed5b8ed27f114f0260c9e35229' },
  { path: 'lexicon-us-en.txt', size: 5956885, sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14' },
  { path: 'number-zh.fst', size: 64482, sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
  { path: 'date-zh.fst', size: 59154, sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
  { path: 'phone-zh.fst', size: 88630, sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
];

const RUNTIME_TAR = 'sherpa-onnx-v2.0.1-win-x64-shared-MD-MinSizeRel.tar.bz2';
/** 精确字节数（来自 GitHub Release API；不要手算 "18 MB"，差一个字节就会无限重试）。 */
const RUNTIME_TAR_SIZE = 18_893_451;

/** GitHub 下载候选（含反代），按顺序尝试。 */
const RUNTIME_URLS = [
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/${RUNTIME_TAR}`,
  `https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/${RUNTIME_TAR}`,
  `https://ghproxy.net/https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/${RUNTIME_TAR}`,
];

const MODEL_URLS = [`${HF_MIRROR}/${HF_REPO}/resolve/main/`];

/** 安装进度（内存态，前端轮询）。 */
export const installState = {
  running: false,
  step: '',
  doneBytes: 0,
  totalBytes: 0,
  speedBps: 0,
  error: null,
  finishedAt: null,
  startedAt: null,
};

export function estimateInstallBytes() {
  return RUNTIME_TAR_SIZE + MODEL_MANIFEST.reduce((n, f) => n + f.size, 0);
}

function setState(patch) {
  Object.assign(installState, patch);
}

function resetState() {
  setState({ running: true, step: '', doneBytes: 0, totalBytes: estimateInstallBytes(), speedBps: 0, error: null, startedAt: Date.now(), finishedAt: null });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 带断点续传的下载。已有部分文件时用 Range 续传。
 * @param {string[]} urls 依次尝试的镜像
 * @param {string} dest 落盘路径
 * @param {number} expectedSize 精确字节数（0 = 不校验）
 * @param {number} baseDone 本文件之前已完成的字节数（跨文件累计进度用）
 * @throws 当所有镜像都失败
 */
async function downloadWithMirrors(urls, dest, expectedSize, baseDone = 0) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr = null;
  for (let attempt = 0; attempt < urls.length * 2; attempt += 1) {
    const url = urls[attempt % urls.length];
    try {
      let start = 0;
      try {
        start = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      } catch {
        start = 0;
      }
      if (expectedSize && start === expectedSize) {
        setState({ doneBytes: baseDone + start });
        return;
      }
      // 半截文件比预期还大 → 不可信，重下
      if (expectedSize && start > expectedSize) {
        fs.rmSync(dest, { force: true });
        start = 0;
      }
      const headers = { 'user-agent': 'Mozilla/5.0' };
      if (start > 0) headers.range = `bytes=${start}-`;

      const r = await fetch(url, { headers, redirect: 'follow' });
      // 续传时期望 206；不支持 Range 的镜像会回 200，此时必须从头写
      const resumed = r.status === 206;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (!r.body) throw new Error('no body');
      if (start > 0 && !resumed) start = 0;

      const ws = fs.createWriteStream(dest, { flags: start > 0 ? 'a' : 'w' });
      let got = start;
      const t0 = Date.now();
      for await (const chunk of r.body) {
        // 处理背压：磁盘跟不上时不 await drain，100MB+ 的文件会把整个文件缓冲进内存
        if (!ws.write(chunk)) {
          await new Promise((res, rej) => {
            ws.once('drain', res);
            ws.once('error', rej);
          });
        }
        got += chunk.length;
        // 进度 = 之前完成的 + 本文件当前字节数（而不是"本次尝试下载了多少"），
        // 这样镜像重试时进度不会重复累加
        setState({
          doneBytes: Math.min(baseDone + got, installState.totalBytes || Infinity),
          speedBps: Math.round((got - start) / Math.max((Date.now() - t0) / 1000, 0.2)),
        });
      }
      await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));

      const finalSize = fs.statSync(dest).size;
      if (expectedSize && finalSize !== expectedSize) {
        throw new Error(`size ${finalSize} != ${expectedSize}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      // 换下一个镜像前保留半截文件，续传可省流量
    }
  }
  throw lastErr || new Error('download_failed');
}

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { cwd, windowsHide: true, timeout: 180000 }, (err, _out, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).slice(0, 240)));
      resolve();
    });
  });
}

async function installRuntime() {
  if (fs.existsSync(EXE_PATH) && fs.existsSync(DLL_PATH)) return;
  setState({ step: '下载语音运行时（18 MB）' });
  const tarPath = path.join(ENGINE_DIR, RUNTIME_TAR);
  await downloadWithMirrors(RUNTIME_URLS, tarPath, RUNTIME_TAR_SIZE, 0);

  setState({ step: '解压运行时' });
  const extractTo = path.join(ENGINE_DIR, '.extract');
  fs.rmSync(extractTo, { recursive: true, force: true });
  fs.mkdirSync(extractTo, { recursive: true });
  // Windows 自带 bsdtar，支持 bz2
  await runTar(['-xjf', tarPath, '-C', extractTo], ENGINE_DIR);

  const root = path.join(extractTo, 'sherpa-onnx-v2.0.1-win-x64-shared-MD-MinSizeRel');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // 精简运行时：只需要 exe + onnxruntime.dll（实测 15.3 MB 即可独立运行）
  for (const [src, dst] of [
    [path.join(binDir, 'sherpa-onnx-offline-tts.exe'), EXE_PATH],
    [path.join(binDir, 'onnxruntime.dll'), DLL_PATH],
  ]) {
    if (!fs.existsSync(src)) throw new Error('runtime_incomplete:' + path.basename(src));
    fs.copyFileSync(src, dst);
  }
  fs.rmSync(extractTo, { recursive: true, force: true });
  fs.rmSync(tarPath, { force: true });
}

async function installModel() {
  // 已完成字节数：从运行时算起
  let done = RUNTIME_TAR_SIZE;
  for (const f of MODEL_MANIFEST) {
    const dest = path.join(ENGINE_DIR, f.path);
    let ok = false;
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) {
        ok = (await sha256File(dest)) === f.sha256;
      }
    } catch {}
    if (ok) {
      done += f.size;
      setState({ doneBytes: done });
      continue;
    }
    setState({ step: `下载模型 ${f.path}（${(f.size / 1048576).toFixed(1)} MB）` });
    await downloadWithMirrors(MODEL_URLS.map((u) => u + encodeURIComponent(f.path)), dest, f.size, done);
    const got = await sha256File(dest);
    if (got !== f.sha256) {
      fs.rmSync(dest, { force: true });
      throw new Error('checksum_mismatch:' + f.path);
    }
    done += f.size;
    setState({ doneBytes: done });
  }
}

/**
 * 执行安装（串行，同一时间只允许一个）。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function install() {
  if (installState.running) return { ok: false, error: 'already_running' };
  if (isInstalled()) {
    setState({ running: false, step: '已安装', finishedAt: Date.now() });
    return { ok: true };
  }
  resetState();
  try {
    fs.mkdirSync(ENGINE_DIR, { recursive: true });
    await installRuntime();
    await installModel();
    if (!isInstalled()) throw new Error('incomplete_after_install');
    setState({ running: false, step: '已安装', finishedAt: Date.now(), speedBps: 0 });
    return { ok: true };
  } catch (err) {
    setState({ running: false, step: '安装失败', error: String(err?.message || err), finishedAt: Date.now() });
    return { ok: false, error: String(err?.message || err) };
  }
}

/** 当前引擎安装状态摘要。 */
export function status() {
  const installed = isInstalled();
  // 统计**全部已落盘文件**（含未安装完成时的半成品），供前端显示真实占用
  let bytes = 0;
  const add = (p) => {
    try {
      bytes += fs.statSync(p).size;
    } catch {}
  };
  for (const f of MODEL_MANIFEST) add(path.join(ENGINE_DIR, f.path));
  add(EXE_PATH);
  add(DLL_PATH);
  return {
    installed,
    engineDir: ENGINE_DIR,
    bytes,
    downloadBytes: estimateInstallBytes(),
    voices: KOKORO_VOICE_COUNT,
    state: { ...installState },
  };
}
