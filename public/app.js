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
  $('#memEnabled').checked = !!c.memory.enabled;
  $('#memSnapshot').checked = !!c.memory.snapshotSystem;
  $('#sumEnabled').checked = !!c.memory.summarizer.enabled;
  $('#memInjectChars').value = c.memory.injectMaxChars;
  $('#sumEvery').value = c.memory.summarizer.everyTurns;
  $('#sumMaxChars').value = c.memory.summarizer.maxMemoryChars;
  $('#styleEnabled').checked = !!c.style?.enabled;
  $('#styleGlobal').value = c.style?.global || '';
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

$('#saveStyle').addEventListener('click', async () => {
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      style: { enabled: $('#styleEnabled').checked, global: $('#styleGlobal').value },
    }),
  });
  flashSaved('styleSaved', '风格设置已保存');
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
          ${rec.styleChars ? `<span>风格提示 ${rec.styleChars} 字</span>` : ''}
          ${timing.map((x) => `<span>${x}</span>`).join('')}
          ${rec.warnings && rec.warnings.length ? `<span class="warn">⚠ ${esc(rec.warnings.join('；'))}</span>` : ''}
        </div>`;
    } else {
      body = `<div class="log-meta">${esc(rec.modelIn || '')} → ${esc(rec.modelOut || '')} ${timing.map((x) => `<span>${x}</span>`).join('')}</div>`;
    }
  } else if (rec.kind === 'summary') {
    body = `<div class="log-line">${esc(rec.slug || '')} 记忆压缩 ${rec.status === 'done' ? '完成' : '失败'}</div>
      <div class="log-meta">${rec.durationMs != null ? `<span>${rec.durationMs}ms</span>` : ''}${rec.memoryChars != null ? `<span>${rec.memoryChars} 字</span>` : ''}${rec.error ? `<span class="warn">${esc(rec.error)}</span>` : ''}</div>`;
  } else if (rec.kind === 'memory_edit') {
    const act = rec.action === 'save' ? '保存记忆' : 'AI 改写记忆';
    body = `<div class="log-line">${esc(rec.slug || '')} ${act} ${rec.status === 'done' ? '完成' : '失败'}</div>
      <div class="log-meta">${rec.durationMs != null ? `<span>${rec.durationMs}ms</span>` : ''}${rec.generatedChars != null ? `<span>生成 ${rec.generatedChars} 字</span>` : ''}${rec.memoryChars != null ? `<span>${rec.memoryChars} 字</span>` : ''}${rec.backup ? `<span>备份 ${esc(rec.backup)}</span>` : ''}${rec.error ? `<span class="warn">${esc(rec.error)}</span>` : ''}</div>`;
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
      <div class="name">${esc(name)}${n.variants.length ? n.variants.map((v) => `<span class="tag">~${esc(v)}</span>`).join('') : ''}${n.styleChars ? '<span class="tag">专属风格</span>' : ''}</div>
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
  const st = d.style || { useGlobal: true, text: '' };
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
    <h4>对话风格（本 NPC 专属，可结合上面的记忆来设定）</h4>
    <label class="check small"><input type="checkbox" id="npcStyleUseGlobal" ${st.useGlobal !== false ? 'checked' : ''} /> 叠加全局提示词（取消勾选则只用本 NPC 提示词）</label>
    <textarea id="npcStyleText" rows="4" placeholder="例如：性格更热情主动，会主动找话题寒暄；或更严肃寡言，只用短句……">${esc(st.text)}</textarea>
    <div class="act-row"><button class="btn primary sm" id="saveNpcStyle">保存本 NPC 风格</button><span class="saved-hint" id="npcStyleSaved"></span></div>
    <h4>最近对话（最新在上）</h4>
    ${convs || '<p class="hint">暂无对话。</p>'}`;
  $('#saveNpcStyle').addEventListener('click', async () => {
    await api('/api/npcs/' + encodeURIComponent(slug) + '/style', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        useGlobal: $('#npcStyleUseGlobal').checked,
        text: $('#npcStyleText').value,
      }),
    });
    flashSaved('npcStyleSaved', '已保存');
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
