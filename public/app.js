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

// —— 配置 ——
async function loadStatus() {
  const s = await api('/api/status');
  statusCache = s;
  $('#version').textContent = 'v' + s.version + (s.isTest ? ' · 测试档' : '');
  $('#baseUrl').value = s.baseUrl;
  $('#apiKey').value = s.apiKey;
  $('#servedModelView').value = s.servedModel;
  $('#dataDirView').value = s.dataDir || '';
  setConn(true);
}

async function loadConfig() {
  const c = await api('/api/config');
  $('#upBaseUrl').value = c.upstream.baseUrl || '';
  $('#upModel').value = c.upstream.model || '';
  $('#upApiKey').value = '';
  $('#upApiKey').placeholder = c.upstream.apiKeySet ? '已设置（' + c.upstream.apiKey + '），留空不修改' : '未设置，请填写';
  $('#upDisableThinking').checked = !!c.upstream.disableThinking;
  $('#upIncludeUsage').checked = !!c.upstream.includeUsage;
  $('#memEnabled').checked = !!c.memory.enabled;
  $('#memSnapshot').checked = !!c.memory.snapshotSystem;
  $('#sumEnabled').checked = !!c.memory.summarizer.enabled;
  $('#memInjectChars').value = c.memory.injectMaxChars;
  $('#sumEvery').value = c.memory.summarizer.everyTurns;
  $('#sumMaxChars').value = c.memory.summarizer.maxMemoryChars;
  $('#promptsEnabled').checked = !!c.prompts?.enabled;
  $('#promptsGlobal').value = c.prompts?.global || '';
  const rw = c.requestRewrite || {};
  $('#rwEnabled').checked = !!rw.enabled;
  $('#rwMaxTokens').value = rw.maxTokens ?? 6000;
  $('#rwTimeout').value = rw.timeoutMs ?? 60000;
  $('#rwTemperature').value = rw.temperature ?? 0.2;
}

$('#saveUpstream').addEventListener('click', async () => {
  const patch = {
    upstream: {
      baseUrl: $('#upBaseUrl').value.trim(),
      model: $('#upModel').value.trim(),
      disableThinking: $('#upDisableThinking').checked,
      includeUsage: $('#upIncludeUsage').checked,
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
      },
    }),
  });
  flashSaved('rwSaved', '重写设置已保存');
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
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.tab-pane').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('#tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'npcs') loadNpcs();
  }),
);

// —— 日志 ——
function kindOf(rec) {
  return rec.kind || 'server';
}
function kindBadge(rec) {
  const bad = rec.status === 'error' || rec.status === 'upstream_error';
  return `<span class="badge ${bad ? 'err' : kindOf(rec)}">${bad ? '错误' : esc(kindOf(rec))}</span>`;
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

function originLabel(origin) {
  return (
    {
      game: '游戏原始',
      game_rewritten: '游戏重写后',
      memory: '外置记忆',
      prompt: '外置提示词',
      style: '外置提示词',
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
  const error = d.error ? `<p class="detail-note warn">错误：${esc(d.error)}</p>` : '';

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

  const rw = d.rewrite;
  let rewriteBlock = '';
  if (rw) {
    const rwTok =
      rw.tokens && rw.tokens.total != null
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
              ? m.repaired
                ? m.changed
                  ? '已改写（格式已修复）'
                  : '格式已修复（内容未变）'
                : '已改写'
              : '未改动（' + esc(m.error || '校验失败') + '）'
          }</h6>
          <p class="detail-note">${m.originalChars ?? '—'} 字 → ${m.rewrittenChars ?? '—'} 字 · 删除 ${m.removedCount ?? 0} 行 / 新增 ${m.addedCount ?? 0} 行</p>
          ${m.removed && m.removed.length ? `<p class="detail-note">删除的原文行：</p><pre class="detail-pre">${esc(m.removed.join('\n'))}</pre>` : ''}
          ${m.added && m.added.length ? `<p class="detail-note">新增/改写后的行：</p><pre class="detail-pre">${esc(m.added.join('\n'))}</pre>` : ''}
          ${m.original != null ? `<details class="rw-details"><summary>原始内容（${String(m.original).length} 字）</summary><pre class="detail-pre">${esc(m.original)}</pre></details>` : ''}
          ${m.draft != null ? `<details class="rw-details"><summary>模型草稿（未采用，${String(m.draft).length} 字）</summary><pre class="detail-pre">${esc(m.draft)}</pre></details>` : ''}
          ${m.rewritten != null ? `<details class="rw-details"><summary>${m.status === 'done' ? '重写后内容' : '实际采用（已回退原文）'}（${String(m.rewritten).length} 字）</summary><pre class="detail-pre">${esc(m.rewritten)}</pre></details>` : ''}
        </div>`,
      )
      .join('');
    rewriteBlock = `
      <div class="detail-section">
        <h5>请求重写（实验性）· ${rwLabel}</h5>
        <p class="detail-note">耗时 ${rw.timing?.durationMs ?? '—'}ms · 额外 token ${rwTok} · 模块 ${rw.moduleCount ?? modules.length} 个，改写 ${rw.changedCount ?? changedModules.length} 个${rw.repairedCount ? `，修复格式 ${rw.repairedCount} 个` : ''}，失败 ${rw.failedCount ?? 0} 个 · 删除 ${rw.removedCount ?? 0} 行 / 新增 ${rw.addedCount ?? 0} 行${rw.error ? ` · 原因：${esc(rw.error)}` : ''}</p>
        ${moduleHtml || '<p class="detail-note">（没有发生改写的模块）</p>'}
        ${unchangedModules.length ? `<p class="detail-note">未改动模块：${unchangedModules.map((m) => esc(m.title || '')).join('、')}</p>` : ''}
        <details class="rw-details"><summary>重写调用 Prompt（${(rw.messages || []).length} 条消息）</summary>${rwMessages || '<p class="detail-note">（无）</p>'}</details>
      </div>`;
  }

  return `${tokenLine}${error}${rewriteBlock}
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
                  rec.rewrite.changedModules != null
                    ? ` 改写 ${rec.rewrite.changedModules}/${rec.rewrite.modules} 模块`
                    : ''
                }${rec.rewrite.durationMs != null ? ' ' + rec.rewrite.durationMs + 'ms' : ''}${
                  rec.rewriteTokens != null ? ' · ' + fmtTok(rec.rewriteTokens) + ' tok' : ''
                }</span>`
              : ''
          }
          ${tokenTag(rec)}
          ${timing.map((x) => `<span>${x}</span>`).join('')}
          ${rec.warnings && rec.warnings.length ? `<span class="warn">⚠ ${esc(rec.warnings.join('；'))}</span>` : ''}
        </div>`;
    } else {
      body = `<div class="log-meta">${esc(rec.modelIn || '')} → ${esc(rec.modelOut || '')} ${tokenTag(rec)} ${timing.map((x) => `<span>${x}</span>`).join('')}</div>`;
    }
  } else if (rec.kind === 'summary') {
    body = `<div class="log-line">${esc(rec.slug || '')} 记忆压缩 ${rec.status === 'done' ? '完成' : '失败'}</div>
      <div class="log-meta">${rec.durationMs != null ? `<span>${rec.durationMs}ms</span>` : ''}${rec.memoryChars != null ? `<span>${rec.memoryChars} 字</span>` : ''}${tokenTag(rec)}${rec.error ? `<span class="warn">${esc(rec.error)}</span>` : ''}</div>`;
  } else if (rec.kind === 'memory_edit') {
    const act = rec.action === 'save' ? '保存记忆' : 'AI 改写记忆';
    body = `<div class="log-line">${esc(rec.slug || '')} ${act} ${rec.status === 'done' ? '完成' : '失败'}</div>
      <div class="log-meta">${rec.durationMs != null ? `<span>${rec.durationMs}ms</span>` : ''}${rec.generatedChars != null ? `<span>生成 ${rec.generatedChars} 字</span>` : ''}${rec.memoryChars != null ? `<span>${rec.memoryChars} 字</span>` : ''}${tokenTag(rec)}${rec.backup ? `<span>备份 ${esc(rec.backup)}</span>` : ''}${rec.error ? `<span class="warn">${esc(rec.error)}</span>` : ''}</div>`;
  } else if (rec.kind === 'auth') {
    body = `<div class="log-line warn">鉴权失败：${esc(rec.path || '')} @ ${esc(rec.ip || '')}</div>`;
  } else {
    body = `<div class="log-line">${esc(rec.status || '')} ${esc(rec.error || rec.kind || '')}</div>`;
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
  if (currentKind === 'error-only') return rec.status === 'error' || rec.status === 'upstream_error' || (rec.warnings || []).length > 0;
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
      <div class="name">${esc(name)}${n.variants.length ? n.variants.map((v) => `<span class="tag">~${esc(v)}</span>`).join('') : ''}${n.promptChars ? '<span class="tag">个人提示词</span>' : ''}</div>
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
loadStatus().catch(() => setConn(false));
loadConfig().catch(() => {});
connectEvents();
