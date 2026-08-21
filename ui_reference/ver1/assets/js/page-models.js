/* ============================================================
   OMP Studio — 模型配置 · 「供应商」面板
   供应商列表 · 新建 / 编辑（预设模板 · 认证 · Endpoint · 模型 ·
   高级设置 · models.yml 实时预览 · 测试连接）

   这个文件曾是 providers.html 的整页脚本，自己监听 DOMContentLoaded
   并读取 location.hash。现在「供应商」与「角色」合并为一个页面
   (model-config.html)，所以本模块不再自启动，而是把自己注册成一个
   面板，由 page-model-config.js 决定何时挂载、切到哪个 tab、以及
   如何解析 hash —— 单一入口只能有一个路由器。
   ============================================================ */
(function () {
  const MR = window.OMP_MR;
  if (!MR) return;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const icon = OMP.icon;
  const toast = (t, i) => OMP.ui.toast(t, i);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- 页面状态 ---------------- */
  const S = {
    view: 'list',            // list | editor
    query: '',
    expanded: new Set(),
    flash: null,             // 列表页顶部提示（如：从角色页跳转）
    // editor
    editId: null,            // null = 新建
    draft: null,
    presetOpen: false,
    presetQuery: '',
    presetSel: null,         // 已应用的预设 id
    modelsTab: null,         // catalog | discovery | custom
    testResult: null,        // {ok, lines[]}
    testing: false,
    discoveryResult: null,   // {ok, found, usable, error}
    advancedOpen: false,
    sourceMode: false,
    yamlError: false,
    overrideFor: null,       // model id（Override 对话框）
    addingModel: false,
    errors: {}               // 校验错误 {field: msg}
  };

  /* ---------------- 构造草稿 ---------------- */
  function blankDraft() {
    return {
      name: '', id: '', website: '', note: '',
      auth: { type: 'api-key', key: '', save: true, envName: '', command: '', account: null },
      api: 'openai-responses',
      endpoint: { useDefault: true, url: '' },
      local: false, enabled: true,
      discovery: null,
      models: [],
      advanced: { authHeader: false, disableStrictTools: false, headers: '', compatibility: '', remoteCompaction: false, transport: 'http' }
    };
  }
  function draftFromPreset(p) {
    const d = blankDraft();
    d.name = p.name; d.id = p.id;
    d.auth.type = p.auth[0];
    if (d.auth.type === 'env') d.auth.envName = p.id.toUpperCase().replace(/-/g, '_') + '_API_KEY';
    d.api = p.api;
    d.local = !!p.local;
    if (p.endpoint) { d.endpoint.useDefault = true; d.endpoint.url = p.endpoint; }
    if (p.discovery) d.discovery = { enabled: true, type: p.discovery, timeout: 10, found: 0, usable: 0 };
    /* Mock：OMP Catalog 中该 Provider 已知模型（真实产品来自 Registry） */
    const saved = MR.provider(p.id);
    if (saved && saved.models.length) d.models = saved.models.map(x => Object.assign({}, x));
    return d;
  }
  function draftFromProvider(pv) {
    return {
      name: pv.name, id: pv.id, website: pv.website || '', note: pv.note || '',
      auth: Object.assign({ key: '', save: true, envName: '', command: '', account: null }, pv.auth),
      api: pv.api,
      endpoint: { useDefault: pv.endpoint.useDefault, url: pv.endpoint.url || '' },
      local: pv.local, enabled: pv.enabled,
      discovery: pv.discovery ? Object.assign({}, pv.discovery) : null,
      models: pv.models.map(x => Object.assign({}, x)),
      advanced: { authHeader: false, disableStrictTools: false, headers: '', compatibility: '', remoteCompaction: false, transport: 'http' },
      _source: pv.source, _status: pv.status
    };
  }

  function openEditor(editId, presetId) {
    S.view = 'editor';
    S.editId = editId;
    S.presetSel = presetId;
    S.presetOpen = false; S.presetQuery = '';
    S.testResult = null; S.testing = false; S.discoveryResult = null;
    S.advancedOpen = false; S.sourceMode = false; S.yamlError = false;
    S.overrideFor = null; S.addingModel = false; S.errors = {};
    S.draft = editId ? draftFromProvider(MR.provider(editId))
      : presetId ? draftFromPreset(MR.preset(presetId))
      : blankDraft();
    /* 默认模型 Tab：有 discovery → discovery；custom 来源 → custom；否则 catalog */
    S.modelsTab = S.draft.discovery ? 'discovery'
      : (!editId && !presetId) || (S.draft._source === 'custom' && !S.draft.discovery) ? 'custom'
      : 'catalog';
    render();
    $('.page-body').scrollTop = 0;
  }

  /* ---------------- 状态 / 来源 chip ---------------- */
  function statusChip(st) {
    const m = MR.STATUS[st];
    return `<span class="chip ${m.chip}">${m.dot ? `<span class="dot ${m.dot}"></span>` : ''}${m.label}</span>`;
  }
  function srcChip(src) { return `<span class="chip gray xs">${MR.SOURCE[src].label}</span>`; }
  function authLabel(a) {
    return { oauth: 'OMP Login', 'api-key': 'API Key', env: 'Env Var', command: 'External Command', none: '无需认证' }[a.type] || a.type;
  }
  function apiLabel(id) { const t = MR.API_TYPES.find(x => x.id === id); return t ? t.label : id; }

  /* ---------------- 供应商列表 ---------------- */
  function listHtml() {
    const q = S.query.toLowerCase();
    const rows = MR.providers.filter(pv =>
      !q || pv.name.toLowerCase().includes(q) || pv.id.toLowerCase().includes(q));
    const avail = MR.providers.filter(p => p.status === 'available' && p.enabled).length;

    return `
    ${S.flash ? `<div class="preset-banner">${icon('info', 'sm')}<span>${esc(S.flash)}</span>
      <span class="spacer"></span><button class="icon-btn small" data-act="dismiss-flash">${icon('x', 'sm')}</button></div>` : ''}
    <div class="mr-toolbar">
      <input class="input" id="mpSearch" placeholder="搜索供应商名称或 Provider ID…" value="${esc(S.query)}">
      <span class="mr-count">${MR.providers.length} 个供应商 · ${avail} 个可用</span>
      <span class="spacer"></span>
      <button class="btn outline" data-act="reload">${icon('refresh', 'sm')}刷新状态</button>
      <button class="btn primary" data-act="new">${icon('plus', 'sm')}添加供应商</button>
    </div>
    ${rows.map(pvCardHtml).join('') || `<div class="empty">${icon('search')}没有匹配的供应商</div>`}`;
  }

  function pvCardHtml(pv) {
    const open = S.expanded.has(pv.id);
    const st = MR.STATUS[pv.status];
    const modelCount = pv.models.length;
    const cardCls = pv.status === 'disabled' ? 'is-disabled'
      : ['config-error', 'connection-failed', 'offline'].includes(pv.status) ? 'is-error'
      : ['not-authenticated', 'auth-expired'].includes(pv.status) ? 'is-warn' : '';

    /* 头标：已知品牌用真实 Logo(浅灰底片),自定义供应商回退到状态色图标 */
    const brand = OMP.brand(pv.id);
    const headIcon = brand
      ? `<span class="pv-brand">${brand}</span>`
      : `<span class="pv-fallback a-ic ${pv.status === 'available' ? 'green' : pv.status === 'disabled' ? 'purple' : 'amber'}" aria-hidden="true">${icon(pv.local ? 'monitor' : 'server', 'lg')}</span>`;

    /* 第二行展示 API 地址；模型数与状态点并入第一行（点 → N 个模型） */
    const url = pv.endpoint.url || pv.website;

    return `
    <div class="pv-card ${cardCls}" data-id="${pv.id}">
      <div class="pv-head">
        ${headIcon}
        <div class="pv-title">
          <div class="pv-name">
            <span>${esc(pv.name)}</span>
            <span class="chip-code">${esc(pv.id)}</span>
            <span class="pv-count" data-tip="${esc(st.label)}"><span class="pv-dot dot ${st.dot || 'gray'}"></span>${modelCount} 个模型</span>
          </div>
          ${url ? `<div class="pv-sub"><span class="pv-url ellipsis">${esc(url)}</span></div>` : ''}
        </div>
        <div class="pv-acts">
          <button class="pv-act is-action" type="button" data-act="test" data-id="${pv.id}" data-tip="测试连接" aria-label="测试连接 ${esc(pv.name)}">${icon('pulse')}</button>
          <button class="pv-act is-action" type="button" data-act="rescan" data-id="${pv.id}" data-tip="刷新模型" aria-label="刷新 ${esc(pv.name)} 的模型">${icon('refresh')}</button>
          <button class="pv-act is-action is-edit" type="button" data-act="edit" data-id="${pv.id}" data-tip="编辑" aria-label="编辑 ${esc(pv.name)}">${icon('pencil')}</button>
          <button class="pv-act is-action is-copy" type="button" data-act="copy-id" data-id="${pv.id}" data-tip="复制供应商" aria-label="复制供应商 ${esc(pv.id)}">${icon('copy')}</button>
          <span class="pv-act is-switch" data-act="toggle-enable" data-id="${pv.id}" data-tip="启用 / 禁用" role="button" tabindex="0" aria-label="启用 ${esc(pv.name)}">
            <button type="button" class="switch${pv.enabled ? ' on' : ''}" role="switch"
              aria-checked="${pv.enabled}" tabindex="-1" style="pointer-events:none"></button>
          </span>
          <button class="pv-act is-expand" type="button" data-act="expand" data-id="${pv.id}"
            data-tip="${open ? '收起模型列表' : '展开模型列表'}" aria-expanded="${open}" aria-label="${open ? '收起' : '展开'}模型列表">
            <span style="display:inline-flex;transform:rotate(${open ? 90 : 0}deg);transition:transform var(--dur-fast) var(--ease)">${icon('chevron-r')}</span></button>
        </div>
      </div>
      ${open ? `<div class="pv-models">${pvModelsHtml(pv)}</div>` : ''}
    </div>`;
  }

  function pvModelsHtml(pv) {
    if (!pv.models.length)
      return `<div class="pm-empty">${icon('box', 'sm')}暂无模型 — ${pv.discovery ? '尚未发现模型，试试「重新扫描」' : '可在编辑页添加自定义模型'}</div>`;
    return pv.models.map(md => {
      const sel = `${pv.id}/${md.id}`;
      const off = md.status !== 'available';
      return `
      <div class="pm-row${off ? ' is-off' : ''}">
        <span class="pm-name"><span class="dot ${md.status === 'available' ? 'green' : md.status === 'disabled' ? '' : 'amber'}" style="${md.status === 'disabled' ? 'background:var(--glyph-faint)' : ''}"></span>${esc(md.name)}</span>
        <span class="pm-sel ellipsis">${esc(sel)}</span>
        <span class="pm-meta">
          <span class="chip gray xs">${MR.fmtK(md.ctx)} ctx</span>
          ${md.img ? `<span class="chip blue xs" data-tip="支持图片输入">${icon('image', 'sm')}图</span>` : ''}
          ${md.reason ? '<span class="chip purple xs">Reasoning</span>' : ''}
          ${md.tools ? '<span class="chip gray xs">Tools</span>' : ''}
          ${md.cIn ? `<span class="chip gray xs">$${md.cIn}/$${md.cOut}</span>` : ''}
          <span class="chip outline xs">${{ catalog: 'Catalog', discovery: 'Discovery', custom: 'Custom', extension: 'Extension' }[md.src]}</span>
          ${md.status === 'disabled' ? '<span class="chip gray xs">已禁用</span>' : ''}
          ${md.status === 'unavailable' ? '<span class="chip amber xs">不可用</span>' : ''}
        </span>
        <button class="icon-btn small" data-act="copy-sel" data-sel="${esc(sel)}" data-tip="复制 Model Selector">${icon('copy', 'sm')}</button>
        ${md.src === 'catalog' ? `<button class="icon-btn small" data-act="override" data-id="${pv.id}" data-mid="${esc(md.id)}" data-tip="编辑 Override">${icon('pencil', 'sm')}</button>` : ''}
        <a class="icon-btn small" href="#assign=${encodeURIComponent(sel)}" data-tip="分配给角色">${icon('user', 'sm')}</a>
      </div>`;
    }).join('');
  }

  /* ---------------- 编辑器 ---------------- */
  function editorHtml() {
    const d = S.draft;
    const isNew = !S.editId;
    return `
    <div class="mr-toolbar">
      <button class="icon-btn" data-act="back" data-tip="返回供应商列表">${icon('arrow-l')}</button>
      <b style="font-size:var(--fs-14)">${isNew ? '新建供应商' : '编辑 · ' + esc(d.name)}</b>
      ${isNew ? '<span class="chip purple xs">自定义供应商</span>' : srcChip(d._source || 'custom')}
      ${S.presetSel ? `<span class="chip blue xs">预设模板：${esc(MR.preset(S.presetSel).name)}</span>` : ''}
    </div>

    ${isNew ? presetEntryHtml() : ''}
    ${S.presetSel ? `<div class="preset-banner">${icon('check', 'sm')}<span>已应用 <b>${esc(MR.preset(S.presetSel).name)}</b> 预设 — 字段已预填写，可继续修改。预设只是创建模板，保存后才成为「已配置供应商」。</span>
      <span class="spacer"></span><button class="btn small outline" data-act="preset-clear">清除预设</button></div>` : ''}

    <div class="mp-sec">
      <h3>基础信息</h3>
      <div class="f-grid">
        <div class="field">
          <label for="f-name">供应商名称</label>
          <input class="input" id="f-name" data-f="name" value="${esc(d.name)}" placeholder="给人看的名字，如 Company Gateway">
        </div>
        <div class="field">
          <label for="f-id">Provider ID</label>
          <input class="input mono" id="f-id" data-f="id" value="${esc(d.id)}" placeholder="如 company-gateway" ${S.editId ? 'readonly' : ''}>
          <span class="desc">OMP 实际使用的标识 — Model Selector 形如 <span class="chip-code">${esc(d.id || 'provider-id')}/model-id</span></span>
          ${S.errors.id ? `<span class="error">${icon('alert-c', 'sm')}${esc(S.errors.id)}</span>` : ''}
        </div>
        <div class="field">
          <label for="f-site">官网链接 <span class="muted">（可选）</span></label>
          <input class="input mono" id="f-site" data-f="website" value="${esc(d.website)}" placeholder="https://…">
        </div>
        <div class="field">
          <label for="f-note">备注 <span class="muted">（可选）</span></label>
          <input class="input" id="f-note" data-f="note" value="${esc(d.note)}" placeholder="OMP Studio 元数据，不写入 models.yml">
        </div>
      </div>
    </div>

    ${authSecHtml()}
    ${endpointSecHtml()}

    <div class="mp-sec">
      <h3>API 类型</h3>
      <p class="sec-desc">预设 Provider 会自动填写，通常无需修改；自定义网关按服务端实现选择。</p>
      <select class="select" data-f="api" style="max-width:320px">
        ${MR.API_TYPES.map(t => `<option value="${t.id}"${d.api === t.id ? ' selected' : ''}>${t.label}</option>`).join('')}
      </select>
    </div>

    ${modelsSecHtml()}
    ${advancedHtml()}
    ${ymlCardHtml()}

    ${S.testResult ? `<div class="test-result ${S.testResult.ok ? 'ok' : 'fail'}">
      ${icon(S.testResult.ok ? 'check' : 'x', 'sm')}
      <div class="tr-lines">${S.testResult.lines.map((l, i) => i === 0 ? `<b>${esc(l)}</b>` : `<span class="mono">${esc(l)}</span>`).join('')}</div>
    </div>` : ''}

    <div class="mp-foot">
      <button class="btn outline" data-act="back">取消</button>
      <span class="right">
        <button class="btn outline" data-act="test-draft">${S.testing ? '<span class="spinner"></span>测试中…' : icon('pulse', 'sm') + '测试连接'}</button>
        <button class="btn primary" data-act="save">${icon('check', 'sm')}${isNew ? '添加供应商' : '保存修改'}</button>
      </span>
    </div>`;
  }

  /* ---------- 预设模板入口 ---------- */
  function presetEntryHtml() {
    if (!S.presetOpen) {
      return `
      <div class="preset-entry">
        <button class="preset-toggle" data-act="preset-toggle" aria-expanded="false">
          <span class="tw">${icon('chevron-r')}</span>
          ${icon('layers', 'sm')}
          <b>从预设模板创建</b>
          <span class="hint">OMP 内置供应商 — 选择后自动预填写配置</span>
          <span class="spacer"></span>
          <span class="chip gray xs">${MR.PRESET_GROUPS.reduce((n, g) => n + g.items.length, 0)} 个预设</span>
        </button>
      </div>`;
    }
    const q = S.presetQuery.toLowerCase();
    return `
    <div class="preset-entry open">
      <button class="preset-toggle" data-act="preset-toggle" aria-expanded="true">
        <span class="tw">${icon('chevron-r')}</span>
        ${icon('layers', 'sm')}
        <b>从预设模板创建</b>
        <span class="hint">选择预设不会直接保存，只是预填写下面的表单</span>
      </button>
      <div class="preset-body">
        <input class="input preset-search" id="presetSearch" placeholder="搜索预设 Provider…" value="${esc(S.presetQuery)}">
        ${MR.PRESET_GROUPS.map(g => {
          const items = g.items.filter(i => !q || i.name.toLowerCase().includes(q) || i.id.includes(q));
          if (!items.length) return '';
          return `<div class="preset-group-label">${esc(g.group)} · ${items.length}</div>
          <div class="preset-grid">${items.map(i => `
            <button class="preset-item${S.presetSel === i.id ? ' sel' : ''}" data-act="preset-pick" data-pid="${i.id}">
              <span class="pi-name">${esc(i.name)}
                ${i.popular ? '<span class="chip purple xs">常用</span>' : ''}
                ${i.local ? '<span class="chip blue xs">本地</span>' : ''}</span>
              <span class="pi-desc">${esc(i.desc)}</span>
              <span class="pi-desc">${i.auth.map(a => ({ oauth: 'OMP Login', 'api-key': 'API Key', env: 'Env Var', command: 'Command', none: '无认证' }[a])).join(' · ')}</span>
            </button>`).join('')}</div>`;
        }).join('')}
      </div>
    </div>`;
  }

  /* ---------- 认证区块 ---------- */
  function authSecHtml() {
    const d = S.draft;
    const a = d.auth;
    let body = '';
    if (a.type === 'oauth') {
      const st = a.account ? 'ok' : (S.oauthExpired ? 'expired' : 'out');
      body = `<div class="auth-box">
        <div class="auth-status">
          ${a.account
            ? `${icon('check', 'sm')}<span>已登录 <b>${esc(a.account)}</b>（${esc(d.name || 'Provider')}）</span><span class="chip green xs">凭据有效</span>`
            : S.oauthExpired
              ? `${icon('alert', 'sm')}<span>凭据已过期 — 需要重新认证</span><span class="chip amber xs">Expired</span>`
              : `${icon('info', 'sm')}<span>尚未登录 — 使用 OMP 账号完成 OAuth 授权</span><span class="chip gray xs">未登录</span>`}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn small ${a.account ? 'outline' : 'primary'}" data-act="oauth-login">${icon('key', 'sm')}${a.account ? '重新认证' : '登录'}</button>
          ${a.account ? `<button class="btn small outline" data-act="oauth-logout">退出登录</button>` : ''}
        </div>
      </div>`;
    } else if (a.type === 'api-key') {
      body = `<div class="auth-box">
        <div class="field">
          <label for="f-key">API Key</label>
          <input class="input mono" id="f-key" type="password" data-fa="key" value="${esc(a.key)}" placeholder="sk-…">
          <span class="desc">${a.key ? '当前存在已保存凭据' : '尚未配置凭据'} · <button class="btn small outline" data-act="key-toggle-save" style="height:20px">${a.save ? '✓ 保存到配置' : '仅本次会话使用'}</button></span>
        </div>
      </div>`;
    } else if (a.type === 'env') {
      body = `<div class="auth-box">
        <div class="field">
          <label for="f-env">Environment Variable Name</label>
          <input class="input mono" id="f-env" data-fa="envName" value="${esc(a.envName)}" placeholder="如 OPENAI_API_KEY / ANTHROPIC_API_KEY">
          <span class="desc">${a.envName
            ? (S.envMissing ? `<span style="color:var(--amber)">未在环境中检测到 ${esc(a.envName)}</span>` : `<span style="color:var(--green)">已在环境中检测到 ${esc(a.envName)}</span>`)
            : 'OMP 启动时从环境变量读取，不写入配置文件'}</span>
        </div>
      </div>`;
    } else if (a.type === 'command') {
      body = `<div class="auth-box">
        <div class="field">
          <label for="f-cmd">获取 Secret 的命令</label>
          <input class="input mono" id="f-cmd" data-fa="command" value="${esc(a.command)}" placeholder="!op read op://dev/openai/api-key">
          <span class="desc">OMP 通过执行该命令获取凭据（1Password CLI、pass 等），Secret 不落盘</span>
        </div>
      </div>`;
    } else {
      body = `<div class="auth-box">
        <div class="auth-status" style="margin-bottom:0">${icon('check', 'sm')}<span>无需认证 — 适用于 Ollama、LM Studio、llama.cpp 等本地服务</span></div>
      </div>`;
    }
    return `<div class="mp-sec">
      <h3>认证</h3>
      <div class="seg" role="tablist" aria-label="认证方式">
        ${MR.AUTH_TYPES.map(t => `<button data-act="auth-type" data-v="${t.id}" class="${a.type === t.id ? 'active' : ''}" role="tab" aria-selected="${a.type === t.id}">${t.label}</button>`).join('')}
      </div>
      ${body}
    </div>`;
  }

  /* ---------- Endpoint 区块 ---------- */
  function endpointSecHtml() {
    const d = S.draft;
    return `<div class="mp-sec">
      <h3>请求地址</h3>
      <div class="kv-list">
        <div class="kv-row">
          <span class="k">使用 OMP 默认 Endpoint</span>
          <span class="v">
            <button type="button" class="switch${d.endpoint.useDefault ? ' on' : ''}" role="switch" aria-checked="${d.endpoint.useDefault}" aria-label="使用 OMP 默认 Endpoint" data-act="endpoint-toggle"></button>
            ${d.endpoint.useDefault && d.endpoint.url ? `<span class="mono small muted">${esc(d.endpoint.url)}</span>` : ''}
            ${d.endpoint.useDefault && !d.endpoint.url ? `<span class="small muted">${d.local ? 'OMP 默认本地地址' : 'OMP 内置官方地址'}</span>` : ''}
          </span>
        </div>
        ${d.endpoint.useDefault ? '' : `
        <div class="kv-row">
          <span class="k">Base URL</span>
          <span class="v" style="flex-direction:column;align-items:stretch;gap:4px">
            <input class="input mono" data-fe="url" value="${esc(d.endpoint.url)}" placeholder="https://api.example.com/v1">
            <span class="small muted">适用于 API 中转 / 公司 Gateway / NewAPI / OneAPI / LiteLLM / 私有部署 / 本地 OpenAI 兼容服务</span>
            ${S.errors.baseUrl ? `<span class="error" style="font-size:var(--fs-11);color:var(--red)">${esc(S.errors.baseUrl)}</span>` : ''}
          </span>
        </div>`}
      </div>
    </div>`;
  }

  /* ---------- 模型区块 ---------- */
  function modelsSecHtml() {
    const d = S.draft;
    const tabs = [];
    if (!d.discovery || true) tabs.push(['catalog', 'OMP Catalog']);
    if (d.discovery) tabs.push(['discovery', 'Runtime Discovery']);
    tabs.push(['custom', 'Custom Models']);
    const tab = S.modelsTab;

    let body = '';
    if (tab === 'catalog') {
      const cat = d.models.filter(x => x.src === 'catalog' || x.src === 'extension');
      body = cat.length ? cat.map(md => `
        <div class="pm-row${md.status !== 'available' ? ' is-off' : ''}">
          <span class="pm-name">${esc(md.name)}</span>
          <span class="pm-sel ellipsis">${esc((d.id || 'provider') + '/' + md.id)}</span>
          <span class="pm-meta">
            <span class="chip gray xs">${MR.fmtK(md.ctx)} ctx</span>
            ${md.img ? '<span class="chip blue xs">图</span>' : ''}
            ${md.reason ? '<span class="chip purple xs">Reasoning</span>' : ''}
            ${md.tools ? '<span class="chip gray xs">Tools</span>' : ''}
            ${md.status === 'disabled' ? '<span class="chip gray xs">已禁用</span>' : ''}
          </span>
          <button type="button" class="switch${md.status === 'available' ? ' on' : ''}" role="switch"
            aria-checked="${md.status === 'available'}" aria-label="启用模型 ${esc(md.id)}" data-act="model-toggle" data-mid="${esc(md.id)}"></button>
          <button class="icon-btn small" data-act="override-draft" data-mid="${esc(md.id)}" data-tip="编辑 Override">${icon('pencil', 'sm')}</button>
          <a class="icon-btn small" href="#assign=${encodeURIComponent((d.id || 'provider') + '/' + md.id)}" data-tip="分配给角色">${icon('user', 'sm')}</a>
        </div>`).join('')
        : `<div class="pm-empty">${icon('box', 'sm')}该 Provider 暂无 OMP Catalog 模型</div>`;
    } else if (tab === 'discovery') {
      const ds = d.discovery;
      body = `
      <div class="kv-list">
        <div class="kv-row"><span class="k">启用自动发现</span><span class="v">
          <button type="button" class="switch${ds.enabled ? ' on' : ''}" role="switch" aria-checked="${ds.enabled}" aria-label="启用自动发现" data-act="discovery-toggle"></button></span></div>
        <div class="kv-row"><span class="k">Discovery Type</span><span class="v">
          <select class="select" data-fd="type" style="width:220px">${MR.DISCOVERY_TYPES.map(t => `<option${ds.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select></span></div>
        <div class="kv-row"><span class="k">Discovery Timeout（秒）</span><span class="v">
          <input class="input mono" data-fd="timeout" type="number" min="1" max="120" value="${ds.timeout}" style="width:120px"></span></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn small outline" data-act="discovery-test">${icon('pulse', 'sm')}测试 Discovery</button>
        <button class="btn small outline" data-act="discovery-rescan">${icon('refresh', 'sm')}重新扫描</button>
      </div>
      ${S.discoveryResult ? (S.discoveryResult.ok ? `
        <div class="test-result ok">${icon('check', 'sm')}<div class="tr-lines">
          <b>Discovery 成功</b>
          <span>发现 ${S.discoveryResult.found} 个模型 · ${S.discoveryResult.usable} 个可用</span>
          <span class="mono">${esc(ds.type)} · ${esc(d.endpoint.url || '默认地址')} · 耗时 0.8s</span>
        </div></div>` : `
        <div class="test-result fail">${icon('x', 'sm')}<div class="tr-lines">
          <b>Discovery Failed</b>
          <span>${esc(S.discoveryResult.error || '连接超时 — 服务未响应')}</span>
          <span class="mono">timeout ${ds.timeout}s · ${esc(d.endpoint.url || '默认地址')}</span>
        </div></div>`) : ''}
      ${d.models.filter(x => x.src === 'discovery').length ? `<div style="margin-top:10px">${d.models.filter(x => x.src === 'discovery').map(md => `
        <div class="pm-row"><span class="pm-name">${esc(md.name)}</span>
          <span class="pm-sel ellipsis">${esc((d.id || 'provider') + '/' + md.id)}</span>
          <span class="pm-meta"><span class="chip gray xs">${MR.fmtK(md.ctx)} ctx</span>${md.reason ? '<span class="chip purple xs">Reasoning</span>' : ''}</span>
        </div>`).join('')}</div>` : ''}`;
    } else {
      const customs = d.models.filter(x => x.src === 'custom');
      body = `
      ${customs.map((md, i) => `
        <div class="mdl-edit">
          <div class="me-head"><span class="mono">${esc(md.id)}</span>
            <span class="muted small">${esc(md.name)}</span>
            <span class="spacer"></span>
            <button class="icon-btn small" data-act="cmodel-copy" data-i="${i}" data-tip="复制模型">${icon('copy', 'sm')}</button>
            <button class="icon-btn small" data-act="cmodel-del" data-i="${i}" data-tip="删除模型">${icon('trash', 'sm')}</button>
          </div>
          <div class="pm-meta">
            <span class="chip gray xs">${MR.fmtK(md.ctx)} ctx</span>
            <span class="chip gray xs">${MR.fmtK(md.maxOut)} out</span>
            ${md.img ? '<span class="chip blue xs">图</span>' : ''}
            ${md.reason ? '<span class="chip purple xs">Reasoning</span>' : ''}
            ${md.cIn ? `<span class="chip gray xs">$${md.cIn}/$${md.cOut}</span>` : '<span class="chip gray xs">未设成本</span>'}
          </div>
        </div>`).join('')}
      ${S.addingModel ? addModelFormHtml() : `
        <button class="btn outline" data-act="cmodel-add">${icon('plus', 'sm')}添加模型</button>`}`;
    }

    return `<div class="mp-sec">
      <h3>模型</h3>
      <p class="sec-desc">该 Provider 下的模型 — 角色与工作台按 <span class="chip-code">${esc(d.id || 'provider-id')}/model-id</span> 引用。</p>
      <div class="seg" role="tablist" aria-label="模型来源" style="margin-bottom:10px">
        ${tabs.map(t => `<button data-act="models-tab" data-v="${t[0]}" class="${tab === t[0] ? 'active' : ''}" role="tab" aria-selected="${tab === t[0]}">${t[1]}</button>`).join('')}
      </div>
      ${body}
    </div>`;
  }

  function addModelFormHtml() {
    const nm = S.newModel || (S.newModel = {
      id: '', name: '', api: 'inherit', ctx: 128000, maxOut: 16384,
      reason: false, thinking: false, tools: true, img: false,
      cIn: '', cOut: '', cCacheR: '', cCacheW: ''
    });
    return `<div class="mdl-edit" style="background:var(--surface)">
      <div class="me-head">${icon('plus', 'sm')}添加自定义模型</div>
      <div class="f-grid">
        <div class="field"><label>Model ID</label>
          <input class="input mono" data-fn="id" value="${esc(nm.id)}" placeholder="如 gpt-example">
          ${S.errors.modelId ? `<span class="error">${icon('alert-c', 'sm')}${esc(S.errors.modelId)}</span>` : ''}</div>
        <div class="field"><label>显示名称</label>
          <input class="input" data-fn="name" value="${esc(nm.name)}" placeholder="如 GPT Example"></div>
        <div class="field"><label>API Type</label>
          <select class="select" data-fn="api"><option value="inherit">Inherit Provider（跟随供应商）</option>
            ${MR.API_TYPES.map(t => `<option value="${t.id}"${nm.api === t.id ? ' selected' : ''}>${t.label}</option>`).join('')}</select></div>
        <div class="field"><label>&nbsp;</label>
          <div style="display:flex;gap:12px;align-items:center;height:32px;flex-wrap:wrap">
            <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-fnc="reason"${nm.reason ? ' checked' : ''}> Reasoning</label>
            <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-fnc="thinking"${nm.thinking ? ' checked' : ''}> Thinking</label>
            <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-fnc="tools"${nm.tools ? ' checked' : ''}> Tools</label>
            <label class="small" style="display:flex;gap:4px;align-items:center"><input type="checkbox" data-fnc="img"${nm.img ? ' checked' : ''}> Image Input</label>
          </div></div>
        <div class="field"><label>Context Window</label><input class="input mono" type="number" data-fn="ctx" value="${nm.ctx}"></div>
        <div class="field"><label>Max Output Tokens</label><input class="input mono" type="number" data-fn="maxOut" value="${nm.maxOut}"></div>
      </div>
      <div class="field" style="margin-top:10px"><label>Cost（$/M tokens，留空表示未知）</label>
        <div class="cost-grid">
          <input class="input mono" data-fn="cIn" value="${esc(nm.cIn)}" placeholder="Input">
          <input class="input mono" data-fn="cOut" value="${esc(nm.cOut)}" placeholder="Output">
          <input class="input mono" data-fn="cCacheR" value="${esc(nm.cCacheR)}" placeholder="Cache Read">
          <input class="input mono" data-fn="cCacheW" value="${esc(nm.cCacheW)}" placeholder="Cache Write">
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn small primary" data-act="cmodel-save">保存模型</button>
        <button class="btn small outline" data-act="cmodel-cancel">取消</button>
      </div>
    </div>`;
  }

  /* ---------- 高级设置 ---------- */
  function advancedHtml() {
    const d = S.draft, adv = d.advanced;
    return `<details class="mp-advanced"${S.advancedOpen ? ' open' : ''}>
      <summary data-act="adv-summary">${icon('chevron-r', 'sm')}<span class="tw"></span>高级设置
        <span class="hint">Custom Headers · Auth Header · Discovery · Transport · Model Overrides · Compatibility · Remote Compaction</span></summary>
      <div class="adv-body">
        <div class="f-grid">
          <div class="field span2"><label>Custom Headers（每行一个 Header: Value）</label>
            <textarea class="input mono" data-fadv="headers" placeholder="X-Org-Id: org-123">${esc(adv.headers)}</textarea></div>
          <div class="kv-row" style="border:none;padding:4px 0"><span class="k">Auth Header</span><span class="v">
            <button type="button" class="switch${adv.authHeader ? ' on' : ''}" role="switch" aria-checked="${adv.authHeader}" aria-label="Auth Header" data-act="adv-toggle" data-k="authHeader"></button>
            <span class="small muted">以 HTTP Header 形式发送凭据</span></span></div>
          <div class="kv-row" style="border:none;padding:4px 0"><span class="k">Disable Strict Tools</span><span class="v">
            <button type="button" class="switch${adv.disableStrictTools ? ' on' : ''}" role="switch" aria-checked="${adv.disableStrictTools}" aria-label="Disable Strict Tools" data-act="adv-toggle" data-k="disableStrictTools"></button>
            <span class="small muted">放宽工具调用 Schema 校验</span></span></div>
          <div class="field"><label>Transport</label>
            <select class="select" data-fadv="transport"><option value="http">HTTP / SSE</option><option value="ws">WebSocket</option></select></div>
          <div class="field"><label>Compatibility</label>
            <select class="select" data-fadv="compatibility"><option value="">默认</option><option value="openai-legacy">openai-legacy</option><option value="no-stream">no-stream</option></select></div>
          <div class="kv-row" style="border:none;padding:4px 0"><span class="k">Remote Compaction</span><span class="v">
            <button type="button" class="switch${adv.remoteCompaction ? ' on' : ''}" role="switch" aria-checked="${adv.remoteCompaction}" aria-label="Remote Compaction" data-act="adv-toggle" data-k="remoteCompaction"></button>
            <span class="small muted">由 Provider 端执行上下文压缩</span></span></div>
          <div class="kv-row" style="border:none;padding:4px 0"><span class="k">Model Overrides</span><span class="v">
            <span class="small muted">对 OMP 内置模型逐项覆盖 — 在模型行上点 ${icon('pencil', 'sm')} 编辑</span></span></div>
        </div>
      </div>
    </details>`;
  }

  /* ---------- YAML 预览 ---------- */
  function ymlText() { return MR.modelsYml(S.draft); }
  function ymlCardHtml() {
    return `<div class="yml-card">
      <div class="yml-head">
        ${icon('file-code', 'sm')}配置预览
        <span class="yml-path">~/.omp/agent/models.yml</span>
        <span class="chip green xs"><span class="dot green pulse"></span>实时</span>
        <span class="spacer"></span>
        <button class="btn small outline" data-act="yml-copy">${icon('copy', 'sm')}复制</button>
        <button class="btn small outline" data-act="yml-format">格式化</button>
        <button class="btn small outline" data-act="yml-open">${icon('external', 'sm')}打开配置文件</button>
        <button class="btn small ${S.sourceMode ? 'primary' : 'outline'}" data-act="yml-source">${icon('file-code', 'sm')}高级模式</button>
      </div>
      ${S.sourceMode
        ? `<textarea class="yml-body edit" id="ymlEdit" spellcheck="false">${esc(S.yamlText != null ? S.yamlText : ymlText())}</textarea>`
        : `<pre class="yml-body" id="ymlBody">${esc(ymlText())}</pre>`}
      ${S.yamlError ? `<div class="yml-error">${icon('alert-c', 'sm')}Schema Invalid · 第 12 行：<span class="mono">contextWindow</span> 必须是正整数（当前为 "abc"）— 修复后才能保存</div>` : ''}
    </div>`;
  }

  function refreshYml() {
    if (S.sourceMode) return;
    const el = $('#ymlBody');
    if (el) el.textContent = ymlText();
  }

  /* ---------- Override 对话框 ---------- */
  function overrideDialogHtml(mid) {
    return `<div class="modal-backdrop" data-act-backdrop="override-close">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Model Override" style="width:560px">
        <div class="modal-head">Model Override · <span class="mono">${esc(mid)}</span></div>
        <div class="modal-body">
          <p class="small muted" style="margin-bottom:10px">只覆盖需要修改的字段，其余继承 OMP Catalog。属于高级能力，留空即不覆盖。</p>
          <div class="f-grid">
            <div class="field"><label>Name</label><input class="input" placeholder="继承"></div>
            <div class="field"><label>Context Window</label><input class="input mono" type="number" placeholder="200000"></div>
            <div class="field"><label>Max Tokens</label><input class="input mono" type="number" placeholder="64000"></div>
            <div class="field"><label>Compatibility</label><select class="select"><option>默认</option><option>openai-legacy</option></select></div>
            <div class="kv-row" style="border:none;padding:2px 0"><span class="k">Reasoning</span><span class="v"><button type="button" class="switch on" role="switch" aria-checked="true" aria-label="Reasoning"></button></span></div>
            <div class="kv-row" style="border:none;padding:2px 0"><span class="k">Thinking</span><span class="v"><button type="button" class="switch on" role="switch" aria-checked="true" aria-label="Thinking"></button></span></div>
            <div class="kv-row" style="border:none;padding:2px 0"><span class="k">Tools</span><span class="v"><button type="button" class="switch on" role="switch" aria-checked="true" aria-label="Tools"></button></span></div>
            <div class="kv-row" style="border:none;padding:2px 0"><span class="k">Image Input</span><span class="v"><button type="button" class="switch on" role="switch" aria-checked="true" aria-label="Image Input"></button></span></div>
            <div class="field"><label>Cost Input / Output</label><div style="display:flex;gap:6px"><input class="input mono" placeholder="3"><input class="input mono" placeholder="15"></div></div>
            <div class="field"><label>Headers</label><input class="input mono" placeholder="X-Key: value"></div>
            <div class="field"><label>Context Promotion Target</label><select class="select"><option>不提升</option><option>claude-opus-4.8</option></select></div>
            <div class="field"><label>Compaction Model</label><select class="select"><option>跟随角色</option><option>claude-haiku-4.5</option></select></div>
            <div class="kv-row span2" style="border:none;padding:2px 0"><span class="k">Remote Compaction</span><span class="v"><button type="button" class="switch" role="switch" aria-checked="false" aria-label="Remote Compaction"></button><span class="small muted">Provider 端压缩</span></span></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn outline" data-act="override-close">取消</button>
          <button class="btn primary" data-act="override-save">保存 Override</button>
        </div>
      </div>
    </div>`;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const root = $('#mpRoot');
    root.innerHTML = (S.view === 'list' ? listHtml() : editorHtml())
      + (S.overrideFor ? overrideDialogHtml(S.overrideFor) : '');
    bind(root);
    OMP.ui.labelIconButtons(root);
    /* 让 tab 徽标跟上本面板刚改的数据。禁用一个供应商会连带让引用它的
       角色不可用，所以受影响的不只是本面板那个数字 —— refreshCounts()
       两个一起重算。不刷的话，切到「角色」才发现问题，而 tab 上的数字
       还是旧的，正是合并想消掉的那种不一致。 */
    if (OMP.modelConfig && OMP.modelConfig.refreshTabs) OMP.modelConfig.refreshTabs();
  }

  function bind(root) {
    const search = $('#mpSearch', root);
    if (search) search.addEventListener('input', () => { S.query = search.value; renderListOnly(); });
    const ps = $('#presetSearch', root);
    if (ps) ps.addEventListener('input', () => { S.presetQuery = ps.value; render(); const el = $('#presetSearch'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });

    /* 表单字段 → draft（不整页重渲染，只刷新 YAML 预览） */
    $$('[data-f]', root).forEach(el => el.addEventListener('input', () => { S.draft[el.dataset.f] = el.value; S.errors = {}; refreshYml(); }));
    $$('select[data-f]', root).forEach(el => el.addEventListener('change', () => { S.draft[el.dataset.f] = el.value; refreshYml(); }));
    $$('[data-fa]', root).forEach(el => el.addEventListener('input', () => { S.draft.auth[el.dataset.fa] = el.value; refreshYml(); }));
    $$('[data-fe]', root).forEach(el => el.addEventListener('input', () => { S.draft.endpoint[el.dataset.fe] = el.value; refreshYml(); }));
    $$('[data-fd]', root).forEach(el => el.addEventListener('input', () => {
      const k = el.dataset.fd;
      S.draft.discovery[k] = k === 'timeout' ? +el.value : el.value; refreshYml();
    }));
    $$('[data-fadv]', root).forEach(el => el.addEventListener('input', () => { S.draft.advanced[el.dataset.fadv] = el.value; refreshYml(); }));
    $$('[data-fn]', root).forEach(el => el.addEventListener('input', () => {
      const k = el.dataset.fn;
      S.newModel[k] = ['ctx', 'maxOut'].includes(k) ? +el.value : el.value;
    }));
    $$('[data-fnc]', root).forEach(el => el.addEventListener('change', () => { S.newModel[el.dataset.fnc] = el.checked; }));
    const ye = $('#ymlEdit', root);
    if (ye) ye.addEventListener('input', () => { S.yamlText = ye.value; S.yamlError = /contextWindow:\s*"?abc/.test(ye.value); });

    /* details/summary 用原生 toggle，同步状态（click 委托只挂一次，见入口） */
    const adv = $('details.mp-advanced', root);
    if (adv) adv.addEventListener('toggle', () => { S.advancedOpen = adv.open; });
  }

  function renderListOnly() {
    /* 搜索时保留输入框焦点，仅替换列表 */
    const root = $('#mpRoot');
    const q = S.query;
    root.innerHTML = listHtml();
    bind(root);
    const el = $('#mpSearch');
    el.focus(); el.setSelectionRange(q.length, q.length);
  }

  /* ---------------- 动作 ---------------- */
  function onAction(e) {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act, id = t.dataset.id;
    const d = S.draft;

    switch (act) {
      /* ----- 列表 ----- */
      case 'new': openEditor(null, null); break;
      case 'reload': toast('已刷新全部供应商状态', 'refresh'); break;
      case 'dismiss-flash': S.flash = null; render(); break;
      case 'expand': S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id); render(); break;
      case 'toggle-enable': {
        const pv = MR.provider(id);
        pv.enabled = !pv.enabled;
        pv.status = pv.enabled ? 'available' : 'disabled';
        toast(pv.enabled ? `已启用 ${pv.name}` : `已禁用 ${pv.name} — 其模型不再参与路由`, pv.enabled ? 'check' : 'alert');
        render(); break;
      }
      case 'test': toast(`正在测试 ${MR.provider(id).name} 连接…`, 'pulse'); break;
      case 'rescan': toast(`已重新扫描 ${MR.provider(id).name} 的模型`, 'refresh'); break;
      case 'edit': openEditor(id, null); break;
      case 'copy-id': copy(id, '已复制供应商 ID：' + id); break;
      case 'copy-sel': copy(t.dataset.sel, '已复制 Model Selector：' + t.dataset.sel); break;
      case 'open-yml': toast('已打开 ~/.omp/agent/models.yml', 'file-code'); break;
      case 'delete': confirmDialog(
        `删除自定义供应商「${MR.provider(id).name}」？`,
        '该操作会从 models.yml 移除配置，引用其模型的角色将变为不可用。',
        () => {
          MR.providers.splice(MR.providers.findIndex(x => x.id === id), 1);
          toast('已删除供应商 ' + id, 'trash'); render();
        }); break;
      case 'override': S.overrideFor = t.dataset.mid; render(); break;

      /* ----- 编辑器框架 ----- */
      case 'back': S.view = 'list'; render(); break;
      case 'preset-toggle': S.presetOpen = !S.presetOpen; render();
        if (S.presetOpen) { const el = $('#presetSearch'); if (el) el.focus(); } break;
      case 'preset-pick': {
        const p = MR.preset(t.dataset.pid);
        S.presetSel = p.id;
        S.draft = draftFromPreset(p);
        S.modelsTab = p.discovery ? 'discovery' : 'catalog';
        S.testResult = null; S.discoveryResult = null; S.errors = {};
        toast(`已应用 ${p.name} 预设 — 可继续修改`, 'check');
        render(); break;
      }
      case 'preset-clear': S.presetSel = null; S.draft = blankDraft(); S.modelsTab = 'custom'; render(); break;

      /* ----- 认证 ----- */
      case 'auth-type': d.auth.type = t.dataset.v; S.oauthExpired = false; render(); break;
      case 'oauth-login': d.auth.account = 'snowpear@' + (d.id || 'provider') + '.com'; S.oauthExpired = false; toast('OMP Login 授权成功', 'check'); render(); break;
      case 'oauth-logout': d.auth.account = null; render(); break;
      case 'key-toggle-save': d.auth.save = !d.auth.save; render(); break;

      /* ----- Endpoint ----- */
      case 'endpoint-toggle': d.endpoint.useDefault = !d.endpoint.useDefault; refreshYml(); render(); break;

      /* ----- 模型 ----- */
      case 'models-tab': S.modelsTab = t.dataset.v; render(); break;
      case 'model-toggle': {
        const md = d.models.find(x => x.id === t.dataset.mid);
        md.status = md.status === 'available' ? 'disabled' : 'available';
        render(); break;
      }
      case 'override-draft': S.overrideFor = t.dataset.mid; render(); break;
      case 'discovery-toggle': d.discovery.enabled = !d.discovery.enabled; refreshYml(); render(); break;
      case 'discovery-test': case 'discovery-rescan': {
        S.discoveryResult = d.endpoint.url && d.endpoint.url.includes('11434')
          ? { ok: true, found: 6, usable: 6 }
          : d.api && d.local !== false ? { ok: true, found: 6, usable: 6 } : { ok: true, found: 6, usable: 6 };
        if (S.discoveryFail) S.discoveryResult = { ok: false, error: '连接超时 — 服务未响应' };
        render(); break;
      }
      case 'cmodel-add': S.addingModel = true; S.newModel = null; render(); break;
      case 'cmodel-cancel': S.addingModel = false; render(); break;
      case 'cmodel-save': {
        const nm = S.newModel || {};
        if (!nm.id || !/^[a-z0-9][a-z0-9._:-]*$/i.test(nm.id)) { S.errors.modelId = 'Model ID 必填，仅字母数字与 ._:-'; render(); return; }
        if (d.models.some(x => x.id === nm.id)) { S.errors.modelId = '该 Provider 下已存在相同 Model ID'; render(); return; }
        d.models.push({
          id: nm.id, name: nm.name || nm.id, ctx: nm.ctx || 128000, maxOut: nm.maxOut || 16384,
          img: nm.img, reason: nm.reason, tools: nm.tools,
          cIn: parseFloat(nm.cIn) || 0, cOut: parseFloat(nm.cOut) || 0,
          status: 'available', src: 'custom'
        });
        S.addingModel = false; S.errors = {};
        toast('已添加模型 ' + nm.id, 'check');
        render(); break;
      }
      case 'cmodel-copy': {
        const src = d.models.filter(x => x.src === 'custom')[+t.dataset.i];
        d.models.push(Object.assign({}, src, { id: src.id + '-copy', name: src.name + ' Copy' }));
        render(); break;
      }
      case 'cmodel-del': {
        const customs = d.models.filter(x => x.src === 'custom');
        const target = customs[+t.dataset.i];
        d.models.splice(d.models.indexOf(target), 1);
        render(); break;
      }

      /* ----- 高级 ----- */
      case 'adv-toggle': d.advanced[t.dataset.k] = !d.advanced[t.dataset.k]; refreshYml(); render(); break;

      /* ----- YAML ----- */
      case 'yml-copy': copy(ymlText(), '已复制 models.yml 片段'); break;
      case 'yml-format': toast('已格式化', 'check'); break;
      case 'yml-open': toast('已打开 ~/.omp/agent/models.yml', 'file-code'); break;
      case 'yml-source':
        S.sourceMode = !S.sourceMode;
        S.yamlText = S.sourceMode ? ymlText() : null;
        if (!S.sourceMode) S.yamlError = false;
        render(); break;

      /* ----- Override 对话框 ----- */
      case 'override-close': S.overrideFor = null; render(); break;
      case 'override-save': S.overrideFor = null; toast('已保存 Override — 写入 models.yml 的 overrides 段', 'check'); render(); break;

      /* ----- 测试 & 保存 ----- */
      case 'test-draft': {
        S.testing = true; render();
        setTimeout(() => {
          S.testing = false;
          if (S.testFail === '401') S.testResult = { ok: false, lines: ['HTTP 401 Unauthorized', 'API Key Invalid — 请检查凭据', 'POST ' + (d.endpoint.useDefault ? 'https://api.openai.com/v1' : d.endpoint.url || '默认地址') + '/responses'] };
          else if (S.testFail === 'unreachable') S.testResult = { ok: false, lines: ['Endpoint Unreachable', 'connect ETIMEDOUT — 无法连接到服务器', '请检查网络或 Base URL'] };
          else S.testResult = { ok: true, lines: ['连接成功 · 认证成功', `发现 ${d.models.length || 6} 个模型 · ${d.models.filter(x => x.status === 'available').length || 6} 个可用`, '延迟 142ms · ' + apiLabel(d.api)] };
          render();
        }, 700);
        break;
      }
      case 'save': saveDraft(); break;
    }
  }

  function copy(text, msg) {
    try { navigator.clipboard.writeText(text); } catch (e) {}
    toast(msg, 'copy');
  }

  function confirmDialog(title, text, onOk) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">${esc(title)}</div>
      <div class="modal-body">${esc(text)}</div>
      <div class="modal-foot">
        <button class="btn outline" data-x="0">取消</button>
        <button class="btn danger solid" data-x="1">确认删除</button>
      </div></div>`;
    wrap.addEventListener('click', e => {
      if (e.target === wrap || e.target.closest('[data-x="0"]')) wrap.remove();
      else if (e.target.closest('[data-x="1"]')) { wrap.remove(); onOk(); }
    });
    document.body.appendChild(wrap);
  }

  /* ---------------- 校验 & 保存 ---------------- */
  function saveDraft() {
    const d = S.draft;
    S.errors = {};
    if (!d.name.trim()) S.errors.id = S.errors.id || '';
    if (!d.id || !/^[a-z0-9][a-z0-9-]*$/.test(d.id)) S.errors.id = 'Provider ID 必填：小写字母 / 数字 / 连字符，如 company-gateway';
    else if (!S.editId && MR.provider(d.id)) S.errors.id = `Provider ID「${d.id}」已存在 — 同一预设可创建多个实例，请换一个 ID`;
    if (!d.endpoint.useDefault && !/^https?:\/\/.+/.test(d.endpoint.url)) S.errors.baseUrl = 'Base URL 必须是 http(s) 地址';
    if (S.yamlError) { toast('YAML 存在 Schema 错误，修复后才能保存', 'alert'); return; }
    if (Object.keys(S.errors).length) { toast('请先修正表单中的错误', 'alert'); render(); return; }

    if (S.editId) {
      const pv = MR.provider(S.editId);
      Object.assign(pv, {
        name: d.name, website: d.website, note: d.note,
        auth: Object.assign({}, d.auth), api: d.api,
        endpoint: Object.assign({}, d.endpoint),
        enabled: d.enabled, models: d.models
      });
      toast(`已保存 ${d.name} — models.yml 已更新`, 'check');
    } else {
      MR.providers.push({
        id: d.id, name: d.name || d.id, source: 'custom', status: d.auth.type === 'none' ? 'available' : 'not-authenticated',
        statusDetail: d.auth.type === 'none' ? '本地服务 · 无需认证' : '已创建 — 尚未完成认证',
        auth: Object.assign({}, d.auth), api: d.api,
        endpoint: Object.assign({}, d.endpoint),
        local: d.local, enabled: true, website: d.website, note: d.note,
        presetId: S.presetSel,
        discovery: d.discovery ? Object.assign({}, d.discovery) : undefined,
        models: d.models
      });
      toast(`已添加供应商 ${d.name || d.id} — 写入 models.yml`, 'check');
    }
    S.view = 'list';
    render();
    $('.page-body').scrollTop = 0;
  }

  /* ---------------- 场景（验收 / 评审用） ---------------- */
  function applyScenario(s) {
    const ed = (editId, presetId, patch) => {
      openEditor(editId, presetId);
      Object.assign(S, patch || {});
    };
    const map = {
      'list': () => {},
      'new-custom': () => ed(null, null),
      'preset-collapsed': () => ed(null, null, { presetOpen: false }),
      'preset-open': () => ed(null, null, { presetOpen: true }),
      'preset-anthropic': () => ed(null, 'anthropic'),
      'preset-openai': () => ed(null, 'openai'),
      'preset-ollama': () => ed(null, 'ollama'),
      'custom-gateway': () => {
        ed(null, null);
        Object.assign(S.draft, {
          name: 'Company Gateway', id: 'company-gateway',
          website: 'https://wiki.corp.example.com/ai-gateway',
          note: '公司统一网关，走内网专线。', api: 'openai-responses'
        });
        S.draft.auth = { type: 'env', envName: 'COMPANY_GATEWAY_KEY', key: '', save: true, command: '', account: null };
        S.draft.endpoint = { useDefault: false, url: 'https://gateway.corp.example.com/v1' };
      },
      'auth-apikey': () => ed(null, 'openai', {}),
      'auth-env': () => { ed(null, 'openai'); S.draft.auth.type = 'env'; S.draft.auth.envName = 'OPENAI_API_KEY'; },
      'auth-command': () => { ed(null, 'openai'); S.draft.auth.type = 'command'; S.draft.auth.command = '!op read op://dev/openai/api-key'; },
      'oauth-ok': () => { ed(null, 'anthropic'); S.draft.auth.account = 'snowpear@anthropic.com'; },
      'oauth-out': () => { ed(null, 'anthropic'); S.draft.auth.account = null; },
      'test-ok': () => { ed(null, 'openai'); S.draft.auth = { type: 'api-key', key: 'sk-proj-••••••••3fA2', save: true, envName: '', command: '', account: null }; S.testResult = { ok: true, lines: ['连接成功 · 认证成功', '发现 4 个模型 · 3 个可用', '延迟 168ms · OpenAI Responses'] }; },
      'test-401': () => { ed(null, 'openai'); S.draft.auth = { type: 'api-key', key: 'sk-proj-invalid', save: true, envName: '', command: '', account: null }; S.testResult = { ok: false, lines: ['HTTP 401 Unauthorized', 'API Key Invalid — 请检查凭据', 'POST https://api.openai.com/v1/responses'] }; },
      'test-unreachable': () => { ed(null, null); S.draft.endpoint = { useDefault: false, url: 'https://llm.internal.example.com/v1' }; S.testResult = { ok: false, lines: ['Endpoint Unreachable', 'connect ETIMEDOUT 10.20.0.14:443', '请检查网络或 Base URL'] }; },
      'discovery-ok': () => { ed(null, 'ollama'); S.modelsTab = 'discovery'; S.discoveryResult = { ok: true, found: 6, usable: 6 }; },
      'discovery-fail': () => { ed(null, 'ollama'); S.modelsTab = 'discovery'; S.draft.endpoint.url = 'http://localhost:11435/v1'; S.discoveryResult = { ok: false, error: '连接超时 — 服务未响应（http://localhost:11435）' }; },
      'models-multi': () => ed('anthropic', null, { modelsTab: 'catalog' }),
      'custom-model-add': () => {
        ed(null, null);
        Object.assign(S.draft, { name: 'Company Gateway', id: 'company-gateway', api: 'openai-responses' });
        S.draft.endpoint = { useDefault: false, url: 'https://gateway.corp.example.com/v1' };
        S.draft.models = [{ id: 'gpt-example', name: 'GPT Example', ctx: 128000, maxOut: 16384, img: true, reason: true, tools: true, cIn: 1.5, cOut: 10, status: 'available', src: 'custom' }];
        S.modelsTab = 'custom'; S.addingModel = true;
      },
      'model-override': () => { ed('anthropic', null); S.modelsTab = 'catalog'; S.overrideFor = 'claude-sonnet-4.5'; },
      'advanced': () => ed('anthropic', null, { advancedOpen: true }),
      'yaml': () => ed(null, 'anthropic'),
      'yaml-error': () => {
        ed(null, 'anthropic');
        S.sourceMode = true;
        S.yamlText = MR.modelsYml(S.draft).replace('contextWindow: 200000', 'contextWindow: "abc"');
        S.yamlError = true;
      },
      'edit-existing': () => ed('company-gateway', null)
    };
    (map[s] || map['list'])();
    render();
  }

  /* ---------------- 面板注册 ----------------
     以前这里是 DOMContentLoaded + 直接读 location.hash。合并后 hash 只有
     一个所有者（page-model-config.js），所以本模块改为暴露一组钩子：

       mount()      — 首次显示时挂 click 委托并首渲染（幂等）
       render()     — 外部要求重绘（例如从角色面板跳进来之后）
       openEditor() — 供应商编辑器深链入口
       scenario()   — 验收场景

     click 委托仍然只挂一次：render() 只替换 innerHTML，容器本身常驻。 */
  OMP.modelConfig = OMP.modelConfig || {};
  OMP.modelConfig.providers = {
    mount() {
      /* 挂载标记记在根节点上（随 innerHTML 销毁重置），而不是模块级闭包：
         离开页面再回来时模板重新注入，新根节点无标记，mount 重新执行。
         记在闭包里会让「已挂载」跨销毁存活，回来后内容区空白。 */
      const root = $('#mpRoot');
      if (!root) return;
      if (root._mcMounted) return;
      root._mcMounted = true;
      root.addEventListener('click', onAction);
      render();
    },
    render,
    /* 从角色面板「查看供应商」进来时直接打开该 Provider 的编辑器。

       这里刻意不再写 S.flash：原 providers.html 的 #edit= 深链会设置
       S.flash 然后 openEditor()，但 S.flash 只在 listHtml() 里渲染 ——
       编辑器视图根本不显示它，等用户点「返回」回到列表时，那句「已从
       角色页面定位到 …」才冒出来，此时既过期又莫名其妙。跨面板跳转的
       反馈改用 toast：它不依赖某个视图存在，出现的时机也正确。 */
    openProvider(pid) {
      this.mount();
      if (!MR.provider(pid)) return false;
      openEditor(pid, null);
      return true;
    },
    scenario(s) { this.mount(); applyScenario(s); }
  };
})();
