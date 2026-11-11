// 把 Kokoro 模型切成 <100 MiB 的分片，绕开 GitHub 单文件 100 MiB 硬限制。
// 用法：node scripts/split-tts-model.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = path.join(root, 'tts-engines', 'kokoro', 'model.int8.onnx');
const CHUNK = 60 * 1024 * 1024; // 60 MiB/片，2 片即可，留足余量

if (!fs.existsSync(model)) {
  console.error('缺少模型：' + model);
  process.exit(1);
}
const size = fs.statSync(model).size;
const fd = fs.openSync(model, 'r');
const total = Math.ceil(size / CHUNK);
const buf = Buffer.alloc(CHUNK);
const parts = [];
for (let i = 0; i < total; i += 1) {
  const start = i * CHUNK;
  const len = Math.min(CHUNK, size - start);
  fs.readSync(fd, buf, 0, len, start);
  const file = `${model}.part${String(i).padStart(2, '0')}`;
  fs.writeFileSync(file, buf.subarray(0, len));
  parts.push({ file, len });
}
fs.closeSync(fd);
console.log(`已切分 ${size} 字节为 ${total} 片（每片 ${(CHUNK / 1048576).toFixed(0)} MiB）：`);
for (const p of parts) console.log(`  ${path.basename(p.file)}  ${p.len} 字节  ${(p.len / 1048576).toFixed(2)} MiB`);
