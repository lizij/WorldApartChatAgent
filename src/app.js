/**
 * 应用装配：配置 + 日志 + 单个 HTTP 服务（游戏 API 与管理页同端口）。
 * 命令行入口(src/index.js)与 Electron 主进程(electron/main.cjs)共用。
 */
import { ConfigStore, DATA_DIR, PUBLIC_DIR, VERSION } from './config.js';
import { Logger } from './log.js';
import { createServer } from './server.js';
import { rewriteCache } from './rewriteCache.js';

export function createApp() {
  const config = new ConfigStore();
  const logger = new Logger({
    memorySize: config.get().log.memorySize,
    maxDays: config.get().log.maxDays,
  });

  const server = createServer({ config, logger });

  function listen() {
    return new Promise((resolve, reject) => {
      const cfg = config.get();
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(cfg.server.port, cfg.server.host);
    });
  }

  async function start() {
    await listen();
    return {
      version: VERSION,
      dataDir: DATA_DIR,
      publicDir: PUBLIC_DIR,
      ...config.get(),
    };
  }

  async function stop() {
    // 重写缓存是防抖异步落盘，退出前同步刷一次，避免丢最后一段
    try {
      rewriteCache.flushSync();
    } catch {}
    try {
      await logger.close();
    } catch {}
    await new Promise((resolve) => {
      server.close(() => resolve());
      try {
        server.closeAllConnections?.();
      } catch {}
      setTimeout(resolve, 2000);
    });
  }

  return { config, logger, server, dataDir: DATA_DIR, publicDir: PUBLIC_DIR, version: VERSION, start, stop };
}
