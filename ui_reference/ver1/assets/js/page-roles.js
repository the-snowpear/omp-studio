/* ============================================================
   OMP Studio — 模型配置 · 「角色」面板
   角色总览 · 角色详情（Primary / Thinking / Fallback /
   Global-Project 作用域 / 不可用处理）· Cycle Order ·
   config.yml 实时预览

   同 page-models.js：本模块原是 roles.html 的整页脚本，现在注册成
   「模型配置」页的一个面板。与供应商之间的往返以前是整页跳转
   (providers.html#edit=…)，会丢掉两边的所有状态；现在是同页切 tab，
   草稿与滚动位置都留在原处。
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
    view: 'overview',        // overview | detail
    roleId: null,
    draft: null,             // 角色编辑草稿
    cycleEdit: false,
    cycleDraft: null,
    sourceMode: false,
    yamlError: false,
    yamlText: null,
    dialog: null,            // 'assign' | 'new-role' | 'restore-global' | 'add-fallback'
    assignSel: null,         // 从供应商页带过来的 selector
    flash: null,
    newRole: null,           // 新建角色草稿
    saveTarget: null         // 'global' | 'project'（默认跟随当前 scope）
  };

  function roleDraft(role) {
    return {
      id: role.id, alias: role.alias, name: role.name, desc: role.desc, builtin: role.builtin,
      primary: role.primary, thinking: role.thinking,
      scope: role.scope,
      globalPrimary: role.globalPrimary || role.primary,
      globalThinking: role.globalThinking !== undefined ? role.globalThinking : role.thinking,
      fallbacks: role.fallbacks.slice(), fallbackOn: role.fallbackOn, recovery: role.recovery
    };
  }
  function openDetail(roleId, patch) {
    S.view = 'detail';
    S.roleId = roleId;
    S.draft = roleDraft(MR.role(roleId));
    S.saveTarget = S.draft.scope;
    S.sourceMode = false; S.yamlError = false; S.yamlText = null;
    S.dialog = null;
    Object.assign(S, patch || {});
    render();
    $('.page-body').scrollTop = 0;
  }

  /* ---------------- 通用渲染件 ---------------- */
  function selLabel(sel) {
    const { provider, model } = MR.findModel(sel);
    if (!provider || !model) return `<span class="mono">${esc(sel)}</span>`;
    return `<b>${esc(provider.name)}</b><span class="muted">/</span><span class="mono">${esc(model.id)}</span>`;
  }
  function thinkingChip(t) {
    return t && t !== 'off' ? `<span class="chip purple xs">Thinking ${t}</span>` : '';
  }
  function modelSelectHtml(curSel) {
    /* 仅列出真正可用的模型，按 Provider 分组 */
    const groups = {};
    MR.usableModels().forEach(u => {
      (groups[u.provider.id] = groups[u.provider.id] || { name: u.provider.name, items: [] }).items.push(u);
    });
    const curOk = MR.usableModels().some(u => u.selector === curSel);
    return `<select class="select" data-f="primary" style="max-width:340px">
      ${!curOk && curSel ? `<option value="${esc(curSel)}" selected>⚠ ${esc(curSel)}（当前不可用）</option>` : ''}
      ${Object.values(groups).map(g => `<optgroup label="${esc(g.name)}">
        ${g.items.map(u => `<option value="${esc(u.selector)}"${u.selector === curSel ? ' selected' : ''}>${esc(u.model.name)} · ${esc(u.model.id)}</option>`).join('')}
      </optgroup>`).join('')}
    </select>`;
  }

  /* ---------------- 角色总览 ---------------- */
  function overviewHtml() {
    const builtin = MR.roles.filter(r => r.builtin);
    const custom = MR.roles.filter(r => !r.builtin);
    return `
    ${S.flash ? `<div class="preset-banner">${icon('check', 'sm')}<span>${esc(S.flash)}</span>
      <span class="spacer"></span><button class="icon-btn small" data-act="dismiss-flash">${icon('x', 'sm')}</button></div>` : ''}

    <div class="mr-toolbar">
      <b style="font-size:var(--fs-13)">内置角色</b>
      <span class="mr-count">${builtin.length} 个</span>
      <span class="spacer"></span>
      <button class="btn primary" data-act="new-role">${icon('plus', 'sm')}创建自定义角色</button>
    </div>
    ${builtin.map(roleRowHtml).join('')}

    ${custom.length ? `
    <div class="mr-toolbar" style="margin-top:20px">
      <b style="font-size:var(--fs-13)">自定义角色</b>
      <span class="mr-count">${custom.length} 个</span>
    </div>
    ${custom.map(roleRowHtml).join('')}` : ''}

    ${cycleHtml()}
    ${ymlCardHtml()}
    `;
  }

  function roleRowHtml(r) {
    const issue = MR.roleIssue(r);
    const over = r.scope === 'project';
    return `
    <button class="role-row${issue ? (issue.kind === 'model-missing' || issue.kind === 'provider-down' ? ' has-error' : ' has-issue') : ''}" data-act="open" data-id="${r.id}">
      <span class="role-icon-area">
        <span class="a-ic ${issue ? 'amber' : 'purple'}">${icon(roleIcon(r.id), 'sm')}</span>
      </span>
      <span class="role-main-area">
        <span class="role-name-section">
          <div class="role-header">
            <span class="r-name">${esc(r.name)}<span class="alias">${esc(r.alias)}</span></span>
          </div>
          <span class="r-desc">${esc(r.desc)}</span>
        </span>
        <span class="role-model-section">
          ${issue ? `
          <span class="role-model">
            <span class="model-name unavailable">${esc(r.primary)}</span>
            <span class="chip ${issue.kind === 'model-missing' || issue.kind === 'provider-down' ? 'red' : 'amber'}">${icon('alert', 'sm')}</span>
          </span>` : `
          ${r.fallbackOn && r.fallbacks.length ? `<span class="chip gray xs">FB</span>` : ''}
          <select class="model-select" data-f="quick-primary" data-role="${r.id}" onclick="event.stopPropagation()">
            ${MR.usableModels().map(u => `<option value="${esc(u.selector)}"${u.selector === r.primary ? ' selected' : ''}>${esc(u.provider.name)} / ${esc(u.model.name)}</option>`).join('')}
          </select>
          <select class="effort-select" data-f="quick-effort" data-role="${r.id}" aria-label="推理强度" onclick="event.stopPropagation()">
            ${MR.THINKING.map(t => `<option value="${t.id}"${(r.thinking || 'off') === t.id ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>`}
        </span>
      </span>
      <span class="role-chevron">${icon('chevron-r', 'sm')}</span>
    </button>`;
  }
  function roleIcon(id) {
    return { default: 'cpu', smol: 'zap', slow: 'brain', vision: 'eye', plan: 'layers', designer: 'sparkles', commit: 'commit', tiny: 'box', task: 'bot', advisor: 'user', review: 'diff', docs: 'book' }[id] || 'cpu';
  }
  function issueShort(issue) {
    /* 惰性求值 — model-missing 等 issue 没有 provider 字段，不能放在对象字面量里提前求值 */
    switch (issue.kind) {
      case 'model-missing': return '模型不存在';
      case 'provider-unauth': return issue.provider.status === 'auth-expired' ? '凭据已过期' : 'Provider 未认证';
      case 'provider-disabled': return 'Provider 已禁用';
      case 'provider-down': return 'Provider 离线';
      case 'model-disabled': return '模型已禁用';
      case 'model-unavailable': return '模型不可用';
      default: return '不可用';
    }
  }

  /* ---------------- Cycle Order ---------------- */
  function cycleHtml() {
    const order = S.cycleEdit ? S.cycleDraft : MR.cycleOrder;
    const inCycle = order.map(id => MR.role(id)).filter(Boolean);
    const pool = MR.roles.filter(r => !order.includes(r.id));
    return `<div class="mp-sec" style="margin-top:20px">
      <h3>快速模型切换顺序 <span class="chip-code">Cycle Order</span></h3>
      <p class="sec-desc">工作台循环切换模型时按此顺序轮转（默认 Fast → Default → Thinking）。</p>
      <div class="cycle-flow">
        ${inCycle.map((r, i) => `
          ${i ? `<span class="cycle-arrow">${icon('arrow-r', 'sm')}</span>` : ''}
          <span class="cycle-chip">${icon(roleIcon(r.id), 'sm')}${esc(r.name)} <span class="mono">${esc(r.alias)}</span>
            ${S.cycleEdit ? `<button class="icon-btn small" data-act="cycle-del" data-id="${r.id}" data-tip="移出循环" style="width:18px;height:18px">${icon('x', 'sm')}</button>` : ''}
          </span>`).join('')}
        ${inCycle.length ? `<span class="cycle-arrow">${icon('refresh', 'sm')}</span>` : ''}
      </div>
      ${S.cycleEdit ? `
        <div class="preset-group-label">可加入循环的角色</div>
        <div class="cycle-pool">
          ${pool.map(r => `<button class="btn small outline" data-act="cycle-add" data-id="${r.id}">${icon('plus', 'sm')}${esc(r.name)} <span class="mono">${esc(r.alias)}</span></button>`).join('') || '<span class="small muted">全部角色都已在循环中</span>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn small primary" data-act="cycle-save">保存顺序</button>
          <button class="btn small outline" data-act="cycle-cancel">取消</button>
        </div>` : `
        <div style="margin-top:12px"><button class="btn small outline" data-act="cycle-edit">${icon('pencil', 'sm')}编辑顺序</button></div>`}
    </div>`;
  }

  /* ---------------- 角色详情 ---------------- */
  function detailHtml() {
    const d = S.draft;
    const issue = MR.roleIssue({ primary: d.primary });
    return `
    <div class="mr-toolbar">
      <button class="icon-btn" data-act="back" data-tip="返回角色列表">${icon('arrow-l')}</button>
      <b style="font-size:var(--fs-14)">${esc(d.name)}</b>
      <span class="chip-code">${esc(d.alias)}</span>
      ${d.builtin ? '<span class="chip gray xs">内置角色</span>' : '<span class="chip purple xs">自定义角色</span>'}
    </div>

    ${issue ? issueBannerHtml(issue) : ''}

    <div class="mp-sec">
      <h3>模型路由</h3>
      <p class="sec-desc">角色只决定「用哪个模型、以什么思考强度」— Provider、凭据与 Endpoint 在「模型 / 供应商」中配置。</p>
      <div class="kv-list">
        <div class="kv-row"><span class="k">Primary Model</span><span class="v">
          ${modelSelectHtml(d.primary)}
          <a class="btn small outline" href="#edit=${esc(MR.parseSelector(d.primary).providerId)}">${OMP.brand(MR.parseSelector(d.primary).providerId, 'sm') || icon('server', 'sm')}查看供应商</a>
        </span></div>
        <div class="kv-row"><span class="k">Thinking Level</span><span class="v">
          <span class="seg" role="tablist" aria-label="Thinking Level">
            ${MR.THINKING.map(t => `<button data-act="thinking" data-v="${t.id}" class="${(d.thinking || 'off') === t.id ? 'active' : ''}" role="tab" aria-selected="${(d.thinking || 'off') === t.id}">${t.label}</button>`).join('')}
          </span>
          <span class="small muted">写入 Selector：<span class="chip-code">${esc(d.primary)}${d.thinking && d.thinking !== 'off' ? ':' + d.thinking : ''}</span></span>
        </span></div>
      </div>
    </div>

    ${fallbackHtml()}
    ${scopeHtml()}
    ${ymlCardHtml()}

    <div class="mp-foot">
      <button class="btn outline" data-act="back">返回</button>
      ${!d.builtin ? `<button class="btn danger" data-act="delete-role">${icon('trash', 'sm')}删除角色</button>` : ''}
      <span class="right">
        <button class="btn primary" data-act="save">${icon('check', 'sm')}保存到 ${S.saveTarget === 'project' ? '当前 Project' : 'Global'}</button>
      </span>
    </div>`;
  }

  /* ---------- 不可用横幅 ---------- */
  function issueBannerHtml(issue) {
    const d = S.draft;
    /* 惰性求值 — 不同 kind 携带的字段不同，对象字面量会提前求值导致空指针 */
    let map;
    switch (issue.kind) {
      case 'model-missing':
        map = { err: 1, title: '当前角色模型不可用',
          text: `引用的模型 ${issue.selector} 已被删除或从未存在 — 该角色的请求会失败，不会静默降级。`,
          pid: MR.parseSelector(issue.selector).providerId, auth: 0 };
        break;
      case 'provider-unauth':
        map = { err: 0, title: `Provider「${issue.provider.name}」${issue.provider.status === 'auth-expired' ? '凭据已过期' : '未认证'}`,
          text: '认证通过后该角色即可恢复，也可以先换一个模型顶着。', pid: issue.provider.id, auth: 1 };
        break;
      case 'provider-disabled':
        map = { err: 0, title: `Provider「${issue.provider.name}」已被禁用`,
          text: '重新启用后该角色即可恢复。', pid: issue.provider.id, auth: 0 };
        break;
      case 'provider-down':
        map = { err: 1, title: `Provider「${issue.provider.name}」当前离线`,
          text: issue.provider.statusDetail || '服务不可达。', pid: issue.provider.id, auth: 0 };
        break;
      case 'model-disabled':
        map = { err: 0, title: `模型「${issue.model.id}」已被禁用`,
          text: '该模型仍在 Catalog 中，但被手动禁用 — 启用后该角色即可恢复。', pid: issue.provider.id, auth: 0 };
        break;
      default:
        map = { err: 1, title: `模型「${issue.model ? issue.model.id : ''}」当前不可用`,
          text: 'Provider 状态异常导致模型不可用。', pid: issue.provider.id, auth: 0 };
    }
    return `<div class="role-issue-banner${map.err ? ' err' : ''}">
      ${icon('alert', 'sm')}
      <div style="flex:1;min-width:0">
        <div class="rib-title">${esc(map.title)}</div>
        <div class="rib-text">${esc(map.text)}</div>
        <div class="rib-acts">
          <button class="btn small primary" data-act="fix-pick">${icon('cpu', 'sm')}选择其他模型</button>
          <a class="btn small outline" href="#edit=${esc(map.pid)}">${OMP.brand(map.pid, 'sm') || icon('server', 'sm')}查看供应商</a>
          ${map.auth ? `<a class="btn small outline" href="#edit=${esc(map.pid)}">${icon('key', 'sm')}重新认证</a>` : ''}
          ${d.scope === 'project' ? `<button class="btn small outline" data-act="restore-global">${icon('rewind', 'sm')}恢复全局配置</button>` : ''}
        </div>
      </div>
    </div>`;
  }

  /* ---------- Fallback ---------- */
  function fallbackHtml() {
    const d = S.draft;
    return `<div class="mp-sec">
      <h3>Fallback Models
        <span class="spacer"></span>
        <button type="button" class="switch${d.fallbackOn ? ' on' : ''}" role="switch" aria-checked="${d.fallbackOn}" aria-label="开启 Model Fallback" data-act="fb-toggle"></button>
      </h3>
      <p class="sec-desc">当主模型因 Rate Limit、Quota、Provider 故障或暂时不可用而无法继续时，OMP 按顺序尝试备用模型。</p>
      ${d.fallbackOn ? `
      <div class="fb-chain">
        <div class="fb-node primary">
          <span class="fb-idx">P</span>
          <span style="display:flex;gap:6px;align-items:center">${selLabel(d.primary)}</span>
          ${thinkingChip(d.thinking)}
          <span class="chip purple xs">Primary</span>
        </div>
        ${d.fallbacks.map((f, i) => `
        <div class="fb-node">
          <span class="fb-idx">${i + 1}</span>
          <span style="display:flex;gap:6px;align-items:center">${selLabel(f)}</span>
          ${MR.roleIssue({ primary: f }) ? `<span class="chip amber xs">不可用</span>` : ''}
          <span class="spacer"></span>
          <button class="icon-btn small" data-act="fb-up" data-i="${i}" data-tip="上移" ${i === 0 ? 'disabled' : ''}>${icon('arrow-u', 'sm')}</button>
          <button class="icon-btn small" data-act="fb-down" data-i="${i}" data-tip="下移" ${i === d.fallbacks.length - 1 ? 'disabled' : ''}>${icon('arrow-d', 'sm')}</button>
          <button class="icon-btn small" data-act="fb-del" data-i="${i}" data-tip="删除备用模型">${icon('trash', 'sm')}</button>
        </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
        <select class="select" id="fbPick" style="max-width:300px">
          ${MR.usableModels().filter(u => u.selector !== d.primary && !d.fallbacks.includes(u.selector))
            .map(u => `<option value="${esc(u.selector)}">${esc(u.provider.name)} / ${esc(u.model.name)}</option>`).join('')}
        </select>
        <button class="btn small outline" data-act="fb-add">${icon('plus', 'sm')}添加备用模型</button>
      </div>
      <div class="kv-list" style="margin-top:12px">
        <div class="kv-row"><span class="k">主模型恢复策略</span><span class="v">
          <span class="seg" role="tablist" aria-label="恢复策略">
            <button data-act="recovery" data-v="cooldown" class="${d.recovery === 'cooldown' ? 'active' : ''}" role="tab">Cooldown 结束后恢复 Primary</button>
            <button data-act="recovery" data-v="manual" class="${d.recovery === 'manual' ? 'active' : ''}" role="tab">保持 Fallback，直到手动切换</button>
          </span>
        </span></div>
      </div>` : `
      <div class="pm-empty">${icon('info', 'sm')}Fallback 已关闭 — 主模型失败时该角色会直接报错</div>`}
    </div>`;
  }

  /* ---------- Global / Project 作用域 ---------- */
  function scopeHtml() {
    const d = S.draft;
    const isProject = d.scope === 'project';
    return `<div class="mp-sec">
      <h3>配置作用域</h3>
      <p class="sec-desc">角色可以有 Global 配置与 Project 覆盖 — 生效值 = Project 覆盖 ?? Global。避免「不知道为什么这个角色在不同项目里用不同模型」。</p>
      <div class="scope-grid">
        <div class="scope-cell">
          <div class="sc-label">Global 配置</div>
          <div>${selLabel(d.globalPrimary)} ${thinkingChip(d.globalThinking)}</div>
        </div>
        <div class="scope-cell">
          <div class="sc-label">Project 覆盖</div>
          ${isProject
            ? `<div>${selLabel(d.primary)} ${thinkingChip(d.thinking)}</div>`
            : `<div class="muted">未覆盖 — 继承 Global</div>`}
        </div>
        <div class="scope-cell eff">
          <div class="sc-label">当前生效（Effective）</div>
          <div>${selLabel(isProject ? d.primary : d.globalPrimary)} ${thinkingChip(isProject ? d.thinking : d.globalThinking)}</div>
        </div>
      </div>
      <div class="kv-list" style="margin-top:10px">
        <div class="kv-row"><span class="k">保存到</span><span class="v">
          <span class="seg" role="tablist" aria-label="保存目标">
            <button data-act="save-target" data-v="global" class="${S.saveTarget === 'global' ? 'active' : ''}" role="tab">Global</button>
            <button data-act="save-target" data-v="project" class="${S.saveTarget === 'project' ? 'active' : ''}" role="tab">当前 Project</button>
          </span>
          ${isProject ? `<button class="btn small outline" data-act="restore-global">${icon('rewind', 'sm')}恢复继承全局配置</button>` : ''}
        </span></div>
      </div>
    </div>`;
  }

  /* ---------- YAML 预览 ---------- */
  function ymlText() { return MR.configYml(MR.roles, MR.cycleOrder); }
  function ymlCardHtml() {
    return `<div class="yml-card" style="margin-top:20px">
      <div class="yml-head">
        ${icon('file-code', 'sm')}配置预览
        <span class="yml-path">~/.omp/agent/config.yml</span>
        <span class="chip green xs"><span class="dot green pulse"></span>实时</span>
        <span class="spacer"></span>
        <button class="btn small outline" data-act="yml-copy">${icon('copy', 'sm')}复制</button>
        <button class="btn small outline" data-act="yml-format">格式化</button>
        <button class="btn small outline" data-act="yml-open">${icon('external', 'sm')}打开配置文件</button>
        <button class="btn small ${S.sourceMode ? 'primary' : 'outline'}" data-act="yml-source">${icon('file-code', 'sm')}高级模式</button>
      </div>
      ${S.sourceMode
        ? `<textarea class="yml-body edit" id="ymlEdit" spellcheck="false">${esc(S.yamlText != null ? S.yamlText : ymlText())}</textarea>`
        : `<pre class="yml-body">${esc(ymlText())}</pre>`}
      ${S.yamlError ? `<div class="yml-error">${icon('alert-c', 'sm')}YAML 解析失败 · 第 4 行：<span class="mono">slow</span> 引用了不存在的模型 <span class="mono">anthropic/claude-opus-9</span> — 修复后才能保存</div>` : ''}
    </div>`;
  }

  /* ---------------- 对话框 ---------------- */
  function dialogHtml() {
    if (S.dialog === 'assign') {
      return `<div class="modal-backdrop" data-bd="1">
        <div class="modal" role="dialog" aria-modal="true" aria-label="分配给角色">
          <div class="modal-head">把模型分配给角色</div>
          <div class="modal-body">
            <p class="small" style="margin-bottom:10px">模型 <span class="chip-code">${esc(S.assignSel)}</span> 将成为所选角色的 Primary Model：</p>
            ${MR.roles.map(r => `
              <button class="pick-role" data-act="assign-pick" data-id="${r.id}">
                ${icon(roleIcon(r.id), 'sm')}<b>${esc(r.name)}</b>
                <span class="mono muted small">${esc(r.alias)}</span>
                <span class="spacer"></span>
                <span class="mono tiny muted ellipsis" style="max-width:180px">${esc(r.primary)}</span>
              </button>`).join('')}
          </div>
          <div class="modal-foot"><button class="btn outline" data-act="dialog-close">取消</button></div>
        </div>
      </div>`;
    }
    if (S.dialog === 'new-role') {
      const nr = S.newRole || (S.newRole = { id: '', name: '', primary: MR.usableModels()[0].selector, thinking: 'off', quickCycle: false });
      return `<div class="modal-backdrop" data-bd="1">
        <div class="modal" role="dialog" aria-modal="true" aria-label="创建自定义角色" style="width:520px">
          <div class="modal-head">创建自定义角色</div>
          <div class="modal-body">
            <div class="f-grid">
              <div class="field"><label>Role ID</label>
                <input class="input mono" data-fnr="id" value="${esc(nr.id)}" placeholder="如 review → @review"></div>
              <div class="field"><label>Display Name</label>
                <input class="input" data-fnr="name" value="${esc(nr.name)}" placeholder="如 Code Review"></div>
              <div class="field span2"><label>Primary Model</label>${modelSelectHtml(nr.primary).replace('data-f="primary"', 'data-fnr="primary"')}</div>
              <div class="field span2"><label>Thinking Level</label>
                <span class="seg">${MR.THINKING.map(t => `<button data-act="nr-thinking" data-v="${t.id}" class="${nr.thinking === t.id ? 'active' : ''}">${t.label}</button>`).join('')}</span></div>
              <div class="kv-row span2" style="border:none;padding:2px 0"><span class="k">加入快速模型切换（Cycle Order）</span><span class="v">
                <button type="button" class="switch${nr.quickCycle ? ' on' : ''}" role="switch" aria-checked="${nr.quickCycle}" aria-label="加入快速模型切换" data-act="nr-cycle"></button></span></div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn outline" data-act="dialog-close">取消</button>
            <button class="btn primary" data-act="nr-save">创建角色</button>
          </div>
        </div>
      </div>`;
    }
    if (S.dialog === 'restore-global') {
      const d = S.draft;
      return `<div class="modal-backdrop" data-bd="1">
        <div class="modal" role="dialog" aria-modal="true" aria-label="恢复全局配置">
          <div class="modal-head">恢复「${esc(d.name)}」继承全局配置？</div>
          <div class="modal-body">
            当前 Project 覆盖为 <span class="chip-code">${esc(d.primary)}</span>，恢复后将继承 Global 配置
            <span class="chip-code">${esc(d.globalPrimary)}</span>，Project 级 Override 会被移除。
          </div>
          <div class="modal-foot">
            <button class="btn outline" data-act="dialog-close">取消</button>
            <button class="btn primary" data-act="restore-global-ok">恢复继承全局</button>
          </div>
        </div>
      </div>`;
    }
    return '';
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const root = $('#roleRoot');
    root.innerHTML = (S.view === 'overview' ? overviewHtml() : detailHtml()) + dialogHtml();
    bind(root);
    OMP.ui.labelIconButtons(root);
    /* 同 providers 面板：改完角色路由后刷新 tab 徽标（角色的「需要处理」
       计数会随 primary model 的可用性变化）。 */
    if (OMP.modelConfig && OMP.modelConfig.refreshTabs) OMP.modelConfig.refreshTabs();
  }

  function bind(root) {
    $$('[data-f="primary"]', root).forEach(el => el.addEventListener('change', () => {
      S.draft.primary = el.value; render();
    }));
    $$('[data-f="quick-primary"]', root).forEach(el => el.addEventListener('change', () => {
      const role = MR.role(el.dataset.role);
      if (!role) return;
      role.primary = el.value;
      role.globalPrimary = el.value;
      toast(`${role.alias} 的模型已更新`, 'check');
      render();
    }));
    $$('[data-f="quick-effort"]', root).forEach(el => el.addEventListener('change', () => {
      const role = MR.role(el.dataset.role);
      if (!role) return;
      role.thinking = el.value === 'off' ? null : el.value;
      role.globalThinking = role.thinking;
      toast(`${role.alias} 的 Effort 已更新`, 'check');
      render();
    }));
    $$('[data-fnr]', root).forEach(el => {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => { S.newRole[el.dataset.fnr] = el.value; });
    });
    const ye = $('#ymlEdit', root);
    if (ye) ye.addEventListener('input', () => {
      S.yamlText = ye.value; S.yamlError = /claude-opus-9/.test(ye.value);
    });
    $$('.modal-backdrop', root).forEach(bd => bd.addEventListener('mousedown', e => {
      if (e.target === bd) { S.dialog = null; render(); }
    }));
  }

  /* ---------------- 动作 ---------------- */
  function onAction(e) {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    const d = S.draft;
    switch (act) {
      case 'open': openDetail(t.dataset.id); break;
      case 'back': S.view = 'overview'; S.flash = null; render(); break;
      case 'dismiss-flash': S.flash = null; render(); break;
      case 'thinking': d.thinking = t.dataset.v === 'off' ? null : t.dataset.v; render(); break;
      case 'fb-toggle': d.fallbackOn = !d.fallbackOn; render(); break;
      case 'fb-add': {
        const sel = $('#fbPick');
        if (sel && sel.value) { d.fallbacks.push(sel.value); render(); }
        break;
      }
      case 'fb-del': d.fallbacks.splice(+t.dataset.i, 1); render(); break;
      case 'fb-up': { const i = +t.dataset.i; [d.fallbacks[i - 1], d.fallbacks[i]] = [d.fallbacks[i], d.fallbacks[i - 1]]; render(); break; }
      case 'fb-down': { const i = +t.dataset.i; [d.fallbacks[i + 1], d.fallbacks[i]] = [d.fallbacks[i], d.fallbacks[i + 1]]; render(); break; }
      case 'recovery': d.recovery = t.dataset.v; render(); break;
      case 'save-target': S.saveTarget = t.dataset.v; render(); break;
      case 'restore-global': S.dialog = 'restore-global'; render(); break;
      case 'restore-global-ok': {
        d.scope = 'global';
        d.primary = d.globalPrimary; d.thinking = d.globalThinking;
        S.saveTarget = 'global'; S.dialog = null;
        toast(`已恢复 ${d.alias} 继承全局配置`, 'check');
        render(); break;
      }
      case 'fix-pick': toast('在下方 Primary Model 中重新选择模型', 'info'); break;
      case 'save': {
        const role = MR.role(S.roleId);
        const target = S.saveTarget;
        if (target === 'global') {
          role.primary = d.primary; role.thinking = d.thinking; role.scope = 'global';
          role.globalPrimary = d.primary; role.globalThinking = d.thinking;
        } else {
          role.primary = d.primary; role.thinking = d.thinking; role.scope = 'project';
        }
        role.fallbacks = d.fallbacks.slice(); role.fallbackOn = d.fallbackOn; role.recovery = d.recovery;
        toast(`已保存 ${d.alias} 到 ${target === 'project' ? '当前 Project' : 'Global'} — config.yml 已更新`, 'check');
        S.view = 'overview'; render();
        $('.page-body').scrollTop = 0;
        break;
      }
      case 'delete-role': {
        MR.roles.splice(MR.roles.findIndex(r => r.id === S.roleId), 1);
        toast('已删除自定义角色 ' + d.alias, 'trash');
        S.view = 'overview'; render(); break;
      }
      /* Cycle Order */
      case 'cycle-edit': S.cycleEdit = true; S.cycleDraft = MR.cycleOrder.slice(); render(); break;
      case 'cycle-cancel': S.cycleEdit = false; render(); break;
      case 'cycle-save':
        MR.cycleOrder = S.cycleDraft.slice();
        S.cycleEdit = false;
        toast('已保存快速模型切换顺序', 'check'); render(); break;
      case 'cycle-add': S.cycleDraft.push(t.dataset.id); render(); break;
      case 'cycle-del': S.cycleDraft.splice(S.cycleDraft.indexOf(t.dataset.id), 1); render(); break;
      /* YAML */
      case 'yml-copy': try { navigator.clipboard.writeText(ymlText()); } catch (e) {} toast('已复制 config.yml 片段', 'copy'); break;
      case 'yml-format': toast('已格式化', 'check'); break;
      case 'yml-open': toast('已打开 ~/.omp/agent/config.yml', 'file-code'); break;
      case 'yml-source':
        S.sourceMode = !S.sourceMode;
        S.yamlText = S.sourceMode ? ymlText() : null;
        if (!S.sourceMode) S.yamlError = false;
        render(); break;
      /* 对话框 */
      case 'new-role': S.dialog = 'new-role'; S.newRole = null; render(); break;
      case 'nr-thinking': S.newRole.thinking = t.dataset.v; render(); break;
      case 'nr-cycle': S.newRole.quickCycle = !S.newRole.quickCycle; render(); break;
      case 'nr-save': {
        const nr = S.newRole;
        if (!nr.id || !/^[a-z][a-z0-9-]*$/.test(nr.id)) { toast('Role ID 必填：小写字母开头，如 review', 'alert'); return; }
        if (MR.role(nr.id)) { toast(`角色 @${nr.id} 已存在`, 'alert'); return; }
        MR.roles.push({
          id: nr.id, alias: '@' + nr.id, name: nr.name || nr.id,
          desc: '自定义角色', builtin: false,
          primary: nr.primary, thinking: nr.thinking === 'off' ? null : nr.thinking,
          scope: 'global', fallbacks: [], fallbackOn: false, recovery: 'cooldown'
        });
        if (nr.quickCycle) MR.cycleOrder.push(nr.id);
        S.dialog = null;
        toast(`已创建角色 @${nr.id}`, 'check');
        openDetail(nr.id);
        break;
      }
      case 'assign-pick': {
        const role = MR.role(t.dataset.id);
        role.primary = S.assignSel;
        role.scope = role.scope || 'global';
        S.dialog = null;
        S.flash = null;
        openDetail(role.id, { flash: null });
        toast(`已将 ${S.assignSel} 设为 ${role.alias} 的 Primary Model`, 'check');
        break;
      }
      case 'dialog-close': S.dialog = null; render(); break;
    }
  }

  /* ---------------- 场景 ---------------- */
  function applyScenario(s) {
    const map = {
      'overview': () => {},
      'default': () => openDetail('default'),
      'smol': () => openDetail('smol'),
      'slow': () => openDetail('slow'),
      'vision': () => openDetail('vision'),
      'advisor': () => openDetail('advisor'),
      'global': () => openDetail('commit'),                    /* Global 配置示例 */
      'project': () => openDetail('slow'),                     /* Project Override 示例 */
      'restore-global': () => openDetail('slow', { dialog: 'restore-global' }),
      'fallback-add': () => openDetail('default'),
      'fallback-multi': () => openDetail('default'),
      'custom-new': () => { S.dialog = 'new-role'; },
      'cycle': () => { S.cycleEdit = true; S.cycleDraft = MR.cycleOrder.slice(); },
      'unavailable': () => openDetail('docs'),                 /* 模型不存在 */
      'provider-unauth': () => openDetail('designer'),         /* Provider 未认证 */
      'model-disabled': () => openDetail('task'),              /* 模型被禁用 */
      'yaml': () => {},
      'yaml-error': () => {
        S.sourceMode = true;
        S.yamlText = MR.configYml(MR.roles, MR.cycleOrder).replace('anthropic/claude-opus-4.8', 'anthropic/claude-opus-9');
        S.yamlError = true;
      }
    };
    (map[s] || map['overview'])();
    render();
  }

  /* ---------------- 面板注册 ----------------
     与 providers 面板对称：不再自己监听 DOMContentLoaded / 读 hash，
     改为暴露钩子由 page-model-config.js 调度。

     openAssign() 取代了原来的 roles.html#assign=… 跨页深链 —— 之前从
     供应商页点「分配给角色」是一次整页跳转，会把正在编辑的供应商草稿
     整个丢掉；现在只是切 tab + 开对话框，草稿还在。 */
  OMP.modelConfig = OMP.modelConfig || {};
  OMP.modelConfig.roles = {
    mount() {
      /* 挂载标记记在根节点上（随 innerHTML 销毁重置），而不是模块级闭包：
         离开页面再回来时模板重新注入，新根节点无标记，mount 重新执行。
         记在闭包里会让「已挂载」跨销毁存活，回来后内容区空白。 */
      const root = $('#roleRoot');
      if (!root) return;
      if (root._mcMounted) return;
      root._mcMounted = true;
      root.addEventListener('click', onAction);
      render();
    },
    render,
    openRole(roleId) {
      const r = MR.role(roleId);
      if (!r) { this.mount(); return false; }
      this.mount();
      openDetail(r.id);
      return true;
    },
    /* 带一个 model selector 进来，直接打开「选择角色」对话框。 */
    openAssign(sel) {
      this.mount();
      const { provider } = MR.findModel(sel);
      if (!provider) return false;
      S.assignSel = sel;
      S.dialog = 'assign';
      render();
      return true;
    },
    scenario(s) { this.mount(); applyScenario(s); }
  };
})();
