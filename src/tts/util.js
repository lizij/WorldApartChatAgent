/**
 * TTS 引擎共用的小工具（两个引擎都会用到）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const TMP_DIR = path.join(DATA_DIR, 'tmp', 'tts');
let ready = false;

/** 临时目录：首次使用时创建，并清掉上次异常退出留下的文件。 */
export function ensureTmpDir() {
  if (!ready) {
    ready = true;
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      for (const n of fs.readdirSync(TMP_DIR)) {
        if (/\.(json|wav)$/i.test(n)) {
          try {
            fs.rmSync(path.join(TMP_DIR, n), { force: true });
          } catch {}
        }
      }
    } catch {}
  }
  return TMP_DIR;
}

/**
 * 读 WAV 里 data 块的长度。
 * 空文本会产出只有头部的 WAV，只看文件大小会漏判，必须看 data 块有没有内容。
 */
export function wavDataSize(buf) {
  if (!buf || buf.length < 44) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return size;
    off += 8 + size + (size % 2);
  }
  return 0;
}

/** 数字或 null（注意 Number(null) === 0，必须先排除空值）。 */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
