/**
 * 配置：默认值、深合并、热更新持久化、路径解析。
 *
 * 数据/静态目录在 Electron 打包后由环境变量注入（import.meta.url 在 asar 内的
 * CJS 单文件包里不可靠，因此一律走环境变量）：
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

/**
 * 请求重写缓存机制白名单。后续新增机制时在这里登记，并在
 * requestRewrite.js / 管理页下拉菜单中补对应实现与选项。
 *   none  不启用
 *   exact 机制 1：整轮指纹缓存（最终重写请求体逐字节相同才复用）
 */
export const REWRITE_CACHE_MODES = ['none', 'exact'];

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
      // 实测（2026-10-16）：强制禁用思考会让 NPC 忽略 system 里下发的复杂约束，
      // 表现为只按眼前一句话回复；
      // 开启思考才与裸模型行为一致。仅当确需压低延迟时才把它改成 true。
      disableThinking: false,
      // 流式请求是否额外要求上游返回 usage（stream_options.include_usage）。
      // 默认关闭：避免多出的「choices: []」汇总 chunk 影响游戏端 SSE 解析。
      // 开启后可在执行日志里看到每轮精确 token 总数；关闭时按字符估算。
      includeUsage: false,
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
    // 外置设定提示词：玩家设定的全局提示（对所有 NPC 生效），可涵盖人物设定、世界观、
    // 口吻、尺度、长度等一切内容。逐 NPC 的个人提示与「是否叠加全局」存于
    // data/npcs/<slug>/prompt.json（见 memory/store.js）。
    // 旧版配置键为 style，加载时自动迁移（见 ConfigStore 构造函数）。
    prompts: {
      enabled: true,
      global: '',
    },
    // 请求重写（实验性）：转发前额外调用一次上游，把游戏 system 中与本工具外置内容
    // 冲突的部分删除或改写。默认关闭：每轮多一次 system 量级的输入+输出，首字延迟明显增加。
    requestRewrite: {
      enabled: false,
      maxTokens: 6000,
      timeoutMs: 60000,
      temperature: 0.2,
      // 缓存机制（默认不启用）：none | exact。
      // exact = 机制 1「整轮指纹缓存」：最终重写请求体逐字节相同时复用上次已验证结果。
      cache: {
        mode: 'none',
        // 全局 LRU 上限；每个机制单独一个 data/rewrite-cache-<mode>.json
        maxEntries: 1000,
        ttlDays: 7,
      },
    },
    // 多 NPC 共演（实验性）：默认关闭。开启后每轮可能多一次配角请求，
    // token 与延迟都会增加；关闭时请求体与原先逐字节一致。
    multiNpc: {
      enabled: false,
      // 同时在场配角上限（当前只验证 1 个）
      maxCoStars: 1,
      // 一轮内最多几次 NPC 发言调用（1 = 只跑主角 A）
      maxCallsPerTurn: 2,
      // addressed：被点名 / 新入场 / 括号给了 B 动作才开口；always：在场每轮都接
      speakPolicy: 'addressed',
      // script：多人场景统一「名字：台词」；inherit：保持 A 的第一人称
      outputStyle: 'script',
      // 玩家点名 B 时，A 可以只给一个在旁反应
      allowASilence: true,
      // B 是否写入自己的长期记忆（需求 3.6，默认关）
      coStarWritesMemory: false,
      transcriptTurns: 8,
      // 检测到任务/话题模块时本轮退化为单人戏
      skipOnTask: true,
      // 是否允许根据台词（括号里的动作/点名）自动进场、离场；默认关闭，只认 /invite /add /leave /remove
      autoStage: false,
      // 超时自动清场（毫秒）：默认 120 分钟，按“多久没和主角来往”计
      autoExitIdleMs: 7200000,
      // A 先说完、B 接话时，尾部插槽最多等待多久（毫秒）
      actorTailWaitMs: 3000,
      // 配角调用参数
      actorMaxTokens: 300,
      actorTimeoutMs: 20000,
    },
    log: {
      memorySize: 1000,
      maxDays: 14,
    },
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

/**
 * 配置仓库：启动时加载/生成，运行期可热更新（管理页保存后即时生效）。
 */
export class ConfigStore {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const d = defaults();
    let user = {};
    let existed = false;
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      existed = true;
    } catch {}

    // 旧版 style → prompts 自动迁移（向后兼容，不丢玩家已填的全局提示词）。
    // 两个键并存时以 prompts 为准，随后删除旧键，保持单一来源。
    let migrated = false;
    if (user && typeof user === 'object' && user.style && typeof user.style === 'object') {
      if (!user.prompts || typeof user.prompts !== 'object') {
        user.prompts = user.style;
      }
      delete user.style;
      migrated = true;
    }

    // 0.12.x 的 requestRewrite.cache.enabled（布尔）→ cache.mode（机制名）。
    // 保留玩家原有选择：enabled=true → exact，false → none；删掉旧键，避免双来源。
    const rwCache = user && typeof user === 'object' ? user.requestRewrite?.cache : null;
    if (rwCache && typeof rwCache === 'object') {
      const legacyEnabled = 'enabled' in rwCache;
      if (typeof rwCache.mode !== 'string') {
        rwCache.mode = rwCache.enabled === false ? 'none' : 'exact';
        migrated = true;
      }
      if (legacyEnabled) {
        delete rwCache.enabled;
        // 旧版逐 NPC 上限固定为 4；升级到全局 LRU 时回到新默认 1000。
        if (rwCache.maxEntries === 4) rwCache.maxEntries = 1000;
        migrated = true;
      }
      if (!REWRITE_CACHE_MODES.includes(rwCache.mode)) {
        rwCache.mode = 'none';
        migrated = true;
      }
    }

    this.cfg = deepMerge(d, user);
    this.firstRun = !existed;
    if (!existed || migrated) this.persist();
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
