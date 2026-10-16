// 把后端（src/app.js 及依赖）打包成单 CJS 文件 dist/backend.cjs，供 Electron/asar 加载。
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src', 'app.js')],
  outfile: path.join(root, 'dist', 'backend.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  // 路径注入点（WFC_HOME/WFC_PUBLIC_DIR）存在，import.meta 警告可安全忽略。
  logOverride: { 'import-meta': 'silent' },
  logLevel: 'info',
});

console.log('[build] dist/backend.cjs 已生成');
