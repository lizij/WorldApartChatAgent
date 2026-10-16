// Windows portable 打包包装：electron-builder 清理 releases/ 前先把运行数据目录
//（正式档 data/、测试档 data_test/：真实上游 Key、配置、NPC 记忆、日志）挪到仓库外，
// 构建后挪回并逐文件校验，保证数据不丢。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 与 src/config.js 的目录名保持一致：正式档 data/、测试档 data_test/
const PROFILES = ['data', 'data_test'];
const backups = [];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
    child.on('error', reject);
  });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function manifest(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) manifest(p, base, out);
    else if (ent.isFile()) out.push(`${path.relative(base, p)}:${fs.statSync(p).size}`);
  }
  return out.sort();
}

function cleanupArtifacts() {
  const dir = path.join(root, 'releases');
  if (!fs.existsSync(dir)) return;
  const junkDirs = new Set(['win-unpacked']);
  const junkSuffixes = ['.blockmap'];
  const junkNames = new Set(['builder-debug.yml', 'latest.yml']);
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory() && junkDirs.has(ent.name)) fs.rmSync(p, { recursive: true, force: true });
    else if (ent.isFile() && (junkSuffixes.some((s) => ent.name.endsWith(s)) || junkNames.has(ent.name))) fs.rmSync(p);
  }
}

try {
  for (const name of PROFILES) {
    const dataDir = path.join(root, 'releases', name);
    if (!fs.existsSync(dataDir)) continue;
    const backupDir = path.join(os.tmpdir(), `wfc-userdata-${name}-${Date.now()}`);
    copyDir(dataDir, backupDir);
    backups.push({ name, dataDir, backupDir });
    console.log(`[dist] ${name}/ 已备份到仓库外：${backupDir}`);
  }

  await run(process.execPath, [path.join(root, 'scripts', 'build-backend.mjs')]);
  const ebBin = path.join(root, 'node_modules', '.bin', 'electron-builder.cmd');
  await run(ebBin, ['--win', '--x64', '--publish', 'never'], { shell: true });

  for (const b of backups) copyDir(b.backupDir, b.dataDir);
  if (backups.length) console.log('[dist] 运行数据已恢复');
  cleanupArtifacts();
} catch (err) {
  console.error('[dist] 构建失败：', err.message);
  for (const b of backups) {
    if (fs.existsSync(b.dataDir)) continue;
    try {
      copyDir(b.backupDir, b.dataDir);
      console.error(`[dist] 已尽力恢复 ${b.name}/`);
    } catch (e2) {
      console.error(`[dist] ${b.name}/ 恢复失败：`, e2.message);
    }
  }
  process.exitCode = 1;
} finally {
  for (const b of backups) {
    if (manifest(b.backupDir).join('|') === manifest(b.dataDir).join('|')) {
      fs.rmSync(b.backupDir, { recursive: true, force: true });
      console.log(`[dist] ${b.name}/ 恢复校验通过，临时备份已清理`);
    } else {
      console.error(`[dist] ⚠ ${b.name}/ 校验未通过，备份保留在：${b.backupDir}`);
      process.exitCode = 1;
    }
  }
}
