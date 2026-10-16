/**
 * 配置：默认值、深合并、首启迁移、热更新持久化、路径解析。
 *
 * 数据/静态目录在 Electron 打包后由环境变量注入（import.meta.url 在 asar 内的
 * CJS 单文件包里不可靠，与 LocalAIProxy 同样的处理）：
 *   WFC_HOME        数据目录（便携版 = exe 同级 data/ 或 data_test/）
 *   WFC_PUBLIC_DIR  静态页面目录（便携版 = resources/public）
 *   WFC_VERSION     版本号（便携版由主进程注入）
 *
 * 测试档：命令行带 --test（或 WFC_TEST=1）时，数据目录改用 data_test/，
 * 与正式档 data/ 完全隔离（配置、NPC 记忆、日志都各一份）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 打包后是 asar 内的 CJS 单文件，import.meta.url 为空会抛错；此时路径全部走环境变量，
// DEV_ROOT 退化为 cwd（仅影响开发态 package.json 版本读取的兜底）。
let DEV_ROOT = process.cwd();
try {
  if (import.meta && import.meta.url) {
    DEV_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  }
} catch {}

/** 是否测试档：--test 参数优先，兼容 WFC_TEST=1 环境变量。 */
export const IS_TEST = process.env.WFC_TEST === '1' || process.argv.includes('--test');

export const ROOT_DIR = DEV_ROOT;
export const DATA_DIR = process.env.WFC_HOME || path.join(DEV_ROOT, IS_TEST ? 'data_test' : 'data');
export const PUBLIC_DIR = process.env.WFC_PUBLIC_DIR || path.join(DEV_ROOT, 'public');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DEV_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return process.env.WFC_VERSION || '0.0.0';
  }
}
export const VERSION = process.env.WFC_VERSION || pkgVersion();

function randomKey() {
  return 'wfc-' + crypto.randomBytes(20).toString('hex');
}

export function defaults() {
  return {
    server: {
      host: '127.0.0.1',
      port: 8790,
      // 游戏侧在 Authorization: Bearer 或 x-api-key 中携带；首次运行自动生成
      apiKey: randomKey(),
      // 对外暴露的模型 id（游戏里填这个）；任意传入 model 都会映射到上游模型
      servedModel: 'deepseek-flash',
    },
    upstream: {
      // OpenAI 兼容上游根地址；DeepSeek 官方不带 /v1（转发时自动拼接 /chat/completions）
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      model: 'deepseek-flash',
      insecureTLS: false,
      // 默认【不干涉】上游思考链：游戏原始请求从不带 thinking 参数，因此保持不注入，
      // 让上游用默认行为（deepseek-flash 默认开思考）。
      // 实测（2026-10-16）：强制禁用思考会让 NPC 忽略 system 里的复杂规则
      // （如「最高优先级规则」「承认对方提到的一切」），表现为只按眼前一句话回复；
      // 开启思考才与裸模型行为一致。仅当确需压低延迟时才把它改成 true。
      disableThinking: false,
      connectTimeoutMs: 15000,
      requestTimeoutMs: 300000,
    },
    memory: {
      enabled: true,
      // 注入给模型的长期记忆最大字符数（超出保留最新部分）。
      // 须 ≥ maxMemoryChars + 包装说明，否则记忆里较早的部分永远注入不到模型。
      injectMaxChars: 3200,
      // 首次见到 / system 内容变化时存档完整原文
      snapshotSystem: true,
      summarizer: {
        // 回复结束后异步压缩长期记忆（不阻塞游戏响应）
        enabled: true,
        everyTurns: 4,
        recentEntries: 40,
        // 记忆体量：实测中文约 1.4 汉字/token，故 maxMemoryChars 必须与 maxTokens 匹配，
        // 否则模型物理上写不到那么长 → 每次都触发截断（调大 maxMemoryChars 不会让记忆变长）。
        maxMemoryChars: 3000, // 上限 = maxTokens × 1.4（此处 2500×1.4=3500，留有余量）
        maxTokens: 2500,
        timeoutMs: 90000,
        // 超限重试：实测 prompt 里的字数要求几乎不被遵守，而模型有能力写短；
        // 超限时把上一次输出回喂、要求压到上限内，最多重试这么多次，仍超限才机械截断。
        overLimitRetries: 2, // 0~3
        // 空闲兜底：NPC 距上次请求超过 idleFlushMs 且记忆水位落后时补压一次。
        // 解决「尾部不足 everyTurns 轮」与「累计聊不满 everyTurns 轮的短会话」永不进记忆的问题。
        idleFlushEnabled: true,
        idleFlushMs: 300000, // 5 分钟无新请求即视为本段会话已结束（扫描周期固定 5 秒，不可配）
      },
    },
    log: {
      memorySize: 1000,
      maxDays: 14,
    },
    migrateFromLocalAIProxy: true,
  };
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = isObject(base[k]) && isObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 一次性迁移：从本机 LocalAIProxy 便携版读取生效 Provider（仅首启、Key 为空时）。 */
function tryMigrateUpstream() {
  const candidates = [
    process.env.WFC_IMPORT_CONFIG,
    'C:\\Users\\lizij\\Downloads\\LocalAIProxy\\releases\\data\\config.json',
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const providers = Array.isArray(raw.providers) ? raw.providers : [];
      const active = providers.find((p) => p && p.id === raw.activeProviderId) || providers[0];
      if (active && active.baseUrl && active.apiKey) {
        return {
          baseUrl: active.baseUrl,
          apiKey: String(active.apiKey),
          model: active.model || 'deepseek-flash',
          insecureTLS: !!active.insecureTLS,
          migratedFrom: file,
        };
      }
    } catch {}
  }
  return null;
}

/**
 * 配置仓库：启动时加载/生成，运行期可热更新（管理页保存后即时生效）。
 */
export class ConfigStore {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const d = defaults();
    let user = {};
    let existed = false;
    this.migrated = null;
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      existed = true;
    } catch {}

    if (!existed && d.migrateFromLocalAIProxy) {
      const m = tryMigrateUpstream();
      if (m) {
        const { migratedFrom, ...up } = m;
        Object.assign(d.upstream, up);
        this.migrated = migratedFrom;
      }
    }

    this.cfg = deepMerge(d, user);
    this.firstRun = !existed;
    if (!existed) this.persist();
  }

  get() {
    return this.cfg;
  }

  /** 局部更新（深合并到对应段）并落盘；返回更新后的完整配置。 */
  update(patch) {
    this.cfg = deepMerge(this.cfg, patch);
    this.persist();
    return this.cfg;
  }

  persist() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.cfg, null, 2), 'utf8');
  }
}

export function upstreamChatUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
}
