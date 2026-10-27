/**
 * 应用装配：配置 + 日志 + 单个 HTTP 服务（游戏 API 与管理页同端口）。
 * 命令行入口(src/index.js)与 Electron 主进程(electron/main.cjs)共用。
 */
import { ConfigStore, DEFAULT_PORT, DATA_DIR, PUBLIC_DIR, VERSION } from './config.js';
import { Logger } from './log.js';
import { createServer } from './server.js';
import { rewriteCache } from './rewriteCache.js';

/** 端口被占用时最多顺延尝试几个（8790 → 8809）。 */
const PORT_FALLBACK_TRIES = 20;

export function createApp() {
  const config = new ConfigStore();
  const logger = new Logger({
    memorySize: config.get().log.memorySize,
    maxDays: config.get().log.maxDays,
  });

  // 本次启动的端口顺延记录（null = 未发生），供 /api/status 与管理页提示使用。
  let portFallback = null;
  const server = createServer({ config, logger, getPortFallback: () => portFallback });

  function listenOn(port, host) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  /**
   * 端口被占用（另一个实例 / 残留进程 / 其他工具）时自动向后顺延，
   * 换到新端口后写回 config.json，保证下次启动仍用同一个端口。
   * 只对 EADDRINUSE 降级，其他绑定错误照旧抛出。
   */
  async function listen() {
    const cfg = config.get();
    const want = Number(cfg.server.port) || DEFAULT_PORT;
    let lastErr = null;
    for (let i = 0; i < PORT_FALLBACK_TRIES; i += 1) {
      const port = want + i;
      if (port > 65535) break;
      try {
        await listenOn(port, cfg.server.host);
        if (port !== want) {
          portFallback = { from: want, to: port };
          config.update({ server: { port } });
          logger.append({ kind: 'server', status: 'port_fallback', from: want, to: port });
          console.warn(
            `[server] 端口 ${want} 已被占用，已自动切换到 ${port}（已写入 config.json，下次启动仍用该端口）`,
          );
        }
        return port;
      } catch (err) {
        if (err?.code !== 'EADDRINUSE') throw err;
        lastErr = err;
      }
    }
    const last = Math.min(want + PORT_FALLBACK_TRIES - 1, 65535);
    const err = new Error(`端口 ${want}-${last} 均被占用`);
    err.code = 'EADDRINUSE';
    err.port = want;
    err.portRange = [want, last];
    err.cause = lastErr || undefined;
    throw err;
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
