/* 管理页逻辑：配置读写、SSE 实时日志、NPC 记忆浏览。原生 JS，无依赖。 */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let statusCache = null;
let currentKind = 'all';
let logPausedAdd = false;

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
  $('#memEnabled').checked = !!c.memory.enabled;
  $('#memSnapshot').checked = !!c.memory.snapshotSystem;
  $('#sumEnabled').checked = !!c.memory.summarizer.enabled;
  $('#memInjectChars').value = c.memory.injectMaxChars;
  $('#sumEvery').value = c.memory.summarizer.everyTurns;
  $('#sumMaxChars').value = c.memory.summarizer.maxMemoryChars;
}

$('#saveUpstream').addEventListener('click', async () => {
  const patch = {
    upstream: {
      baseUrl: $('#upBaseUrl').value.trim(),
      model: $('#upModel').value.trim(),
      disableThinking: $('#upDisableThinking').checked,
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

function renderLog(rec) {
  const t = new Date(rec.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const div = document.createElement('div');
  div.className = 'log-item ' + kindOf(rec);
  div.dataset.status = rec.status || '';
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
          ${timing.map((x) => `<span>${x}</span>`).join('')}
          ${rec.warnings && rec.warnings.length ? `<span class="warn">⚠ ${esc(rec.warnings.join('；'))}</span>` : ''}
        </div>`;
    } else {
      body = `<div class="log-meta">${esc(rec.modelIn || '')} → ${esc(rec.modelOut || '')} ${timing.map((x) => `<span>${x}</span>`).join('')}</div>`;
    }
  } else if (rec.kind === 'summary') {
    body = `<div class="log-line">${esc(rec.slug || '')} 记忆压缩 ${rec.status === 'done' ? '完成' : '失败'}</div>
      <div class="log-meta">${rec.durationMs != null ? `<span>${rec.durationMs}ms</span>` : ''}${rec.memoryChars != null ? `<span>${rec.memoryChars} 字</span>` : ''}${rec.error ? `<span class="warn">${esc(rec.error)}</span>` : ''}</div>`;
  } else if (rec.kind === 'auth') {
    body = `<div class="log-line warn">鉴权失败：${esc(rec.path || '')} @ ${esc(rec.ip || '')}</div>`;
  } else {
    body = `<div class="log-line">${esc(rec.status || '')} ${esc(rec.error || rec.kind || '')}</div>`;
  }

  div.innerHTML = `<div class="log-head">${kindBadge(rec)}<span>${t}</span><span>#${rec.seq}</span></div><div class="log-body">${body}</div>`;
  return div;
}

function matchFilter(rec) {
  if (currentKind === 'all') return true;
  if (currentKind === 'error-only') return rec.status === 'error' || rec.status === 'upstream_error' || (rec.warnings || []).length > 0;
  return kindOf(rec) === currentKind;
}

function addLog(rec) {
  if (!matchFilter(rec)) return;
  const list = $('#logList');
  list.appendChild(renderLog(rec));
  while (list.children.length > 500) list.removeChild(list.firstChild);
  if ($('#autoScroll').checked) list.scrollTop = list.scrollHeight;
}

$$('#kindFilters .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    $$('#kindFilters .chip').forEach((x) => x.classList.remove('active'));
    chip.classList.add('active');
    currentKind = chip.dataset.kind;
    $('#logList').innerHTML = '';
    api('/api/logs?limit=300')
      .then((d) => d.records.filter(matchFilter).forEach((r) => addLog(r)))
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
      $('#logList').innerHTML = '';
      msg.records.filter(matchFilter).forEach((r) => addLog(r));
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
      <div class="name">${esc(name)}${n.variants.length ? n.variants.map((v) => `<span class="tag">~${esc(v)}</span>`).join('') : ''}</div>
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
  const convs = d.conversations
    .slice()
    .reverse()
    .map((c) => {
      const who = c.role === 'player' ? '玩家 Wind' : esc(name);
      const meta = [c.game_time, c.scene, c.emotion, c.control, c.reply_json_ok === false ? '⚠非JSON' : null].filter(Boolean).join(' · ');
      return `<div class="conv-item ${c.role}"><div class="meta">${esc(who)} · ${esc(meta)}</div><div>${esc(c.content)}</div></div>`;
    })
    .join('');
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
    <h4>最近对话（最新在上）</h4>
    ${convs || '<p class="hint">暂无对话。</p>'}`;
}

// 初始化
loadStatus().catch(() => setConn(false));
loadConfig().catch(() => {});
connectEvents();
