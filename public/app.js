/* 管理页逻辑：配置读写、SSE 实时日志、NPC 记忆浏览。原生 JS，无依赖。 */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let statusCache = null;
let currentKind = 'all';
let logPausedAdd = false;
// 「AI 修改记忆」草稿：{ slug, prompt, text }；仅作前端预览态，保存/取消即清空
let draftState = null;

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(path + ' -> ' + r.status + ' ' + (await r.text().catch(() => '')));
  return r.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function setConn(on) {
  const el = $('#connState');
  el.className = 'conn-state ' + (on ? 'online' : 'offline');
  el.lastChild.textContent = on ? ' 服务运行中' : ' 服务已断开';
}

// —— 请求重写缓存机制（短名 + 悬浮说明；后续机制在这里追加）——
const CACHE_MODE_OPTIONS = [
  {
    value: 'none',
    label: '不启用',
    desc: '每次请求都完整重写，不读取也不写入缓存。',
  },
  {
    value: 'exact',
    label: '整轮指纹缓存',
    desc: '整份重写输入（全部 system 模块、长期记忆、提示词、模型参数）逐字节相同时，复用上次已校验的结果；输入有任何变化都会完整重写。全局 LRU 默认 1000 条。历史命中率约 50%，命中轮中位耗时约 3 秒。',
  },
];

function cacheModeSelected() {
  return document.querySelector('input[name="rwCacheMode"]:checked')?.value || 'none';
}

function updateCacheModeHint() {
  const hint = $('#rwCacheModeHint');
  if (!hint) return;
  const mode = cacheModeSelected();
  hint.textContent = (CACHE_MODE_OPTIONS.find((x) => x.value === mode) || {}).desc || '';
}

/**
 * 记忆上限交叉校验提示：maxMemoryChars 受 maxTokens 物理约束（中文约 1.4 汉字/token），
 * 而注入预算必须 ≥ 上限，否则写得进、注入不到。
 */
function renderMemoryLimitHint(c) {
  const el = $('#memLimitHint');
  if (!el) return;
  const s = c?.memory?.summarizer || {};
  const configured = Number(s.maxMemoryChars) || 0;
  const maxTokens = Number(s.maxTokens) || 0;
  const effective = Number(c?.limits?.memoryEffectiveChars) || configured;
  const inject = Number(c?.limits?.injectEffectiveChars) || Number(c?.memory?.injectMaxChars) || 0;
  if (configured > 0 && effective > 0 && effective < configured) {
    el.textContent =
      `⚠ maxTokens（${maxTokens}）最多只写得动约 ${effective} 字，你填的 ${configured} 字超出部分写不出来。` +
      `请把 maxTokens 提到 ${Math.ceil(configured / 1.4)} 以上。`;
    el.className = 'hint warn';
    return;
  }
  el.textContent = `当前：记忆上限 ${configured} 字，注入预算 ${inject} 字（须 ≥ 上限，否则写得进、注入不到）。`;
  el.className = 'hint';
}

/** 渲染单选行；每项 title 提供鼠标悬浮说明，选中项说明同时显示在下方。 */
function renderCacheModes(selected = 'none') {
  const host = $('#rwCacheModes');
  if (!host) return;
  host.innerHTML = CACHE_MODE_OPTIONS.map(
    (o) =>
      `<label class="cache-mode" title="${esc(o.desc)}">` +
      `<input type="radio" name="rwCacheMode" value="${esc(o.value)}"${o.value === selected ? ' checked' : ''} />` +
      `<span>${esc(o.label)}</span></label>`,
  ).join('');
  host.querySelectorAll('input[name="rwCacheMode"]').forEach((el) => {
    el.addEventListener('change', updateCacheModeHint);
  });
  updateCacheModeHint();
}

// 默认端口；后端在端口被占用时会自动顺延并把实际端口写回配置。
const DEFAULT_PORT = 8790;

// —— 配置 ——
async function loadStatus() {
  const s = await api('/api/status');
  statusCache = s;
  $('#version').textContent = 'v' + s.version + (s.isTest ? ' · 测试档' : '');
  $('#baseUrl').value = s.baseUrl;
  $('#apiKey').value = s.apiKey;
  $('#servedModelView').value = s.servedModel;
  $('#dataDirView').value = s.dataDir || '';
  renderPortNotice(s);
  setConn(true);
}

/** 端口被自动顺延过（已写回配置，重启也不会回到 8790）时必须告诉玩家改游戏里的 Base URL。 */
function renderPortNotice(s) {
  const el = $('#portNotice');
  if (!el) return;
  const port = Number(s?.port) || 0;
  const auto = s?.portFallback;
  if (auto && auto.to) {
    // 本次启动确实发生过顺延：强提醒，否则游戏还指着旧端口，会表现为“游戏没反应”。
    el.hidden = false;
    el.className = 'hint warn';
    el.textContent =
      `⚠ 端口 ${auto.from} 已被占用，本程序自动改用 ${port}（已保存到配置，重启仍是 ${port}）。` +
      `请把游戏里的 Base URL 改成 http://127.0.0.1:${port}/v1，否则游戏会连不上。`;
    return;
  }
  if (port && port !== DEFAULT_PORT) {
    // 玩家自己改过端口：只提示两边要一致，不说成“自动切换”。
    el.hidden = false;
    el.className = 'hint';
    el.textContent = `当前使用非默认端口 ${port}，游戏里的 Base URL 需与之一致：http://127.0.0.1:${port}/v1`;
    return;
  }
  el.hidden = true;
  el.textContent = '';
}

async function loadConfig() {
  const c = await api('/api/config');
  $('#upBaseUrl').value = c.upstream.baseUrl || '';
  $('#upModel').value = c.upstream.model || '';
  $('#upApiKey').value = '';
  $('#upApiKey').placeholder = c.upstream.apiKeySet ? '已设置（' + c.upstream.apiKey + '），留空不修改' : '未设置，请填写';
  $('#upDisableThinking').checked = !!c.upstream.disableThinking;
  $('#upIncludeUsage').checked = !!c.upstream.includeUsage;
  $('#upConnectTimeout').value = c.upstream.connectTimeoutMs ?? 15000;
  $('#upRequestTimeout').value = c.upstream.requestTimeoutMs ?? 300000;
  $('#memEnabled').checked = !!c.memory.enabled;
  $('#memSnapshot').checked = !!c.memory.snapshotSystem;
  $('#sumEnabled').checked = !!c.memory.summarizer.enabled;
  $('#memInjectChars').value = c.memory.injectMaxChars;
  $('#sumEvery').value = c.memory.summarizer.everyTurns;
  $('#sumMaxChars').value = c.memory.summarizer.maxMemoryChars;
  renderMemoryLimitHint(c);
  $('#promptsEnabled').checked = !!c.prompts?.enabled;
  $('#promptsGlobal').value = c.prompts?.global || '';
  const rw = c.requestRewrite || {};
  $('#rwEnabled').checked = !!rw.enabled;
  $('#rwMaxTokens').value = rw.maxTokens ?? 6000;
  $('#rwTimeout').value = rw.timeoutMs ?? 60000;
  $('#rwTemperature').value = rw.temperature ?? 0.2;
  renderCacheModes(rw.cache?.mode === 'exact' ? 'exact' : 'none');
  const cast = c.multiNpc || {};
  $('#castEnabled').checked = !!cast.enabled;
  $('#castMaxCoStars').value = cast.maxCoStars ?? 1;
  $('#castMaxCalls').value = cast.maxCallsPerTurn ?? 2;
  $('#castTranscriptTurns').value = cast.transcriptTurns ?? 8;
  $('#castSpeakPolicy').value = cast.speakPolicy || 'addressed';
  $('#castOutputStyle').value = cast.outputStyle || 'script';
  $('#castTailWait').value = cast.actorTailWaitMs ?? 3000;
  $('#castAutoExitMin').value = Math.round((cast.autoExitIdleMs ?? 7200000) / 60000);
  $('#castAllowSilence').checked = cast.allowASilence !== false;
  $('#castWritesMemory').checked = !!cast.coStarWritesMemory;
  $('#castSkipOnTask').checked = cast.skipOnTask !== false;
  $('#castAutoStage').checked = !!cast.autoStage;
}

$('#saveUpstream').addEventListener('click', async () => {
  const patch = {
    upstream: {
      baseUrl: $('#upBaseUrl').value.trim(),
      model: $('#upModel').value.trim(),
      disableThinking: $('#upDisableThinking').checked,
      includeUsage: $('#upIncludeUsage').checked,
      connectTimeoutMs: Number($('#upConnectTimeout').value) || 15000,
      requestTimeoutMs: Number($('#upRequestTimeout').value) || 300000,
    },
  };
  const key = $('#upApiKey').value.trim();
  if (key) patch.upstream.apiKey = key;
  await api('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  $('#upApiKey').value = '';
  flashSaved('memSaved', '上游配置已保存并即时生效');
  loadStatus();
  loadConfig();
});

$('#saveMemory').addEventListener('click', async () => {
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      memory: {
        enabled: $('#memEnabled').checked,
        snapshotSystem: $('#memSnapshot').checked,
        injectMaxChars: Number($('#memInjectChars').value) || 2000,
        summarizer: {
          enabled: $('#sumEnabled').checked,
          everyTurns: Number($('#sumEvery').value) || 4,
          maxMemoryChars: Number($('#sumMaxChars').value) || 800,
        },
      },
    }),
  });
  flashSaved('memSaved', '记忆设置已保存');
  loadConfig();
});

$('#savePrompts').addEventListener('click', async () => {
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompts: { enabled: $('#promptsEnabled').checked, global: $('#promptsGlobal').value },
    }),
  });
  flashSaved('promptsSaved', '提示词设置已保存');
});

$('#saveRewrite').addEventListener('click', async () => {
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestRewrite: {
        enabled: $('#rwEnabled').checked,
        maxTokens: Number($('#rwMaxTokens').value) || 6000,
        timeoutMs: Number($('#rwTimeout').value) || 60000,
        temperature: Number($('#rwTemperature').value),
        cache: { mode: cacheModeSelected() },
      },
    }),
  });
  flashSaved('rwSaved', '重写设置已保存');
});

$('#saveCast').addEventListener('click', async () => {
  const want = $('#castEnabled').checked;
  if (want && !(statusCache?.multiNpc?.enabled)) {
    const ok = window.confirm(
      '多 NPC 共演是实验性功能，开启后：\n\n' +
        '· 每轮可能多一次上游调用，token 消耗明显增加；\n' +
        '· 玩家点名配角时，首字延迟约 +1~2 秒；\n' +
        '· 配角的台词会显示在主角的气泡里（游戏只接受一条回复）。\n\n' +
        '如果同时开启「请求重写」，token 与延迟会进一步叠加。\n\n确定开启吗？',
    );
    if (!ok) {
      $('#castEnabled').checked = false;
      return;
    }
  }
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      multiNpc: {
        enabled: want,
        maxCoStars: Number($('#castMaxCoStars').value) || 1,
        maxCallsPerTurn: Number($('#castMaxCalls').value) || 2,
        transcriptTurns: Number($('#castTranscriptTurns').value) || 8,
        speakPolicy: $('#castSpeakPolicy').value,
        outputStyle: $('#castOutputStyle').value,
        actorTailWaitMs: Number($('#castTailWait').value) || 3000,
        autoExitIdleMs: Math.round((Number($('#castAutoExitMin').value) || 120) * 60000),
        allowASilence: $('#castAllowSilence').checked,
        coStarWritesMemory: $('#castWritesMemory').checked,
        skipOnTask: $('#castSkipOnTask').checked,
        autoStage: $('#castAutoStage').checked,
      },
    }),
  });
  flashSaved('castSaved', '共演设置已保存');
  loadStatus();
  loadConfig();
});

function flashSaved(id, text) {
  const el = $('#' + id);
  el.textContent = '✓ ' + text;
  setTimeout(() => (el.textContent = ''), 2500);
}

$$('[data-copy]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const v = $('#' + btn.dataset.copy).value;
    await navigator.clipboard.writeText(v);
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => (btn.textContent = old), 1200);
  }),
);

// —— Tabs ——
const TAB_KEY = 'wfc.tab';
const TAB_NAMES = new Set($$('.tab').map((t) => t.dataset.tab));

/** 切换 tab；remember=true 时写入 localStorage 与 location.hash。 */
function activateTab(name, { remember = true } = {}) {
  const key = TAB_NAMES.has(name) ? name : 'overview';
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === key));
  $$('.tab-pane').forEach((x) => x.classList.remove('active'));
  const pane = $('#tab-' + key);
  if (pane) pane.classList.add('active');
  if (key === 'npcs') loadNpcs();
  if (!remember) return;
  try {
    localStorage.setItem(TAB_KEY, key);
  } catch {}
  if (location.hash !== '#' + key) {
    try {
      history.replaceState(null, '', '#' + key);
    } catch {
      location.hash = key;
    }
  }
}

$$('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));
window.addEventListener('hashchange', () => activateTab(location.hash.slice(1), { remember: false }));

// 初始 tab：地址栏 hash 优先，其次上次停留的页面
let lastTab = '';
try {
  lastTab = localStorage.getItem(TAB_KEY) || '';
} catch {}
activateTab(location.hash.slice(1) || lastTab, { remember: false });

// —— 日志 ——
function kindOf(rec) {
  return rec.kind || 'server';
}
function kindBadge(rec) {
  const bad = rec.status === 'error' || rec.status === 'upstream_error';
  const kind = kindOf(rec);
  // 少量“按 status 才有意义”的记录：类型名本身会误导（server 默认叫“服务异常”，
  // 但端口顺延是正常的自愈行为，不是故障）。
  const byStatus = rec.status === 'port_fallback' ? '端口已切换' : '';
  const label = bad ? '错误' : esc(byStatus || kindLabel(kind));
  const cls = bad ? 'err' : rec.status === 'port_fallback' ? 'port_fallback' : kind;
  return `<span class="badge ${cls}" title="日志类型：${esc(kind)}">${label}<span class="badge-code">${esc(kind)}</span></span>`;
}

function fmtTok(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

function tokenTag(rec) {
  const tk = rec.tokens;
  if (!tk || tk.total == null) return '';
  const prefix = tk.estimated ? '≈' : '';
  return `<span class="log-tok" title="token 总数${tk.estimated ? '（估算）' : ''}">${prefix}${fmtTok(tk.total)} tok</span>`;
}

/** 中性提示（notes）的展示文案：是兜底说明，不是故障。 */
function noteLabel(n) {
  if (n === 'reply_wrapped_json') return '已按模板补全 JSON';
  return String(n || '');
}

// ============================================================
// 日志标识中文对照
// 日志文件本身仍写英文码（便于 grep 与历史比对、反馈问题时引用），
// 只在界面上翻成中文；英文原文以小号灰字附在后面，两者都可见。
// ============================================================

const KIND_LABELS = {
  npc: 'NPC 对话',
  costar: '配角',
  compressor: '游戏压缩器',
  summary: '记忆压缩',
  memory_edit: '记忆修改',
  probe: '探测',
  idle_flush: '空闲补压记忆',
  config: '配置变更',
  memory_write: '记忆落盘',
  auth: '鉴权失败',
  server: '服务异常',
};

const STATUS_LABELS = {
  done: '完成',
  ok: '成功',
  error: '失败',
  failed: '失败',
  updated: '已更新',
  queued: '已排队',
  skipped: '已跳过',
  started: '已启动',
  stopped: '已停止',
  port_fallback: '端口已自动切换',
  upstream_error: '上游报错',
};

/** 请求重写各模块的失败原因。 */
const REWRITE_ERROR_LABELS = {
  rewrite_output_format_missing: '找不到「## 输出格式」这一节',
  rewrite_output_format_changed: '「## 输出格式」的 JSON 结构被改动',
  rewrite_empty: '模型返回空内容',
  rewrite_too_short: '重写后太短（不足原文 30%）',
  rewrite_too_long: '重写后太长（超过原文 150%）',
  rewrite_duplicate_module: '有模块被重复输出',
  rewrite_parse_failed: '模型输出格式无法解析',
  rewrite_module_missing: '漏掉了某个模块',
  rewrite_cast_name_changed: '配角的名字被改动',
  rewrite_cast_identity_changed: '配角的身份被改动',
  all_modules_failed: '所有模块都重写失败，本轮未生效',
};

const CAST_REJECT_REASONS = {
  unknown: '没有这个角色',
  self: '就是当前主角，不能当配角',
  not_enabled: '这个角色没开启共演',
  no_intake: '这个角色还没有档案（还没见过面）',
};

const CAST_SKIP_REASONS = {
  task: '这是游戏任务轮，配角本轮不接话',
  no_card: '配角缺少角色档案，本轮不接话',
  no_costar: '场上没有配角',
};

/** 上游/网络类错误的常见原文 → 中文。认不出的保留原文。 */
const ERROR_TEXT_LABELS = {
  'fetch failed': '连不上上游（网络中断或地址填错）',
  'This operation was aborted': '请求被中断（可能是超时或关窗）',
  摘要响应为空: '上游返回了空内容',
  改写响应为空: '上游返回了空内容',
  摘要超时: '摘要请求超时',
  记忆改写超时: '记忆改写请求超时',
  配角调用超时: '配角请求超时',
  请求重写超时: '请求重写超时',
  客户端已断开: '游戏端提前断开了连接',
  stage_save_failed: '保存在场状态失败',
  cast_actor_failed: '配角请求失败',
  summary_failed: '记忆压缩失败',
};

function kindLabel(kind) {
  return KIND_LABELS[kind] || String(kind || '');
}

function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || '');
}

function rewriteErrorLabel(code) {
  const s = String(code || '');
  const [head, ...rest] = s.split(':');
  const cn = REWRITE_ERROR_LABELS[head];
  if (!cn) return s;
  const tail = rest.length ? '（模块 ' + rest.join(' ') + '）' : '';
  return cn + tail;
}

/**
 * 单条 warning 的中文含义。认不出的码原样返回中文为空，由调用方只显示原文。
 * @returns {string} 中文说明（可能为空串）
 */
function warningLabel(w) {
  const s = String(w ?? '');
  const [head, ...rest] = s.split(':');
  switch (head) {
    case 'memory_over_limit': {
      const m = /^(\d+)>(\d+)$/.exec(rest.join(':'));
      return m
        ? `记忆 ${m[1]} 字超过上限 ${m[2]} 字，已按板块裁剪较多，可能丢内容`
        : '记忆超过上限，已按板块裁剪较多';
    }
    case 'cast_stage_cleared':
      return rest[0] === 'scene'
        ? '换了场景，上回在场的配角已自动清场'
        : '上回在场的配角闲了太久（超过超时时间），已自动清场';
    case 'cast_overflow':
      return '一次进了多个配角，只保留最近一位';
    case 'cast_command_rejected': {
      const [name, reason] = rest;
      return `指令没能让「${name}」入场：${CAST_REJECT_REASONS[reason] || reason}`;
    }
    case 'cast_command_noop':
      return `「${rest[0]}」本来就不在场，离场指令没起作用`;
    case 'cast_point_ignored':
      return '本轮发言次数已用完，忽略了这次点名';
    case 'cast_skipped':
      return CAST_SKIP_REASONS[rest[0]] || '共演本轮未生效';
    case 'cast_plan_failed':
      return `共演规划出错：${rest.join(':')}`;
    case 'cast_a_wrote_costar':
      return '主角自己写出了配角的台词，已按配角处理';
    case 'costar_slot_missed':
      return '没找到插入配角台词的位置，本轮配角台词没插进去';
    case 'costar_fallback':
      return '主角回复不是标准 JSON，配角台词没能插进去';
    case 'costar_silent':
      return '配角该开口，但没说出内容';
    case 'prompt_load_failed':
      return `读取这个 NPC 的个人提示词失败：${rest.join(':')}`;
    case 'snapshot_failed':
      return `保存 system 原文存档失败：${rest.join(':')}`;
    case 'memory_init_failed':
      return `初始化记忆失败：${rest.join(':')}`;
    case 'rewrite_skipped':
      return '没有可重写的文本 system，跳过了请求重写';
    case 'rewrite_failed': {
      const last = rest[rest.length - 1] || '';
      const why = REWRITE_ERROR_LABELS[last];
      if (/^module\d+$/.test(rest[0] || '')) {
        return `第 ${rest[0].replace('module', '')} 个 system 模块重写失败，已回退原文：${why || last}`;
      }
      return `请求重写未生效：${why || last || '未知原因'}`;
    }
    case 'reply_not_json':
      return '模型没按 JSON 格式回复，游戏可能显示异常';
    case 'reply_repaired':
      return '回复里的 JSON 有瑕疵，已自动修复';
    case 'reply_wrapped_json':
      return '已按模板补全 JSON';
    default:
      return '';
  }
}

/** 通用错误文本的中文化；认不出的原样返回。 */
function errorTextLabel(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (ERROR_TEXT_LABELS[s]) return ERROR_TEXT_LABELS[s];
  const head = s.split(':')[0];
  if (ERROR_TEXT_LABELS[head]) return ERROR_TEXT_LABELS[head] + '：' + s.slice(head.length + 1);
  // 上游 401/402/429 这类带状态码的
  const up = /^上游 (\d{3})[:：]/.exec(s);
  if (up) {
    const code = up[1];
    const hint =
      {
        401: 'API Key 无效或已过期',
        402: '账户余额不足',
        403: '没有权限',
        429: '请求太频繁被限流',
        500: '上游服务出错',
        502: '上游网关出错',
        503: '上游服务暂时不可用',
      }[code] || '上游返回错误';
    return `${hint}（HTTP ${code}）`;
  }
  return s;
}

/** warning 渲染：中文说明 + 英文原码（原码始终可见，便于反馈时引用）。 */
function warningHtml(w) {
  const raw = String(w ?? '');
  const cn = warningLabel(raw);
  if (!cn) return `<span class="log-code">${esc(raw)}</span>`;
  return `${esc(cn)}<span class="log-code">${esc(raw)}</span>`;
}

function originLabel(origin) {
  return (
    {
      game: '游戏原始',
      game_rewritten: '游戏重写后',
      memory: '外置记忆',
      prompt: '外置提示词',
      style: '外置提示词',
      cast: '共演现场',
      format: '格式提醒',
      history: '历史对话',
      player: '玩家本轮',
      internal: '内部调用',
      other: '其他',
    }[origin] || origin || ''
  );
}

function renderDetail(d) {
  const req = d.request || {};
  const meta = [
    req.model ? `模型 ${req.model}` : '',
    req.stream ? '流式' : '非流式',
    req.messageCount != null ? `${req.messageCount} 条消息` : '',
    req.temperature != null ? `temperature ${req.temperature}` : '',
    req.max_tokens != null ? `max_tokens ${req.max_tokens}` : '',
    req.thinking ? `thinking ${JSON.stringify(req.thinking)}` : 'thinking 默认',
  ]
    .filter(Boolean)
    .join(' · ');

  const messages = (d.messages || [])
    .map(
      (m) => `<div class="msg-item origin-${esc(m.origin || 'game')}">
        <div class="msg-meta">
          <span class="msg-role">${esc(m.role)}</span>
          <span class="msg-origin">${esc(originLabel(m.origin))}</span>
          <span class="msg-origin">${m.chars != null ? m.chars + ' 字' : ''}</span>
        </div>
        <pre class="detail-pre">${esc(m.content || '')}</pre>
      </div>`,
    )
    .join('');

  const reasoning = d.reasoning
    ? `<pre class="detail-pre">${esc(d.reasoning)}${d.reasoningTruncated ? '\n…（思维链过长，已截断）' : ''}</pre>`
    : `<p class="detail-note">${
        d.kind === 'summary' || d.kind === 'memory_edit'
          ? '内部调用已禁用思考，无思维链。'
          : '上游未返回思维链（可能未开启思考，或该模型不支持 reasoning_content）。'
      }</p>`;

  const replyLabel =
    d.kind === 'summary' ? '生成结果（记忆正文）' : d.kind === 'memory_edit' ? '生成草稿' : '完整回复';
  const reply = d.reply
    ? `<pre class="detail-pre">${esc(d.reply)}</pre>`
    : '<p class="detail-note">（无回复文本）</p>';
  const error = d.error
    ? `<p class="detail-note warn">错误：${esc(errorTextLabel(d.error))}<span class="log-code">${esc(d.error)}</span></p>`
    : '';

  const tk = d.tokens;
  const tokenLine =
    tk && tk.total != null
      ? `<div class="token-usage">
          <span class="token-usage-title">Token 用量</span>
          <span class="token-usage-total">${tk.estimated ? '≈' : ''}${fmtTok(tk.total)} tok</span>
          <span class="token-usage-source">${tk.estimated ? '字符估算' : '上游 usage'}</span>
          ${
            d.rewrite && d.rewrite.tokens && d.rewrite.tokens.total != null
              ? `<span class="token-usage-source">另：重写 ${d.rewrite.tokens.estimated ? '≈' : ''}${fmtTok(d.rewrite.tokens.total)} tok</span>`
              : ''
          }
        </div>`
      : '';

  const ca = d.cast;
  let castBlock = '';
  if (ca && (ca.coStar || ca.bLine || ca.messages?.length || ca.notes?.length || ca.commands?.length)) {
    const bTok =
      ca.tokens && ca.tokens.total != null
        ? `${ca.tokens.estimated ? '≈' : ''}${fmtTok(ca.tokens.total)} tok`
        : '—';
    const bMessages = (ca.messages || [])
      .map(
        (m) => `<div class="msg-item origin-internal">
          <div class="msg-meta"><span class="msg-role">${esc(m.role)}</span><span class="msg-origin">${esc(m.chars != null ? m.chars + ' 字' : '')}</span></div>
          <pre class="detail-pre">${esc(m.content || '')}</pre>
        </div>`,
      )
      .join('');
    const orderText = ca.order === 'B' ? '配角先开口 → 主角后接' : '主角先开口 → 配角后接';
    castBlock = `
      <div class="detail-section">
        <h5>共演 · 配角 ${esc(ca.coStar?.name || '（无）')}${ca.coStar?.slug ? `（${esc(ca.coStar.slug)}）` : ''}</h5>
        ${ca.commands?.length ? `<p class="detail-note">指令：${esc(ca.commands.join('、'))}</p>` : ''}
        ${ca.notes?.length ? `<p class="detail-note">本场变化：${esc(ca.notes.join(''))}</p>` : ''}
        <p class="detail-note">${esc(orderText)} · 台词${ca.inserted ? '已插入' : '未插入'}${ca.slotFailed ? '（插槽定位失败）' : ''} · 配角台词 ${ca.bLineChars ?? 0} 字 · 耗时 ${ca.timing?.durationMs ?? '—'}ms · token ${bTok}${ca.error ? ` · ${esc(ca.error)}` : ''}</p>
        ${ca.bLine ? `<pre class="detail-pre cast-line">${esc(ca.bLine)}</pre>` : '<p class="detail-note">（本轮配角未开口）</p>'}
        ${bMessages ? `<details class="rw-details"><summary>配角请求（${(ca.messages || []).length} 条消息）</summary>${bMessages}</details>` : ''}
        ${ca.reply ? `<details class="rw-details"><summary>配角原始回复（${String(ca.reply).length} 字）</summary><pre class="detail-pre">${esc(ca.reply)}</pre></details>` : ''}
      </div>`;
  }

  const rw = d.rewrite;
  let rewriteBlock = '';
  if (rw) {
    const rwTok = rw.cacheHit
      ? '0'
      : rw.tokens && rw.tokens.total != null
        ? `${rw.tokens.estimated ? '≈' : ''}${fmtTok(rw.tokens.total)} tok`
        : '—';
    const rwMessages = (rw.messages || [])
      .map(
        (m) => `<div class="msg-item origin-internal">
          <div class="msg-meta"><span class="msg-role">${esc(m.role)}</span><span class="msg-origin">${esc(originLabel(m.origin))}</span><span class="msg-origin">${m.chars != null ? m.chars + ' 字' : ''}</span></div>
          <pre class="detail-pre">${esc(m.content || '')}</pre>
        </div>`,
      )
      .join('');
    const rwLabel =
      rw.status === 'done'
        ? '成功'
        : rw.status === 'partial'
          ? '部分成功（失败模块已回退原文）'
          : '失败（已回退原文）';
    const modules = Array.isArray(rw.modules)
      ? rw.modules
      : rw.originalSystem != null
        ? [
            {
              index: 0,
              title: '主 system',
              status: rw.status,
              changed: true,
              original: rw.originalSystem,
              rewritten: rw.rewrittenSystem,
              removed: rw.removed,
              added: rw.added,
              removedCount: rw.removedCount,
              addedCount: rw.addedCount,
            },
          ]
        : [];
    const changedModules = modules.filter((m) => m.changed || m.repaired || m.status !== 'done');
    const unchangedModules = modules.filter((m) => !m.changed && !m.repaired && m.status === 'done');
    const moduleHtml = changedModules
      .map(
        (m) => `<div class="rw-module">
          <h6>模块 #${m.id ?? m.index}${m.id != null ? `（消息 #${m.index}）` : ''} · ${esc(m.title || '')} · ${
            m.status === 'done'
              ? m.dropped
                ? '已整模块删除（整节均与设定冲突）'
                : m.repaired
                  ? m.changed
                    ? '已改写（格式已修复）'
                    : '格式已修复（内容未变）'
                  : '已改写'
              : '未改动（校验未通过：' + esc(rewriteErrorLabel(m.error || '校验失败')) + '）'
          }</h6>
          <p class="detail-note">${m.originalChars ?? '—'} 字 → ${m.rewrittenChars ?? '—'} 字 · 删除 ${m.removedCount ?? 0} 行 / 新增 ${m.addedCount ?? 0} 行</p>
          ${m.removed && m.removed.length ? `<p class="detail-note">删除的原文行：</p><pre class="detail-pre">${esc(m.removed.join('\n'))}</pre>` : ''}
          ${m.added && m.added.length ? `<p class="detail-note">新增/改写后的行：</p><pre class="detail-pre">${esc(m.added.join('\n'))}</pre>` : ''}
          ${m.original != null ? `<details class="rw-details"><summary>原始内容（${String(m.original).length} 字）</summary><pre class="detail-pre">${esc(m.original)}</pre></details>` : ''}
          ${m.draft != null ? `<details class="rw-details"><summary>模型草稿（未采用，${String(m.draft).length} 字）</summary><pre class="detail-pre">${esc(m.draft)}</pre></details>` : ''}
          ${m.dropped ? '<p class="detail-note">该模块已从发给上游的请求中移除。</p>' : ''}
          ${m.rewritten != null && !m.dropped ? `<details class="rw-details"><summary>${m.status === 'done' ? '重写后内容' : '实际采用（已回退原文）'}（${String(m.rewritten).length} 字）</summary><pre class="detail-pre">${esc(m.rewritten)}</pre></details>` : ''}
        </div>`,
      )
      .join('');
    rewriteBlock = `
      <div class="detail-section">
        <h5>请求重写（实验性）· ${rwLabel}</h5>
        <p class="detail-note">耗时 ${rw.timing?.durationMs ?? '—'}ms · 额外 token ${rwTok} · 模块 ${rw.moduleCount ?? modules.length} 个，改写 ${rw.changedCount ?? changedModules.length} 个${rw.droppedCount ? `（整模块删除 ${rw.droppedCount} 个）` : ''}${rw.repairedCount ? `，修复格式 ${rw.repairedCount} 个` : ''}，失败 ${rw.failedCount ?? 0} 个 · 删除 ${rw.removedCount ?? 0} 行 / 新增 ${rw.addedCount ?? 0} 行${rw.error ? ` · 原因：${esc(rewriteErrorLabel(rw.error))}` : ''}${rw.cacheHit ? ` · <strong>命中缓存</strong>（省 ${rw.savedDurationMs || 0}ms / ${fmtTok(rw.savedTokens || 0)} tok${rw.cacheAgeMs != null ? `，缓存 ${Math.round(rw.cacheAgeMs / 1000)} 秒前` : ''}）` : ''}</p>
        ${moduleHtml || '<p class="detail-note">（没有发生改写的模块）</p>'}
        ${unchangedModules.length ? `<p class="detail-note">未改动模块：${unchangedModules.map((m) => esc(m.title || '')).join('、')}</p>` : ''}
        <details class="rw-details"><summary>重写调用 Prompt（${(rw.messages || []).length} 条消息）</summary>${rwMessages || '<p class="detail-note">（无）</p>'}</details>
      </div>`;
  }

  return `${tokenLine}${error}${castBlock}${rewriteBlock}
    <div class="detail-bar">
      <span class="detail-note">${esc(meta)}</span>
      <span class="detail-actions">
        <button class="btn sm" data-copy-detail="prompt">复制 Prompt</button>
        <button class="btn sm" data-copy-detail="reasoning">复制思维链</button>
        <button class="btn sm" data-copy-detail="reply">复制回复</button>
      </span>
    </div>
    <div class="detail-section">
      <h5>发送给上游的 Prompt（${(d.messages || []).length} 条消息）</h5>
      ${messages || '<p class="detail-note">（无）</p>'}
    </div>
    <div class="detail-section"><h5>思维链</h5>${reasoning}</div>
    <div class="detail-section"><h5>${replyLabel}</h5>${reply}</div>`;
}

function bindDetailActions(host) {
  host.querySelectorAll('[data-copy-detail]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const d = host._detail || {};
      let text = '';
      if (btn.dataset.copyDetail === 'prompt') {
        text = (d.messages || [])
          .map((m) => `[${m.role} · ${originLabel(m.origin)}]\n${m.content || ''}`)
          .join('\n\n');
      } else if (btn.dataset.copyDetail === 'reasoning') {
        text = d.reasoning || '';
      } else {
        text = d.reply || '';
      }
      try {
        await navigator.clipboard.writeText(text);
        const old = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = old), 1200);
      } catch {}
    });
  });
}

async function toggleLogDetail(div, rec) {
  const label = div.querySelector('.log-expand');
  const open = div.dataset.expanded === '1';
  if (open) {
    div.dataset.expanded = '';
    div.setAttribute('aria-expanded', 'false');
    div.classList.remove('expanded');
    if (label) label.textContent = '详情 ▾';
    const host = div.querySelector('.log-detail');
    if (host) host.hidden = true;
    return;
  }

  div.dataset.expanded = '1';
  div.setAttribute('aria-expanded', 'true');
  div.classList.add('expanded');
  if (label) label.textContent = '收起 ▴';

  let host = div.querySelector('.log-detail');
  if (!host) {
    host = document.createElement('div');
    host.className = 'log-detail';
    host.innerHTML = '<p class="detail-note">加载详情…</p>';
    div.appendChild(host);
  }
  host.hidden = false;
  if (host.dataset.loaded === '1') return;

  try {
    const d = await api('/api/logs/' + encodeURIComponent(rec.rid) + '/detail');
    host._detail = d.detail;
    host.innerHTML = renderDetail(d.detail);
    host.dataset.loaded = '1';
    bindDetailActions(host);
  } catch (err) {
    const msg = String(err.message || err);
    host.innerHTML = msg.includes('404')
      ? '<p class="detail-note">详情已过期或不存在（服务仅保留最近 14 天的详情）。</p>'
      : `<p class="detail-note warn">加载详情失败：${esc(msg)}</p>`;
  }
}

function renderLog(rec) {
  const t = new Date(rec.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const div = document.createElement('div');
  div.className = 'log-item ' + kindOf(rec);
  div.dataset.status = rec.status || '';
  div.dataset.rid = rec.rid || '';
  if (rec.hasDetail) div.classList.add('has-detail');
  let body = '';

  if (rec.kind === 'npc' || rec.kind === 'compressor' || rec.kind === 'probe') {
    const timing = [];
    if (rec.contentTtftMs != null) timing.push('内容首字 ' + rec.contentTtftMs + 'ms');
    else if (rec.ttftMs != null) timing.push('首字节 ' + rec.ttftMs + 'ms');
    if (rec.durationMs != null) timing.push('总耗时 ' + rec.durationMs + 'ms');
    if (rec.kind === 'npc') {
      // 0.11.1 的历史记录把纯文本兜底放进了 warnings；按中性提示渲染，不再标红。
      const warnList = (rec.warnings || []).filter((w) => w !== 'reply_wrapped_json');
      const noteList = [...(rec.notes || []), ...(rec.warnings || []).filter((w) => w === 'reply_wrapped_json')];
      body = `
        <div class="log-line"><span class="who">玩家：</span>${esc(rec.playerText || '')}</div>
        ${rec.replyPreview ? `<div class="log-reply">${esc(rec.replyPreview)}</div>` : ''}
        <div class="log-meta">
          ${rec.slug ? `<span class="log-slug">${esc(rec.slug)}</span>${rec.variant ? `<span class="tag">变体 ${esc(rec.variant)}</span>` : ''}` : ''}
          ${rec.isNewNpc ? '<span class="tag">新建档</span>' : ''}
          ${rec.injectChars ? `<span>注入记忆 ${rec.injectChars} 字</span>` : ''}
          ${rec.promptChars || rec.styleChars ? `<span>外置提示词 ${rec.promptChars || rec.styleChars} 字</span>` : ''}
          ${
            rec.rewrite
              ? `<span class="${rec.rewrite.status === 'done' ? '' : 'warn'}">重写${
                  rec.rewrite.status === 'done'
                    ? '成功'
                    : rec.rewrite.status === 'partial'
                      ? '部分成功'
                      : '失败'
                }${
                  rec.rewrite.cacheHit
                    ? ` ${rec.rewrite.cacheMode === 'exact' ? '机制 1 ' : ''}缓存命中 · 省 ${
                        rec.rewrite.savedDurationMs
                          ? Math.round(rec.rewrite.savedDurationMs / 1000) + 's'
                          : '—'
                      } / ${fmtTok(rec.rewrite.savedTokens || 0)} tok`
                    : `${
                        rec.rewrite.changedModules != null
                          ? ` 改写 ${rec.rewrite.changedModules}/${rec.rewrite.modules} 模块`
                          : ''
                      }${rec.rewrite.durationMs != null ? ' ' + rec.rewrite.durationMs + 'ms' : ''}${
                        rec.rewriteTokens != null ? ' · ' + fmtTok(rec.rewriteTokens) + ' tok' : ''
                      }`
                }</span>`
              : ''
          }
          ${tokenTag(rec)}
          ${timing.map((x) => `<span>${x}</span>`).join('')}
          ${warnList.length ? `<span class="warn">⚠ ${warnList.map(warningHtml).join('；')}</span>` : ''}
          ${noteList.length ? `<span class="tag">${esc(noteList.map(noteLabel).join('；'))}</span>` : ''}
        </div>`;
    } else {
      body = `<div class="log-meta">${esc(rec.modelIn || '')} → ${esc(rec.modelOut || '')} ${tokenTag(rec)} ${timing.map((x) => `<span>${x}</span>`).join('')}</div>`;
    }
  } else if (rec.kind === 'summary') {
    const fittedTag =
      rec.fitted && rec.preTruncateChars > rec.memoryChars
        ? `<span class="tag" title="记忆长期贴着上限，每轮会按板块预算收一点，属于正常压缩">已按板块压缩 ${rec.preTruncateChars - rec.memoryChars} 字</span>`
        : '';
    body = `<div class="log-line">${esc(rec.slug || '')} 记忆压缩 ${rec.status === 'done' ? '完成' : '失败'}</div>
      <div class="log-meta">${rec.durationMs != null ? `<span>${rec.durationMs}ms</span>` : ''}${rec.memoryChars != null ? `<span>${rec.memoryChars} 字</span>` : ''}${fittedTag}${tokenTag(rec)}${rec.warnings && rec.warnings.length ? `<span class="warn">⚠ ${rec.warnings.map(warningHtml).join('；')}</span>` : ''}${rec.error ? `<span class="warn">${esc(errorTextLabel(rec.error))}<span class="log-code">${esc(rec.error)}</span></span>` : ''}</div>`;
  } else if (rec.kind === 'memory_edit') {
    const act = rec.action === 'save' ? '保存记忆' : 'AI 改写记忆';
    body = `<div class="log-line">${esc(rec.slug || '')} ${act} ${rec.status === 'done' ? '完成' : '失败'}</div>
      <div class="log-meta">${rec.durationMs != null ? `<span>${rec.durationMs}ms</span>` : ''}${rec.generatedChars != null ? `<span>生成 ${rec.generatedChars} 字</span>` : ''}${rec.memoryChars != null ? `<span>${rec.memoryChars} 字</span>` : ''}${tokenTag(rec)}${rec.backup ? `<span>备份 ${esc(rec.backup)}</span>` : ''}${rec.error ? `<span class="warn">${esc(errorTextLabel(rec.error))}<span class="log-code">${esc(rec.error)}</span></span>` : ''}</div>`;
  } else if (rec.kind === 'costar') {
    body = `<div class="log-line"><span class="who">配角：</span>${esc(rec.actor || '')} <span class="muted">（为 ${esc(rec.slug || '')} 配戏${
      rec.turnId ? ' · ' + esc(String(rec.turnId).slice(-4)) : ''
    }）</span></div>
      ${rec.replyPreview ? `<div class="log-reply">${esc(rec.replyPreview)}</div>` : ''}
      <div class="log-meta">
        ${rec.order != null ? `<span>第 ${rec.order} 次</span>` : ''}
        ${rec.mode ? `<span>${rec.mode === 'head' ? '配角先说' : '配角接话'}</span>` : ''}
        ${rec.durationMs != null ? `<span>${rec.durationMs}ms</span>` : ''}
        ${tokenTag(rec)}
        ${rec.warnings && rec.warnings.length ? `<span class="warn">⚠ ${rec.warnings.map(warningHtml).join('；')}</span>` : ''}
        ${rec.error ? `<span class="warn">${esc(errorTextLabel(rec.error))}<span class="log-code">${esc(rec.error)}</span></span>` : ''}
      </div>`;
  } else if (rec.kind === 'server' && rec.status === 'port_fallback') {
    body = `<div class="log-line warn">端口 ${esc(String(rec.from ?? ''))} 已被占用，已自动切换到 ${esc(
      String(rec.to ?? ''),
    )}</div>
      <div class="log-meta"><span>实际端口已写入配置，重启仍使用该端口</span><span>请把游戏 Base URL 改成 http://127.0.0.1:${esc(
        String(rec.to ?? ''),
      )}/v1</span></div>`;
  } else if (rec.kind === 'auth') {
    body = `<div class="log-line warn">鉴权失败（游戏端的 API Key 与本程序不一致）：${esc(rec.path || '')} @ ${esc(rec.ip || '')}</div>`;
  } else if (rec.kind === 'idle_flush') {
    body = `<div class="log-line">${esc(rec.slug || '')} 空闲补压记忆：已排队</div>
      <div class="log-meta">
        ${rec.turns != null ? `<span>已聊 ${rec.turns} 轮</span>` : ''}
        ${rec.lastSummaryTurn != null ? `<span>上次压到第 ${rec.lastSummaryTurn} 轮</span>` : ''}
        ${rec.idleMs != null ? `<span>已空闲 ${Math.round(rec.idleMs / 60000)} 分钟</span>` : ''}
      </div>`;
  } else if (rec.kind === 'memory_write') {
    body = `<div class="log-line">${esc(rec.slug || '')} 记忆落盘 ${rec.status === 'error' ? '失败' : '完成'}</div>
      <div class="log-meta">${rec.error ? `<span class="warn">${esc(errorTextLabel(rec.error))}<span class="log-code">${esc(rec.error)}</span></span>` : ''}</div>`;
  } else {
    const st = statusLabel(rec.status);
    const errCn = rec.error ? errorTextLabel(rec.error) : '';
    body = `<div class="log-line">${esc(kindLabel(rec.kind))}${st ? ' · ' + esc(st) : ''}${
      errCn ? ` · <span class="warn">${esc(errCn)}</span>` : ''
    }</div>
      <div class="log-meta">${rec.status ? `<span>状态码：${esc(rec.status)}</span>` : ''}${
        rec.error ? `<span class="log-code">${esc(rec.error)}</span>` : ''
      }</div>`;
  }

  div.innerHTML = `<div class="log-head">${kindBadge(rec)}<span>${t}</span><span>#${rec.seq}</span>${
    rec.hasDetail ? '<span class="log-expand">详情 ▾</span>' : ''
  }</div><div class="log-body">${body}</div>`;

  if (rec.hasDetail) {
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-expanded', 'false');
    div.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, textarea, .log-detail')) return;
      const sel = window.getSelection?.();
      if (sel && sel.toString()) return;
      toggleLogDetail(div, rec);
    });
    div.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('button, a, input, textarea, .log-detail')) return;
      e.preventDefault();
      toggleLogDetail(div, rec);
    });
  }
  return div;
}

function matchFilter(rec) {
  if (currentKind === 'all') return true;
  // 0.11.1 曾把纯文本兜底写进 warnings；它不算错误，历史记录也按中性提示处理。
  if (currentKind === 'error-only') {
    return (
      rec.status === 'error' ||
      rec.status === 'upstream_error' ||
      (rec.warnings || []).some((w) => w !== 'reply_wrapped_json')
    );
  }
  return kindOf(rec) === currentKind;
}

/** 批量渲染：按时间倒序（最新在上），用于首次快照与筛选结果。 */
function renderLogs(records) {
  const list = $('#logList');
  list.innerHTML = '';
  records
    .filter(matchFilter)
    .slice()
    .sort((a, b) => {
      const byTime = String(b.ts || '').localeCompare(String(a.ts || ''));
      return byTime !== 0 ? byTime : (Number(b.seq) || 0) - (Number(a.seq) || 0);
    })
    .forEach((r) => list.appendChild(renderLog(r)));
  if ($('#autoScroll').checked) list.scrollTop = 0;
}

/** 实时新日志：插到顶部；关闭自动滚动时保持当前阅读位置。 */
function addLog(rec) {
  if (!matchFilter(rec)) return;
  const list = $('#logList');
  const prevTop = list.scrollTop;
  const prevHeight = list.scrollHeight;
  list.prepend(renderLog(rec));
  while (list.children.length > 500) list.removeChild(list.lastElementChild);
  if ($('#autoScroll').checked) list.scrollTop = 0;
  else list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
}

$$('#kindFilters .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    $$('#kindFilters .chip').forEach((x) => x.classList.remove('active'));
    chip.classList.add('active');
    currentKind = chip.dataset.kind;
    api('/api/logs?limit=300')
      .then((d) => renderLogs(d.records))
      .catch(() => {});
  }),
);

$('#clearLogView').addEventListener('click', () => ($('#logList').innerHTML = ''));

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') {
      renderLogs(msg.records);
    } else if (msg.type === 'log') {
      addLog(msg.record);
    }
  };
}

// —— NPC ——
async function loadNpcs() {
  const d = await api('/api/npcs');
  $('#npcCount').textContent = d.npcs.length ? `(${d.npcs.length})` : '';
  const list = $('#npcList');
  if (!d.npcs.length) {
    list.innerHTML = '<p class="hint">尚无 NPC 建档。进行一次游戏对话后会自动出现。</p>';
    return;
  }
  list.innerHTML = '';
  d.npcs.forEach((n) => {
    const div = document.createElement('div');
    div.className = 'npc-item';
    const name = n.rawNames[0] || n.slug;
    const g = n.lastGame || {};
    div.innerHTML = `
      <div class="name">${esc(name)}${n.variants.length ? n.variants.map((v) => `<span class="tag">~${esc(v)}</span>`).join('') : ''}${n.promptChars ? '<span class="tag">个人提示词</span>' : ''}${n.castEnabled ? '<span class="tag">共演已启用</span>' : ''}${(n.aliases || []).length ? '<span class="tag">别名 ' + n.aliases.length + '</span>' : ''}</div>
      <div class="sub">${n.turns} 轮 · ${g.relation ? esc(g.relation) + ' · ' : ''}${g.scene ? esc(g.scene) : ''} · ${new Date(n.lastSeen).toLocaleString('zh-CN', { hour12: false })}</div>`;
    div.addEventListener('click', () => {
      $$('.npc-item').forEach((x) => x.classList.remove('active'));
      div.classList.add('active');
      loadNpcDetail(n.slug, name);
    });
    list.appendChild(div);
  });
}

async function loadNpcDetail(slug, name) {
  const d = await api('/api/npcs/' + encodeURIComponent(slug));
  const g = d.state?.lastGame || {};
  const st = d.prompt || { useGlobal: true, text: '' };
  const hasDraft = !!draftState && draftState.slug === slug;
  const convs = d.conversations
    .slice()
    .reverse()
    .map((c) => {
      const who = c.role === 'player' ? '玩家' : esc(name);
      const meta = [c.game_time, c.scene, c.emotion, c.control, c.reply_json_ok === false ? '⚠非JSON' : null].filter(Boolean).join(' · ');
      return `<div class="conv-item ${c.role}"><div class="meta">${esc(who)} · ${esc(meta)}</div><div>${esc(c.content)}</div></div>`;
    })
    .join('');
  const draftBlock = hasDraft
    ? `
    <label>草稿预览（可直接编辑；保存后用此内容覆盖记忆）</label>
    <textarea id="memDraft" class="mem-draft" rows="14">${esc(draftState.text)}</textarea>
    <div class="act-row">
      <button class="btn sm" id="memCancel">取消</button>
      <button class="btn primary sm" id="memSave">保存（自动备份）</button>
    </div>
    <p class="hint">保存前会先把当前记忆按时间戳备份到该 NPC 目录下的 <code>backups/</code>。</p>`
    : '';
  $('#npcDetail').innerHTML = `
    <h3>${esc(name)} <span class="muted">${esc(slug)}</span></h3>
    <div class="log-meta">
      ${d.state?.variants?.length ? `<span>心境变体：${d.state.variants.map(esc).join('、')}</span>` : ''}
      ${g.gameTime ? `<span>${esc(g.gameTime)}</span>` : ''}
      ${g.scene ? `<span>${esc(g.scene)}</span>` : ''}
      ${g.relation ? `<span>关系：${esc(g.relation)}</span>` : ''}
      ${g.title ? `<span>名份：${esc(g.title)}</span>` : ''}
    </div>
    <h4>长期记忆（注入模型的内容）</h4>
    <pre>${esc(d.memory.replace(/^#.*\n/, '').replace(/^>.*\n/g, '').trim() || '（暂无）')}</pre>
    <h4>AI 修改记忆</h4>
    <div class="mem-edit">
      <label>一次性修改要求（交给当前上游模型按此指令改写上面的记忆，生成草稿）</label>
      <textarea id="memEditPrompt" rows="4" placeholder="例如：删掉【未了之事】里已经了结的酒钱条目；并补上一条「她讨厌雨天」。">${esc(hasDraft ? draftState.prompt : '')}</textarea>
      <div class="act-row"><span class="saved-hint" id="memStatus"></span><button class="btn sm" id="memRewrite">AI 生成草稿</button></div>
      ${draftBlock}
    </div>
    <h4>个人提示词（本 NPC 专属，可写人物设定、口吻、尺度等一切内容）</h4>
    <label class="check small"><input type="checkbox" id="npcPromptUseGlobal" ${st.useGlobal !== false ? 'checked' : ''} /> 叠加全局提示词（取消勾选则只用本 NPC 提示词）</label>
    <textarea id="npcPromptText" rows="6" placeholder="例如：她其实早已认出玩家，只是装作不认识；性格更热情主动，会主动找话题；或更严肃寡言，只用短句……">${esc(st.text)}</textarea>
    <div class="act-row"><button class="btn primary sm" id="saveNpcPrompt">保存本 NPC 提示词</button><span class="saved-hint" id="npcPromptSaved"></span></div>
    <h4>共演：是否允许作为配角</h4>
    <label class="check small"><input type="checkbox" id="npcCastEnabled" ${d.castEnabled ? 'checked' : ''} ${d.hasIntake ? '' : 'disabled'} /> 允许被邀请到其他 NPC 的对话中（默认关闭）</label>
    <p class="hint">${d.hasIntake ? '只有勾选并保存后，玩家在括号里提到该 NPC 或用 /invite 才会把它拉进场。' : '该 NPC 没有 intake 存档，无法启用共演。'}</p>
    <div class="act-row"><button class="btn primary sm" id="saveNpcCast">保存共演开关</button><span class="saved-hint" id="npcCastSaved"></span></div>
    <h4>共演：在场状态</h4>
    <p class="hint">${
      d.stage?.onStage?.length
        ? '当前在场：' + d.stage.onStage.map((x) => esc(x.name || x.slug)).join('、') + (d.stage.sceneKey ? '（' + esc(d.stage.sceneKey) + '）' : '')
        : '当前没有配角在场。玩家可用括号把别的 NPC 拉进来。'
    }</p>
    ${d.hasIntake ? '' : '<p class="hint">该 NPC 没有 intake 存档（从未成功对话过），不能作为配角入场。</p>'}
    <div class="act-row"><button class="btn sm" id="clearStage">清空在场</button><span class="saved-hint" id="stageSaved"></span></div>
    <h4>共演：别名（每行一个，用于识别点名）</h4>
    <textarea id="npcAliases" rows="3" placeholder="例如：梦儿&#10;小弦娘">${esc((d.aliases || []).join('\n'))}</textarea>
    <div class="act-row"><button class="btn primary sm" id="saveAliases">保存别名</button><span class="saved-hint" id="aliasSaved"></span></div>
    <h4>最近对话（最新在上）</h4>
    ${convs || '<p class="hint">暂无对话。</p>'}`;
  $('#saveNpcPrompt').addEventListener('click', async () => {
    await api('/api/npcs/' + encodeURIComponent(slug) + '/prompt', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        useGlobal: $('#npcPromptUseGlobal').checked,
        text: $('#npcPromptText').value,
      }),
    });
    flashSaved('npcPromptSaved', '已保存');
    loadNpcs();
  });

  $('#saveNpcCast').addEventListener('click', async () => {
    try {
      await api('/api/npcs/' + encodeURIComponent(slug) + '/cast', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: $('#npcCastEnabled').checked }),
      });
      flashSaved('npcCastSaved', '已保存');
      loadNpcs();
    } catch (err) {
      $('#npcCastSaved').textContent = '保存失败：' + String(err.message || err);
    }
  });

  $('#clearStage').addEventListener('click', async () => {
    await api('/api/npcs/' + encodeURIComponent(slug) + '/stage', { method: 'DELETE' });
    await loadNpcDetail(slug, name);
    flashSaved('stageSaved', '已清空在场');
  });

  $('#saveAliases').addEventListener('click', async () => {
    const names = $('#npcAliases')
      .value.split(/[\n,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
    try {
      await api('/api/npcs/' + encodeURIComponent(slug) + '/aliases', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names }),
      });
      flashSaved('aliasSaved', '别名已保存');
      loadNpcs();
    } catch (err) {
      $('#aliasSaved').textContent = '保存失败：' + String(err.message || err);
    }
  });

  // AI 修改记忆：生成草稿
  $('#memRewrite').addEventListener('click', async () => {
    const status = $('#memStatus');
    const prompt = $('#memEditPrompt').value.trim();
    if (!prompt) {
      status.textContent = '请先填写修改要求';
      return;
    }
    const btn = $('#memRewrite');
    btn.disabled = true;
    status.textContent = '生成中…（调用上游模型）';
    try {
      const r = await api('/api/npcs/' + encodeURIComponent(slug) + '/memory/rewrite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      draftState = { slug, prompt, text: r.draft };
      await loadNpcDetail(slug, name);
    } catch (err) {
      btn.disabled = false;
      status.textContent = '生成失败：' + String(err.message || err);
    }
  });

  if (hasDraft) {
    $('#memSave').addEventListener('click', async () => {
      const status = $('#memStatus');
      status.textContent = '保存中…';
      try {
        const r = await api('/api/npcs/' + encodeURIComponent(slug) + '/memory', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: $('#memDraft').value }),
        });
        draftState = null;
        await loadNpcDetail(slug, name);
        $('#memStatus').textContent = '✓ 已保存并覆盖' + (r.backup ? '（备份：' + r.backup + '）' : '');
      } catch (err) {
        status.textContent = '保存失败：' + String(err.message || err);
      }
    });
    $('#memCancel').addEventListener('click', () => {
      draftState = null;
      loadNpcDetail(slug, name);
    });
  }
}

// 初始化
renderCacheModes('none');
loadStatus().catch(() => setConn(false));
loadConfig().catch(() => {});
connectEvents();
