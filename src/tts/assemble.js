/**
 * 语音模型分片组装。
 *
 * 为什么有分片：Kokoro 的 `model.int8.onnx` 是 108.91 MiB，**超过 GitHub 单文件 100 MiB 硬限制**
 * （超了会直接拒绝 push）。所以仓库里存的是两个 <100 MiB 的分片
 * （`model.int8.onnx.part00` / `.part01`），首次使用时在本地拼回完整文件。
 *
 * 拼回是幂等的：完整文件已存在就直接返回，不会重复写 114 MB。
 */
import fs from 'node:fs';
import path from 'node:path';

const TARGET = 'model.int8.onnx';
const PART_RE = /^model\.int8\.onnx\.part(\d+)$/;

/**
 * 确保 `dir/model.int8.onnx` 存在（必要时由分片拼接）。
 * @param {string} dir 引擎目录（含模型与分片）
 * @returns {{ok:boolean, assembled:boolean, reason?:string}}
 */
export function ensureModelAssembled(dir) {
  try {
    const target = path.join(dir, TARGET);
    let existing = 0;
    try {
      existing = fs.statSync(target).size;
    } catch {}
    if (existing > 0) return { ok: true, assembled: false };

    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return { ok: false, assembled: false, reason: 'engine_dir_missing' };
    }
    const parts = names
      .map((n) => ({ n, m: PART_RE.exec(n) }))
      .filter((x) => x.m)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
      .map((x) => x.n);
    if (!parts.length) return { ok: false, assembled: false, reason: 'no_parts' };

    // 写到临时文件再改名：中途失败不会留下半个"完整"模型
    const tmp = target + '.assembling';
    const ws = fs.openSync(tmp, 'w');
    let total = 0;
    try {
      for (const p of parts) {
        const buf = fs.readFileSync(path.join(dir, p));
        fs.writeSync(ws, buf);
        total += buf.length;
      }
    } finally {
      fs.closeSync(ws);
    }
    fs.renameSync(tmp, target);
    return { ok: total > 0, assembled: true };
  } catch (err) {
    return { ok: false, assembled: false, reason: String(err?.message || err) };
  }
}
