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

/**
 * 只补回缺失的文件，**不覆盖**已存在的文件。
 *
 * 打包时程序通常还在运行（玩家正连着游戏），期间会继续写日志、state、intake。
 * 若按「备份覆盖回来」，构建窗口里写入的那几轮会被旧备份冲掉，造成静默丢数据
 * （0.17.0 打包时发生过：一轮对话的日志/会话/state 被回滚，只有 intake 多出来）。
 * electron-builder 并不会删除 releases/data，所以正常情况这里是空操作；
 * 只有目录真被清空时才需要整体复制。
 */
function restoreMissing(from, to, stat = { restored: 0, kept: 0 }) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) restoreMissing(s, d, stat);
    else if (ent.isFile()) {
      if (fs.existsSync(d)) {
        stat.kept += 1;
        continue;
      }
      fs.copyFileSync(s, d);
      stat.restored += 1;
    }
  }
  return stat;
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

  for (const b of backups) {
    const r = restoreMissing(b.backupDir, b.dataDir);
    b.restored = r.restored;
    b.kept = r.kept;
    console.log(
      `[dist] ${b.name}/ 已恢复（补回 ${r.restored} 个缺失文件，保留 ${r.kept} 个运行期写入）`,
    );
  }
  cleanupArtifacts();
} catch (err) {
  console.error('[dist] 构建失败：', err.message);
  for (const b of backups) {
    if (fs.existsSync(b.dataDir)) continue;
    try {
      restoreMissing(b.backupDir, b.dataDir);
      console.error(`[dist] 已尽力恢复 ${b.name}/`);
    } catch (e2) {
      console.error(`[dist] ${b.name}/ 恢复失败：`, e2.message);
    }
  }
  process.exitCode = 1;
} finally {
  for (const b of backups) {
    // 校验标准：备份里的文件一个都不能少。构建期间运行中实例新写的文件属于正常增量，
    // 不参与比对（它们比备份新，覆盖回去才是错的）。
    const current = new Set(manifest(b.dataDir));
    const curNames = new Set([...current].map((x) => x.slice(0, x.lastIndexOf(':'))));
    const missing = manifest(b.backupDir)
      .map((x) => x.slice(0, x.lastIndexOf(':')))
      .filter((rel) => !curNames.has(rel));
    if (!missing.length) {
      fs.rmSync(b.backupDir, { recursive: true, force: true });
      console.log(`[dist] ${b.name}/ 校验通过（无缺失），临时备份已清理`);
    } else {
      console.error(
        `[dist] ⚠ ${b.name}/ 校验未通过：缺少 ${missing.length} 个文件，备份保留在 ${b.backupDir}`,
      );
      console.error(`      示例：${missing.slice(0, 5).join('、')}`);
      process.exitCode = 1;
    }
  }
}
