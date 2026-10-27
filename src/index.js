/**
 * 《不问凡尘》外置 AI NPC 对话 Agent —— 命令行入口。
 * 单进程前台服务：关闭本窗口/进程即完全退出，无后台残留。
 * 桌面（Electron）入口见 electron/main.cjs。
 */
import { createApp } from './app.js';

const app = createApp();
const IS_TEST = process.env.WFC_TEST === '1' || process.argv.includes('--test');

app
  .start()
  .then((cfg) => {
    const banner = [
      '============================================================',
      '  《不问凡尘》外置 AI NPC 对话 Agent  v' + cfg.version + (IS_TEST ? '  [测试档]' : ''),
      '============================================================',
      '在游戏中填写以下连接信息：',
      '',
      `  Base URL : http://${cfg.server.host}:${cfg.server.port}/v1`,
      `  API Key  : ${cfg.server.apiKey}`,
      `  Model ID : ${cfg.server.servedModel}（任意 model 名也会映射到上游 ${cfg.upstream.model}）`,
      '',
      `上游 Provider : ${cfg.upstream.baseUrl}  →  ${cfg.upstream.model}`,
      !cfg.upstream.apiKey
        ? '⚠ 上游 API Key 未配置：请打开管理页或编辑 ' + cfg.dataDir + '\\config.json'
        : '',
      '管理页 : http://' + cfg.server.host + ':' + cfg.server.port + '/',
      '数据目录 : ' + cfg.dataDir,
      '',
      '按 Ctrl+C 停止服务（无后台进程）。',
      '------------------------------------------------------------',
    ]
      .filter((l) => l !== '')
      .join('\n');
    console.log(banner);
    app.logger.append({
      kind: 'server',
      status: 'started',
      version: cfg.version,
      host: cfg.server.host,
      port: cfg.server.port,
      firstRun: app.config.firstRun,
    });
  })
  .catch((err) => {
    if (err?.code === 'EADDRINUSE') {
      const from = Array.isArray(err.portRange) ? err.portRange[0] : err.port;
      const to = Array.isArray(err.portRange) ? err.portRange[1] : err.port;
      console.error(
        `端口 ${from}-${to} 均已被占用。\n` +
          `请关闭占用这些端口的程序（常见：本程序的残留进程、其他 AI 工具）后重启。\n` +
          `数据目录：${app.dataDir}`,
      );
    } else {
      console.error('服务启动失败:', err);
    }
    process.exit(1);
  });

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log('\n正在停止…');
  app.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  app.logger?.append({ kind: 'server', status: 'error', error: err?.stack || String(err) });
  console.error('未捕获异常:', err);
});
process.on('unhandledRejection', (err) => {
  app.logger?.append({ kind: 'server', status: 'error', error: String(err) });
  console.error('未处理的 Promise 拒绝:', err);
});
