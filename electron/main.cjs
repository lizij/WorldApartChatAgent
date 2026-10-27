// Electron 主进程：本进程内启动 NPC Agent 后端服务，内嵌 Chromium 窗口展示管理页。
// 生命周期：开窗 = 启服务；关窗 = 服务与进程一并退出，无后台残留。仅面向 Windows 便携版。
const path = require('node:path');
const { app, BrowserWindow, shell, dialog } = require('electron');

let backend = null;
let mainWindow = null;
let cleanedUp = false;

app.setName('WorldApartNpcAgent');

// 后端 esbuild 打包为 CJS（asar 内规避 ESM 加载问题）；静态页通过环境变量注入路径。
process.env.WFC_PUBLIC_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'public')
  : path.join(__dirname, '..', 'public');

// 便携版数据写到 exe 同级目录（PORTABLE_EXECUTABLE_DIR 由 electron-builder 便携启动器注入）：
// 正式档 → data/，测试档（带 --test 参数）→ data_test/，两档完全隔离。
// 注意：必须在 require 后端前设置，config.js 在 import 时即读取该环境变量。
const IS_TEST = process.argv.includes('--test');
if (app.isPackaged) {
  const baseDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  process.env.WFC_HOME = path.join(baseDir, IS_TEST ? 'data_test' : 'data');
}
if (IS_TEST) process.env.WFC_TEST = '1';
process.env.WFC_VERSION = app.getVersion();

function startBackend() {
  const { createApp } = require(path.join(__dirname, '..', 'dist', 'backend.cjs'));
  backend = createApp();
  return backend.start();
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    title: `不问凡尘 NPC Agent v${app.getVersion()}${IS_TEST ? ' [测试档]' : ''}`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.on('page-title-updated', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://127.0.0.1')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  return win;
}

async function bootstrap() {
  await app.whenReady();
  app.setAppUserModelId('com.worldapart.npcagent');
  try {
    const cfg = await startBackend();
    mainWindow = createWindow(cfg.server.port);
  } catch (err) {
    const from = Array.isArray(err.portRange) ? err.portRange[0] : err && err.port;
    const to = Array.isArray(err.portRange) ? err.portRange[1] : err && err.port;
    const hint =
      err && err.code === 'EADDRINUSE'
        ? `端口 ${from}-${to} 均已被占用。\n\n` +
          `请关闭占用这些端口的程序（常见：本程序的残留进程、其他 AI 工具）后重试。\n` +
          `程序会在端口被占用时自动顺延到下一个空闲端口，并把结果写进配置，` +
          `因此通常只需关掉占用者重启即可。\n\n` +
          `数据目录：${process.env.WFC_HOME || '(未设置)'}`
        : String((err && err.stack) || err);
    dialog.showErrorBox('不问凡尘 NPC Agent 启动失败', hint);
    app.exit(1);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  bootstrap();
}

app.on('will-quit', (event) => {
  if (cleanedUp) return;
  event.preventDefault();
  cleanedUp = true;
  (async () => {
    setTimeout(() => app.exit(0), 5000).unref?.();
    try {
      await backend?.stop();
    } catch {}
    app.quit();
    setTimeout(() => app.exit(0), 1500).unref?.();
  })();
});
