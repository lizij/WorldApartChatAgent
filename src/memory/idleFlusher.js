/**
 * 空闲兜底调度器：定期扫描各 NPC 档案，若「有未并入长期记忆的轮次」且「已空闲超过阈值」，
 * 就补一次异步摘要。目的：跨会话保持记忆最新，且**不给玩家增加任何响应延迟**
 * （补压发生在玩家已经离开、无人等待的时段）。
 *
 * 解决两类空档：
 *   ① 尾部不足 everyTurns 轮：如聊到第 5 轮就下线，第 5 轮原本要等累计到第 8 轮才进记忆；
 *   ② 累计聊不满 everyTurns 轮的短会话：memory.md 原本永远为空，下次见面注入 0 字。
 *
 * 触发条件（需同时满足）：
 *   - 记忆水位落后：state.turns > state.lastSummaryTurn
 *   - 已空闲：距 state.lastSeen 超过 memory.summarizer.idleFlushMs（默认 5 分钟）
 *   - 该 NPC 当前没有摘要任务在跑（由 Summarizer.running 保证，不会重复入队）
 *
 * 定时器 unref()，不会阻止进程退出（遵守「关窗即完全退出」红线）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NPCS_DIR } from './store.js';

/**
 * 扫描周期固定 5 秒：扫描本身只是 readdir + 读几个小 JSON，开销可忽略；
 * 真正花模型调用的是 idleFlushMs 判定，所以不把扫描周期做成配置项
 * （做成配置项会出现"改了不生效"的错觉——已排定的定时器不会重排）。
 */
const SCAN_MS = 5000;

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export class IdleFlusher {
  constructor({ config, logger, summarizer }) {
    this.store = config; // ConfigStore：每次取最新配置，支持热更新
    this.logger = logger;
    this.summarizer = summarizer;
    this.timer = null;
    this.busy = false;
  }

  get config() {
    return this.store.get();
  }

  start() {
    if (this.timer) return;
    const loop = () => {
      this.tick();
      this.timer = setTimeout(loop, SCAN_MS);
      this.timer.unref?.();
    };
    this.timer = setTimeout(loop, SCAN_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 扫描一轮；返回本轮入队的 slug 列表（便于测试断言）。 */
  tick() {
    const flushed = [];
    const mem = this.config.memory;
    const cfg = mem.summarizer;
    if (!mem.enabled || !cfg.enabled || !cfg.idleFlushEnabled) return flushed;
    if (!this.config.upstream.apiKey) return flushed; // 未配置上游时不要空转刷错误日志
    if (this.busy) return flushed;
    this.busy = true;
    try {
      const idleMs = Math.max(1000, Number(cfg.idleFlushMs) || 300000);
      let slugs = [];
      try {
        slugs = fs.readdirSync(NPCS_DIR);
      } catch {
        return flushed; // 尚无 npcs 目录
      }
      for (const slug of slugs) {
        const dir = path.join(NPCS_DIR, slug);
        const stateFile = path.join(dir, 'state.json');
        let state;
        try {
          state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        } catch {
          continue; // 非 NPC 目录或缺 state.json
        }
        if (!state || typeof state !== 'object') continue;
        if ((state.turns || 0) <= (state.lastSummaryTurn || 0)) continue; // 尾部已全部并入记忆
        const last = Date.parse(state.lastSeen || '') || mtime(stateFile);
        const idle = Date.now() - (last || 0);
        if (!last || idle < idleMs) continue; // 还在活动，交给水位触发
        const bundle = {
          dir,
          stateFile,
          memoryFile: path.join(dir, 'memory.md'),
          convFile: path.join(dir, 'conversations.jsonl'),
          sessionId: state.sessionId || '',
        };
        if (this.summarizer.flushIfBehind(slug, bundle, state)) {
          flushed.push(slug);
          this.logger.append({
            kind: 'idle_flush',
            slug,
            status: 'queued',
            turns: state.turns,
            lastSummaryTurn: state.lastSummaryTurn || 0,
            idleMs: idle,
          });
        }
      }
    } finally {
      this.busy = false;
    }
    return flushed;
  }
}
