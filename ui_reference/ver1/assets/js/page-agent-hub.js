/* ============================================================
   OMP Studio — Agent Hub 页（全新实现，2026-08-11）
   对齐 OMP（oh-my-pi, vendor pin 45e12e5）docs/agent-hub.md 真实行为：
   · 主 Agent 不在列表（顶部 banner 卡 = ambient session 视图）
   · AgentStatus = running | idle | parked | aborted；aborted 终态不可 revive
   · advisor 只读（不可 message / revive / kill）
   · 操作：open / chat（steer=prompt 路径，parked 自动 revive）/ revive（仅 parked）
     / kill（abort + tombstone）/ flat·tree 切换 / jobs cancel（owner-scoped）/ IRC send
   · Limited Runtime：hub.chat / hub.revive / jobs.cancel 缺失 → 禁用并显式标注
   数据：OMP_DATA.hub（mock-data.js）。持久化：localStorage omp.agentHub.state。
   ============================================================ */
(function () {
  const D = window.OMP_DATA;
  if (!D || !D.hub) return;
  const HUB = D.hub;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const icon = OMP.icon;
  const toast = (t, i) => OMP.ui.toast(t, i);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- 页内状态 ---------------- */
  const LS_KEY = 'omp.agentHub.state';
  const SS_INTENT = 'omp.hubIntent';
  const S = {
    selected: null, tab: 'overview', view: 'flat', query: '',
    runtime: 'full',                 // full | limited
    conn: 'online',                  // online | offline | reconnecting | stale | resync
    scanned: true,                   // resync 扫描完成
    notice: null,                    // 详情内联提示 { kind:'ok'|'warn'|'err', text }
    dead: new Set(),                 // 本页会话内 kill 的墓碑
    cancelledJobs: new Set(),
    jobsTab: 'mine',
    intents: {},                     // agentId -> 待发草稿
    drawerOpen: false,               // 移动端详情抽屉（<900px）
    booted: false                    // 首屏骨架
  };
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    ['selected', 'tab', 'view', 'runtime'].forEach(k => { if (saved[k] != null) S[k] = saved[k]; });
  } catch (e) {}
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        selected: S.selected, tab: S.tab, view: S.view, runtime: S.runtime
      }));
    } catch (e) {}
  }

  /* ---------------- 格式化（对齐 agent-hub-renderer） ---------------- */
  function fmtAge(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (!isFinite(s)) return '—';
    if (s < 5) return '刚刚';
    if (s < 60) return s + 's 前';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm 前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h 前';
    const d = Math.floor(h / 24);
    if (d < 30) return d + 'd 前';
    return Math.floor(d / 30) + 'mo 前';
  }
  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (!isFinite(s)) return '—';
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return rs ? m + 'm ' + rs + 's' : m + 'm';
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? h + 'h ' + rm + 'm' : h + 'h';
  }
  function fmtCost(c) {
    if (c == null) return '—';
    if (c < 0.01) return '$' + c.toFixed(4);
    if (c < 1) return '$' + c.toFixed(3);
    return '$' + c.toFixed(2);
  }
  function fmtNum(n) {
    if (n == null) return '0';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function fmtMetrics(m) {
    if (!m) return 'usage —';
    return fmtCost(m.cost) + ' · ' + fmtDur(m.durationMs) + ' · ' + m.requests + ' req · ' +
      m.tools + ' tools · ' + fmtNum(m.tokens) + ' tok';
  }
  function fmtClock(ts) {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  const fmtHM = ts => fmtClock(ts).slice(0, 5);

  /* ---------------- 派生 ---------------- */
  const STATUS_LABEL = { running: 'running', idle: 'idle', parked: 'parked', aborted: 'aborted' };
  const STATUS_DOT = { running: 'green pulse', idle: 'blue', parked: 'gray', aborted: 'red' };
  function isDead(a) { return S.dead.has(a.id) || a.status === 'aborted'; }
  function effStatus(a) { return isDead(a) ? 'aborted' : a.status; }
  function waiting(a) { return a.status === 'idle' && a.activity === 'waiting'; }
  function isAdvisor(a) { return a && a.kind === 'advisor'; }
  function agentById(id) { return HUB.agents.find(a => a.id === id); }
  function missingCap(cap) {
    return S.runtime === 'limited' && ['hub.chat', 'hub.revive', 'jobs.cancel'].includes(cap);
  }
  function activityPill(a) {
    if (isDead(a)) return { cls: 'aborted', label: 'Aborted' };
    switch (a.status) {
      case 'running': return a.activity === 'tool'
        ? { cls: 'tool', label: a.currentTool ? 'Running Tool · ' + a.currentTool.name : 'Running Tool' }
        : { cls: 'thinking', label: 'Thinking' };
      case 'idle':
        if (waiting(a)) return { cls: 'waiting', label: 'Waiting for User' };
        if (a.activity === 'failed') return { cls: 'aborted', label: 'Failed' };
        return { cls: 'idle', label: 'Idle' };
      case 'parked': return { cls: 'parked', label: 'Parked' };
      default: return { cls: 'parked', label: a.status };
    }
  }
  function visibleAgents() {
    if (S.conn === 'resync' && !S.scanned) return [];
    return HUB.agents.filter(a =>
      !(S.conn === 'resync' && a.id === 'agent-019fc8a0' && !S.revivedShown));
  }
  function filtered() {
    let rows = visibleAgents();
    const q = S.query.trim().toLowerCase();
    if (q) rows = rows.filter(a =>
      (a.name + ' ' + a.id + ' ' + a.task + ' ' + (a.resolvedModel || '')).toLowerCase().includes(q));
    return rows;
  }
  /* Flat 排序：STATUS_ORDER → lastActivity 降序 → id（对齐 OMP registry） */
  function sortFlat(rows) {
    const order = { running: 0, idle: 1, parked: 2, aborted: 3 };
    return rows.slice()
      .sort((x, y) => (order[effStatus(x)] - order[effStatus(y)]) ||
        (y.lastActivity - x.lastActivity) || (x.id < y.id ? -1 : 1));
  }
  /* 树状排序：状态点列宽度一致，按 lastActivity 降序对齐 */
  function sortTree(rows) {
    return rows.slice()
      .sort((x, y) => (y.lastActivity - x.lastActivity) || (x.id < y.id ? -1 : 1));
  }
  /* 树状分组：parent 组（父在结果集内、父≠main、父自身无可见父）+ 孤儿整卡。
     子 agent 若父级被搜索过滤掉，自动升级为孤儿（不悬空）。 */
  function treeGroups(rows) {
    const byId = {}; rows.forEach(a => { byId[a.id] = a; });
    const hasVisParent = a => a.parentId && a.parentId !== 'main' && byId[a.parentId];
    const isGroupHead = a => !hasVisParent(a) && rows.some(x => x.parentId === a.id);
    const heads = sortTree(rows.filter(isGroupHead));
    const used = new Set(heads.map(h => h.id));
    const groups = heads.map(h => {
      const kids = sortTree(rows.filter(x => x.parentId === h.id));
      kids.forEach(k => used.add(k.id));
      return { head: h, kids };
    });
    const orphans = sortTree(rows.filter(a => !used.has(a.id)));
    return { groups, orphans };
  }
  function aggregate(rows) {
    const m = { cost: 0, durationMs: 0, requests: 0, tools: 0, tokens: 0, timed: 0, measured: 0 };
    rows.forEach(a => {
      if (!a.metrics) return;
      m.measured++;
      if (a.metrics.durationKind && a.metrics.durationKind !== 'unknown') m.timed++;
      m.cost += a.metrics.cost || 0;
      m.durationMs += a.metrics.durationMs || 0;
      m.requests += a.metrics.requests || 0;
      m.tools += a.metrics.tools || 0;
      m.tokens += a.metrics.tokens || 0;
    });
    return m;
  }

  /* ---------------- 能力矩阵（OMP 真实边界） ---------------- */
  function caps(a) {
    if (!a) return {};
    const st = effStatus(a);
    const ro = isAdvisor(a);
    const noFile = !a.sessionFile;
    const off = S.conn !== 'online';
    return {
      open: !isDead(a) && !noFile && !off,
      openWhy: isDead(a) ? 'aborted 为终态' : noFile ? '暂无 sessionFile' : off ? 'runtime 未连接' : null,
      chat: !ro && !isDead(a) && !noFile && !off && !missingCap('hub.chat'),
      chatWhy: ro ? 'advisor 是只读观察记录' : isDead(a) ? 'aborted 为终态' :
        noFile ? '暂无 sessionFile' : off ? 'runtime 未连接' :
        missingCap('hub.chat') ? 'Limited Runtime 未协商 hub.chat' : null,
      revive: st === 'parked' && !ro && !off && !missingCap('hub.revive'),
      reviveWhy: ro ? 'advisor 只读' : st !== 'parked' ? '仅 parked 可 revive' :
        off ? 'runtime 未连接' : missingCap('hub.revive') ? 'Limited Runtime 未协商 hub.revive' : null,
      kill: !ro && !isDead(a) && !off,
      killWhy: ro ? 'advisor 只读' : isDead(a) ? '已是终态' : off ? 'runtime 未连接' : null
    };
  }

  /* ================================================================
     渲染
     ================================================================ */
  function pageHtml() {
    if (!S.booted) {
      return `<div class="card" style="padding:var(--sp-14)">
        <div class="skeleton" style="height:18px;width:40%"></div>
        <div class="skeleton" style="height:12px;width:70%;margin-top:10px"></div>
        <div class="skeleton" style="height:88px;margin-top:14px"></div>
        <div class="skeleton" style="height:220px;margin-top:14px"></div></div>`;
    }
    return [connHtml(), mainHtml(), rosterHeadHtml(), usageHtml(), colsHtml()]
      .filter(Boolean).join('');
  }

  function connHtml() {
    switch (S.conn) {
      case 'offline':
        return `<div class="hub-conn red">${icon('alert', 'sm')}<b>Runtime 离线</b>
          <span class="hc-detail">无法连接 OMP runtime。列表为最后一次已知状态；所有写操作已禁用。</span>
          <span class="hc-actions"><button class="btn small outline" data-act="conn-retry">重试连接</button></span></div>`;
      case 'reconnecting':
        return `<div class="hub-conn amber"><span class="spinner"></span><b>正在重连</b>
          <span class="hc-detail">与 runtime 的连接中断，正在重试… roster 为最后一次同步的快照。</span>
          <span class="hc-actions"><button class="btn small outline" data-act="conn-retry">立即重试</button></span></div>`;
      case 'stale':
        return `<div class="hub-conn amber">${icon('clock', 'sm')}<b>快照可能过期</b>
          <span class="hc-detail">距上次同步已超过阈值，状态计数与 age 不再可信。</span>
          <span class="hc-actions"><button class="btn small outline" data-act="conn-retry">立即同步</button></span></div>`;
      case 'resync':
        return S.scanned
          ? `<div class="hub-conn blue">${icon('refresh', 'sm')}<b>重新同步完成</b>
            <span class="hc-detail">从持久化 registry 扫描完成：复活 1 个 parked agent（agent-019fc8a0），无新增 tombstone。</span>
            <span class="hc-actions"><button class="btn small outline" data-act="conn-ok">知道了</button></span></div>`
          : `<div class="hub-conn blue"><span class="spinner"></span><b>状态回源中</b>
            <span class="hc-detail">正在扫描持久化 registry（saved agents / tombstones）…</span></div>`;
      default: return '';
    }
  }

  function mainHtml() {
    const m = HUB.main;
    const limited = S.runtime === 'limited';
    const connOn = S.conn === 'online';
    return `<div class="hub-main">
      <span class="hm-ic">${icon('message')}</span>
      <div class="hm-main">
        <div class="hm-title">${esc(m.name)}<span class="chip blue xs">${esc(m.statusText)}</span></div>
        <div class="hm-sub">
          <span class="hm-task ellipsis">${esc(m.task)}</span>
          <span class="hm-meta mono">${esc(m.model)} · ${fmtDur(m.durationMs)} · ctx ${m.contextPct}%</span>
          <span class="hm-meta mono hm-conn">${esc(limited ? 'Limited Runtime' : HUB.runtime.label)}
            <span class="hm-dot${connOn ? ' on' : ''}"></span>${connOn ? '已连接' : '未连接'} · 更新于 <span id="hubUpdated">${fmtClock(Date.now())}</span></span>
        </div>
      </div>
      <div class="hm-actions">
        <button class="btn small primary" data-act="open-main">${icon('external', 'sm')}打开主对话</button>
      </div>
    </div>`;
  }

  function rosterHeadHtml() {
    const rows = visibleAgents();
    const counts = {};
    rows.forEach(a => { const s = effStatus(a); counts[s] = (counts[s] || 0) + 1; });
    const countHtml = ['running', 'idle', 'parked', 'aborted'].filter(k => counts[k])
      .map(k => `<span class="sc-item"><span class="dot ${STATUS_DOT[k]}"></span>${counts[k]} ${STATUS_LABEL[k]}</span>`).join('');
    return `<div class="hub-roster-head">
      <div class="seg" role="group" aria-label="Roster 视图">
        <button class="${S.view === 'flat' ? 'active' : ''}" data-act="view-flat">Flat</button>
        <button class="${S.view === 'tree' ? 'active' : ''}" data-act="view-tree">By parent</button>
      </div>
      <div class="hub-status-counts">${S.conn === 'resync' && !S.scanned
        ? '<span class="hub-loading-row"><span class="spinner"></span>Loading saved agents…</span>' : countHtml}</div>
      <span class="spacer"></span>
      <input class="input hub-search" type="search" placeholder="搜索 id / 名称 / 任务 / 模型…"
        aria-label="搜索 Agent" value="${esc(S.query)}" data-hub-search>
    </div>`;
  }

  function usageHtml() {
    const rows = filtered();
    if (!rows.length) return '';
    const m = aggregate(rows);
    const btn = `<button class="btn small primary" data-act="new-agent">${icon('plus', 'sm')}New Agent</button>`;
    const text = m.measured
      ? `${fmtCost(m.cost)} · ${fmtDur(m.durationMs)} active agent time · ${m.requests} req · ${m.tools} tools · ${fmtNum(m.tokens)} tok · ${m.timed}/${m.measured} timed · ${m.measured}/${rows.length} measured`
      : `Usage — · 0/${rows.length} measured`;
    return `<div class="hub-usage"><span>${text}</span><span class="spacer"></span>${btn}</div>`;
  }

  function colsHtml() {
    return `<div class="hub-cols">
      <div class="hub-list${S.view === 'tree' ? ' tree' : ''}" id="hubList" role="listbox" aria-label="子 Agent 列表">${listHtml()}</div>
      ${detailHtml()}
    </div>`;
  }

  /* ---------------- 行渲染（卡片 + 树状节点） ---------------- */
  function sparkSvg(n, tone) {
    const parts = [1, 2, 3].map(i =>
      `<rect class="hb-bar${i <= n ? ' hot' : ''}" x="${(i - 1) * 5}" y="${8 - i * 2}" width="3" height="${i * 2}" rx="1"/>`).join('');
    return `<svg class="hc-spark${tone ? ' ' + tone : ''}" width="13" height="8" viewBox="0 0 13 8" aria-hidden="true">${parts}</svg>`;
  }
  function artChips(a) {
    return [a.outputPath && 'out', a.patchPath && 'patch', a.branchName && 'branch']
      .filter(Boolean).map(x => `<span class="hub-art">${x}</span>`).join('');
  }
  function flagChips(a, kids) {
    return [
      a.ircUnread ? `<span class="hub-unread" data-tip="${a.ircUnread} 条未读 IRC 消息">${icon('message', 'sm')}${a.ircUnread}</span>` : '',
      a.readOnly ? '<span class="hub-ro-tag">read-only</span>' : '',
      kids ? `<span class="hub-ro-tag" data-tip="子 Agent：${esc(a.children.join('、'))}">↳ ${kids} 子</span>` : ''
    ].join('');
  }

  /* Flat 整卡：左 = 身份+任务（pill/名/状态点 + task + 角色/模型/chip）；
     右 = 用量栏（右上 = 运行开始时刻 HH:MM，其下 tokens 主显 + req·tools 安静行，
     成本降级为最底小字 —— 优先级：tokens > 运行节奏 > 成本）。
     id 不再上卡（详情/overview 可查）。 */
  function cardHtml(a, kids) {
    const st = effStatus(a);
    const pill = activityPill(a);
    const sel = S.selected === a.id;
    const m = a.metrics;
    const model = a.fallback
      ? `<span class="hub-model hub-fallback">fallback → ${esc(a.fallback)}</span>`
      : `<span class="hub-model">${esc(a.resolvedModel || '—')}</span>`;
    const flags = flagChips(a, kids);
    return `<button class="hub-card${sel ? ' sel' : ''}" role="option" aria-selected="${sel}" data-row="${esc(a.id)}">
      <span class="hc-main">
        <span class="hc-top">
          <span class="hub-act ${pill.cls}">${esc(pill.label)}</span>
          <span class="hc-name"><span class="hub-sd ${st}${st === 'running' ? ' pulse' : ''}" aria-hidden="true"></span><span>${esc(a.name)}</span></span>
          ${flags ? `<span class="hc-flags">${flags}</span>` : ''}
        </span>
        <span class="hc-task">${esc(a.task)}</span>
        <span class="hc-foot">
          <span class="hub-role">${esc(a.modelRole || '')}</span>
          ${model}
          <span class="hc-art">${artChips(a)}</span>
        </span>
      </span>
      <span class="hc-side">
        <span class="hc-start" data-tip="运行开始时刻 · 已运行 ${fmtDur(a.metrics ? a.metrics.durationMs : 0)}">${icon('clock', 'sm')}${fmtHM(a.createdAt)}</span>
        ${m ? `<span class="hc-tokens"><b>${fmtNum(m.tokens)}</b><i>tok</i>${sparkSvg(Math.max(1, Math.min(3, Math.round(m.tokens / 40000))))}</span>` : ''}
        ${m ? `<span class="hc-pace"><span class="hub-num"><i>req</i><b>${m.requests}</b></span><span class="hub-num"><i>tools</i><b>${m.tools}</b></span></span>` : ''}
        ${m ? `<span class="hc-cost">${fmtCost(m.cost)}</span>` : '<span class="hc-cost">usage —</span>'}
      </span>
    </button>`;
  }

  /* 树状叶子：透明节点，左缘状态色条，信息精简 */
  function nodeHtml(a) {
    const st = effStatus(a);
    const pill = activityPill(a);
    const sel = S.selected === a.id;
    const m = a.metrics;
    const model = a.fallback ? `fallback → ${a.fallback}` : (a.resolvedModel || '—');
    return `<button class="hub-node st-${st}${sel ? ' sel' : ''}" role="option" aria-selected="${sel}" data-row="${esc(a.id)}">
      <span class="hn-top">
        <span class="hub-act ${pill.cls}">${esc(pill.label)}</span>
        <span class="hn-name"><span class="hub-sd ${st}${st === 'running' ? ' pulse' : ''}" aria-hidden="true"></span><span>${esc(a.name)}</span></span>
        ${flagChips(a, 0) ? `<span class="hn-flags">${flagChips(a, 0)}</span>` : ''}
        ${m ? `<span class="hn-cost">${fmtCost(m.cost)}</span>` : ''}
      </span>
      <span class="hn-task">${esc(a.task)}</span>
      <span class="hn-foot">
        <span class="hub-role">${esc(a.modelRole || '')}</span>
        <span class="mono">${esc(model)}</span>
        <span data-age="${a.lastActivity}">${fmtAge(a.lastActivity)}</span>
        <span class="hn-art">${artChips(a)}</span>
      </span>
    </button>`;
  }

  /* 树状组头：父 agent 摘要卡（可点选进详情），下方竖线引出子级 */
  function treeGroupHtml(head, kids) {
    const st = effStatus(head);
    const pill = activityPill(head);
    const sel = S.selected === head.id;
    return `<div class="hub-tgroup">
      <button class="hub-tg-head${sel ? ' sel' : ''}" role="option" aria-selected="${sel}" data-row="${esc(head.id)}">
        <span class="tg-ic">${icon('bot', 'sm')}</span>
        <span class="hub-act ${pill.cls}">${esc(pill.label)}</span>
        <span class="tg-name"><span class="hub-sd ${st}${st === 'running' ? ' pulse' : ''}" aria-hidden="true"></span><span>${esc(head.name)}</span></span>
        <span class="tg-task">${esc(head.task)}</span>
        <span class="tg-right">
          ${flagChips(head, kids.length)}
          <span class="tg-cost">${fmtCost(aggregate([head].concat(kids)).cost)}</span>
          <span class="tg-caret">${icon('chevron-d', 'sm')}</span>
        </span>
      </button>
      <div class="hub-tchildren">
        <span class="hub-trail" aria-hidden="true"></span>
        <div class="hub-tleaves">${kids.map(nodeHtml).join('')}</div>
      </div>
    </div>`;
  }

  function listHtml() {
    const rows = filtered();
    if (S.conn === 'resync' && !S.scanned) {
      return `<div class="hub-loading-row"><span class="spinner"></span>正在扫描持久化 registry…</div>`;
    }
    if (!rows.length) {
      return `<div class="hub-empty-list">${icon('bot')}
        <b>No agents in this session</b>
        <span>Finished, parked, and killed subagents remain with the session that created them.</span>
        <span class="tiny">Resume that session with <span class="mono">omp --continue</span>, or spawn a task here.</span>
        <button class="btn small primary" data-act="new-agent">${icon('plus', 'sm')}New Agent</button>
      </div>`;
    }
    let body;
    if (S.view === 'tree') {
      const t = treeGroups(rows);
      const childIds = {}; t.groups.forEach(g => g.kids.forEach(k => { childIds[k.id] = 1; }));
      body = t.groups.map(g => treeGroupHtml(g.head, g.kids)).join('') +
        t.orphans.map(a => cardHtml(a, a.children.filter(id => !childIds[id]).length)).join('');
    } else {
      body = sortFlat(rows).map(a => cardHtml(a, a.children.length)).join('');
    }
    return body + `<div class="hub-kbd-hint">j/k 选择 · Enter 打开 · r revive · x kill · t 切换视图</div>`;
  }

  /* ---------- 详情 ---------- */
  function detailHtml() {
    const a = agentById(S.selected);
    /* 选中项必须仍在可见列表里：被搜索/场景过滤掉时详情不再显示它，避免"看不着却改得着"。 */
    const visible = a && visibleAgents().some(x => x.id === a.id);
    if (!a || !visible) {
      return `<div class="hub-detail hub-detail-placeholder">
        <div class="hub-empty-list" style="border:none">${icon('cursor')}
          <b>未选择 Agent</b><span>从左侧列表选择一个子 Agent 查看详情。</span></div>
      </div>`;
    }
    const st = effStatus(a);
    const c = caps(a);
    const pill = activityPill(a);
    const tabs = [['overview', 'Overview'], ['transcript', 'Transcript'], ['jobs', 'Jobs'], ['messages', 'Messages']];
    return `<div class="hub-detail${S.drawerOpen ? ' open' : ''}" id="hubDetail">
      <div class="hub-detail-head">
        <div class="hd-title">
          <button class="icon-btn small hub-drawer-back" data-act="drawer-back" data-tip="返回列表">${icon('arrow-l', 'sm')}</button>
          <b>${esc(a.name)}</b><span class="mono tiny muted">${esc(a.id)}</span>
          <span class="chip ${a.kind === 'advisor' ? 'gray' : 'purple'} xs">${a.kind}</span>
          ${a.parentId ? `<span class="tiny muted">of ${esc(a.parentId)}</span>` : ''}
          <span class="spacer"></span>
          <span class="hub-act ${pill.cls}">${esc(pill.label)}</span>
        </div>
        <div class="hd-sub">
          <span class="hub-status-line"><span class="dot ${STATUS_DOT[st]}"></span>${STATUS_LABEL[st]} · ${fmtDur(a.metrics ? a.metrics.durationMs : 0)} · active <span data-age="${a.lastActivity}">${fmtAge(a.lastActivity)}</span></span>
          <span class="hub-role">${esc(a.modelRole || '')}</span>
          ${a.fallback ? `<span class="hub-model hub-fallback">fallback → ${esc(a.fallback)}</span>` : `<span class="hub-model">${esc(a.resolvedModel || '—')}</span>`}
        </div>
      </div>
      <div class="hub-detail-actions">
        <button class="btn small primary" data-act="open-agent" ${c.open ? '' : 'disabled'} ${c.openWhy ? `data-tip="${esc(c.openWhy)}"` : ''}>${icon('external', 'sm')}打开</button>
        <button class="btn small outline" data-act="chat-agent" ${c.chat ? '' : 'disabled'} ${c.chatWhy ? `data-tip="${esc(c.chatWhy)}"` : ''}>${icon('message', 'sm')}发消息</button>
        <button class="btn small outline" data-act="revive-agent" ${c.revive ? '' : 'disabled'} ${!c.revive && c.reviveWhy ? `data-tip="${esc(c.reviveWhy)}"` : ''}>${icon('refresh', 'sm')}Revive</button>
        <button class="btn small danger" data-act="kill-agent" ${c.kill ? '' : 'disabled'} ${!c.kill && c.killWhy ? `data-tip="${esc(c.killWhy)}"` : ''}>${icon('stop', 'sm')}Kill</button>
      </div>
      <div class="hub-detail-tabs">
        <div class="tabs" role="tablist" aria-label="Agent 详情" id="hubTabs">
          ${tabs.map(t => `<button role="tab" data-tab="${t[0]}" class="${S.tab === t[0] ? 'active' : ''}"
            aria-selected="${S.tab === t[0]}" tabindex="${S.tab === t[0] ? '0' : '-1'}">${t[1]}</button>`).join('')}
        </div>
      </div>
      <div class="hub-detail-body" id="hubDetailBody">${noticeHtml()}${tabHtml(a)}</div>
    </div>`;
  }
  function noticeHtml() {
    if (!S.notice) return '';
    const cls = S.notice.kind === 'ok' ? 'green' : S.notice.kind === 'warn' ? 'amber' : 'red';
    return `<div class="hub-notice" style="background:var(--${cls}-soft);color:var(--${cls})">${icon(S.notice.kind === 'ok' ? 'check' : 'alert', 'sm')}<span>${esc(S.notice.text)}</span></div>`;
  }
  function tabHtml(a) {
    switch (S.tab) {
      case 'transcript': return transcriptHtml(a);
      case 'jobs': return jobsHtml(a);
      case 'messages': return messagesHtml(a);
      default: return overviewHtml(a);
    }
  }

  function kv(k, v, mono) {
    return `<div class="kv"><div class="k">${k}</div><div class="v${mono ? ' mono' : ''}">${v}</div></div>`;
  }
  function overviewHtml(a) {
    const m = a.metrics;
    const ctxPct = m && m.contextWindow ? Math.round(m.contextTokens / m.contextWindow * 100) : null;
    const changes = isAdvisor(a) || a.readOnly ? 'Read-only · 0 LoC' : 'Shared workspace · per-agent LoC not attributable';
    return `
      <div class="hub-sec-title">Task</div>
      <div class="hub-kv">${kv('Task', esc(a.task))}</div>
      <div class="hub-sec-title">Current</div>
      <div class="hub-kv">
        ${a.currentTool ? kv('Tool', `<span class="chip blue xs">${esc(a.currentTool.name)}</span> ${esc(a.currentTool.args || '')}`) : ''}
        ${a.lastIntent ? kv('Last intent', esc(a.lastIntent)) : ''}
        ${a.retryState ? kv('Retry', `<span style="color:var(--amber)">retry ${a.retryState.attempt}/${a.retryState.maxAttempts}</span> · ${esc(a.retryState.errorMessage || '')}`) : ''}
        ${!a.currentTool && !a.lastIntent && !a.retryState ? kv('—', '无进行中的工具调用') : ''}
      </div>
      <div class="hub-sec-title">Usage</div>
      <div class="hub-kv">
        ${kv('Metrics', `<span class="mono">${fmtMetrics(m)}</span>`)}
        ${ctxPct != null ? `<div class="kv"><div class="k">Context</div><div class="v"><div class="hub-ctx">
          <div class="meter${ctxPct > 80 ? ' danger' : ctxPct > 60 ? ' warn' : ''}"><i style="width:${ctxPct}%"></i></div>
          <span class="mono">${fmtNum(m.contextTokens)} / ${fmtNum(m.contextWindow)} · ${ctxPct}%</span></div></div></div>` : ''}
      </div>
      <div class="hub-sec-title">Lineage</div>
      <div class="hub-kv">
        ${kv('Spawned by', esc(a.parentId || 'main'))}
        <div class="kv"><div class="k">Children</div><div class="v">${a.children.length
          ? `<span class="hub-lineage-row">${a.children.map(id =>
              `<a class="hub-child-link" href="#!agent-hub" data-child="${esc(id)}">${icon('bot', 'sm')}${esc(id)}</a>`).join('')}</span>`
          : '0 children'}</div></div>
        ${kv('Registered', `<span class="mono">${new Date(a.createdAt).toISOString()}</span>`, true)}
      </div>
      <div class="hub-sec-title">Changes</div>
      <div class="hub-kv">
        ${kv('Mode', esc(changes))}
        ${a.outputPath ? kv('Output', `<a href="#!agent-hub" data-artifact="agent://${esc(a.id)}">${esc(a.outputPath)}</a> <span class="tiny muted">agent://${esc(a.id)}</span>`, true) : ''}
        ${a.patchPath ? kv('Patch', esc(a.patchPath), true) : ''}
        ${a.branchName ? kv('Worktree branch', esc(a.branchName), true) : ''}
      </div>`;
  }

  function transcriptHtml(a) {
    const msgs = HUB.transcripts[a.id] || [];
    const c = caps(a);
    const body = a.hasTranscript && msgs.length
      ? msgs.map(t => `<div class="hub-tr-msg ${t.role}">
          <div class="tr-head"><span class="tr-role">${esc({ user: '用户', assistant: a.name, tool: 'Tool', system: 'System' }[t.role] || t.role)}</span><span>${esc(t.time)}</span></div>
          <div class="tr-body">${esc(t.body)}</div>
        </div>`).join('')
      : `<div class="hub-empty-list" style="border:none;padding:var(--sp-24)">${icon('message')}<span>No messages yet.</span></div>`;
    const intent = S.intents[a.id] || '';
    const composer = c.chat
      ? `<div class="hub-send">
          <textarea class="input" rows="2" data-intent placeholder="${a.status === 'parked' ? '发送将先 revive 该 Agent，再走 prompt（steer）路径…' : '向该 Agent 发送消息（prompt · steer）…'}" aria-label="消息内容">${esc(intent)}</textarea>
          <button class="btn small primary" data-act="send-msg">${icon('send', 'sm')}发送</button>
        </div>
        <div class="send-hint">Enter 发送 · parked 自动 revive · steer 即 OMP 的 prompt 路径，无独立 message API</div>`
      : `<div class="hub-ro-banner">${icon('lock', 'sm')}<span>${esc(c.chatWhy || '该 Agent 为只读 transcript，不能发送消息。')}</span></div>`;
    return `<div class="hub-transcript" id="hubTranscript">${body}</div>${composer}`;
  }

  function jobsHtml(a) {
    const all = HUB.jobs;
    const mine = a.id === 'main' ? all : all.filter(j => j.ownerId === a.id);
    const jobs = S.jobsTab === 'all' ? all : mine;
    const rows = jobs.map(j => {
      const stChip = { running: 'blue', completed: 'green', failed: 'red', cancelled: 'gray' }[j.status];
      const cancellable = j.status === 'running' && j.ownerId === a.id && !S.cancelledJobs.has(j.id);
      const canCancel = cancellable && !missingCap('jobs.cancel') && S.conn === 'online';
      return `<div class="hub-job">
        <span class="a-ic ${j.type === 'bash' ? 'blue' : 'purple'}" aria-hidden="true">${icon(j.type === 'bash' ? 'terminal' : 'bot', 'sm')}</span>
        <div class="jb-label"><span class="ellipsis" style="display:block">${esc(j.label)}</span>
          <span class="mono">${esc(j.id)} · ${j.type} · ${fmtDur(j.durationMs)}${j.ownerId !== a.id ? ' · owner ' + esc(j.ownerId) : ''}</span>
          ${j.errorText ? `<span class="mono" style="color:var(--red)">${esc(j.errorText)}</span>` : ''}
          ${j.resultText ? `<span class="mono" style="color:var(--green)">${esc(j.resultText)}</span>` : ''}
        </div>
        <span class="chip ${stChip} xs">${j.status}</span>
        ${cancellable ? `<button class="btn small outline" data-act="cancel-job" data-job="${esc(j.id)}" ${canCancel ? '' : 'disabled'}
            ${!canCancel ? `data-tip="${esc(missingCap('jobs.cancel') ? 'Limited Runtime 未协商 jobs.cancel' : 'runtime 未连接')}"` : ''}>取消</button>` : ''}
      </div>`;
    }).join('');
    return `<div class="seg" role="group" aria-label="Jobs 范围" style="margin-bottom:var(--sp-10)">
        <button class="${S.jobsTab === 'mine' ? 'active' : ''}" data-act="jobs-mine">该 Agent</button>
        <button class="${S.jobsTab === 'all' ? 'active' : ''}" data-act="jobs-all">全部</button>
      </div>
      ${missingCap('jobs.cancel') ? `<div class="hub-cap-note" style="margin-bottom:var(--sp-8)">${icon('lock', 'sm')}jobs.cancel 未协商：取消操作不可用（owner-scoped）</div>` : ''}
      ${rows || `<div class="hub-empty-list" style="border:none;padding:var(--sp-24)">${icon('terminal')}<span>没有${S.jobsTab === 'mine' ? '该 Agent 的' : ''} job</span></div>`}`;
  }

  function messagesHtml(a) {
    const msgs = HUB.irc.filter(m => m.from === a.id || m.to === a.id);
    const list = msgs.map(m => `<div class="hub-irc-msg">
        <span class="im-dir ${m.dir}">${m.dir === 'in' ? '←' : '→'}</span>
        <div class="im-main">
          <div class="im-meta"><span class="mono">${esc(m.from)} → ${esc(m.to)}</span><span>${fmtAge(m.time)}</span>
            ${m.outcome ? `<span class="hub-outcome ${m.outcome}">${m.outcome}</span>` : ''}${m.read === false ? '<span class="chip amber xs">未读</span>' : ''}</div>
          <div class="im-body">${esc(m.text)}</div>
        </div>
      </div>`).join('');
    const can = caps(a).chat;
    return `${can ? `<div class="hub-irc-out">
        <div class="field"><input class="input" data-irc placeholder="经 hub 通道发消息（op=send，注入其 IRC 队列）…" aria-label="IRC 消息"></div>
        <button class="btn small primary" data-act="send-irc">${icon('send', 'sm')}发送</button>
      </div>` : `<div class="hub-ro-banner" style="margin:0 0 var(--sp-12)">${icon('lock', 'sm')}<span>${esc(caps(a).chatWhy || '只读')}</span></div>`}
      <div class="hub-irc-list">${list || `<div class="hub-empty-list" style="border:none;padding:var(--sp-24)">${icon('message')}<span>没有与该 Agent 的 IRC 往来</span></div>`}</div>`;
  }

  /* ================================================================
     渲染调度
     ================================================================ */
  function render() {
    const root = $('#hubRoot');
    if (!root) return;
    root.innerHTML = pageHtml();
    OMP.injectIcons(root);
    OMP.ui.labelIconButtons(root);
    const tr = $('#hubTranscript');
    if (tr) tr.scrollTop = tr.scrollHeight;
  }
  function renderBody() {
    const a = agentById(S.selected);
    const body = $('#hubDetailBody');
    if (body && a) {
      body.innerHTML = noticeHtml() + tabHtml(a);
      OMP.injectIcons(body);
      OMP.ui.labelIconButtons(body);
      const tr = $('#hubTranscript');
      if (tr) tr.scrollTop = tr.scrollHeight;
    }
  }

  /* age tick（OMP AGE_TICK_MS=5s） */
  setInterval(() => {
    if (document.body.dataset.page !== 'agent-hub') return;
    $$('[data-age]', $('#hubRoot')).forEach(el => {
      el.textContent = fmtAge(Number(el.getAttribute('data-age')));
    });
    const u = $('#hubUpdated');
    if (u && S.conn === 'online') u.textContent = '更新于 ' + fmtClock(Date.now());
  }, 5000);

  /* ================================================================
     操作
     ================================================================ */
  function select(id, opts) {
    S.selected = id;
    S.notice = null;
    if (window.innerWidth <= 900) S.drawerOpen = true;   // 移动端选中即滑入详情抽屉
    persist();
    render();
    if (opts && opts.scroll) {
      const row = $(`[data-row="${window.CSS && CSS.escape ? CSS.escape(id) : id}"]`);
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  function openChat(id) {
    S.tab = 'transcript';
    select(id);
    setTimeout(() => { const t = $('[data-intent]'); if (t) t.focus(); }, 30);
  }
  function revive(a) {
    const c = caps(a);
    if (!c.revive) {
      S.notice = { kind: 'warn', text: c.reviveWhy || '仅 parked agent 可以 revive' };
      renderBody(); return;
    }
    a.status = 'idle'; a.activity = 'idle';
    a.lastActivity = Date.now();
    S.notice = { kind: 'ok', text: `已 revive ${a.id}：session 重新 attach，状态 idle（TTL 重新计时）` };
    toast(`已 revive ${a.name}`, 'refresh');
    render();
  }
  function kill(a) {
    const c = caps(a);
    if (!c.kill) {
      S.notice = { kind: 'warn', text: c.killWhy || '不可 kill' };
      renderBody(); return;
    }
    modal({
      title: `Kill ${a.name}？`,
      body: `<div class="small" style="color:var(--text-2);line-height:1.6">
        将执行 OMP 的 kill 流程：<b>abort</b> 当前 turn，然后释放 registry 引用并写入
        <span class="mono">tombstone</span> 边车文件。agent 进入终态 <b>aborted</b>：
        保留在列表中可查 transcript，但<b>不可 revive</b>。</div>`,
      okText: 'Kill（abort + tombstone）', danger: true,
      onOk() {
        S.dead.add(a.id);
        a.lastActivity = Date.now();
        S.notice = { kind: 'ok', text: `已 kill ${a.id}：abort 完成，tombstone 已写入（终态）` };
        toast(`${a.name} 已终止（tombstone）`, 'stop');
        render();
      }
    });
  }
  function sendPrompt(a, text) {
    if (!text.trim()) return;
    const parkedFirst = a.status === 'parked';
    if (parkedFirst) {
      a.status = 'idle'; a.activity = 'idle'; a.lastActivity = Date.now();
    }
    (HUB.transcripts[a.id] = HUB.transcripts[a.id] || []).push(
      { role: 'user', time: fmtHM(Date.now()), body: text });
    S.intents[a.id] = '';
    S.notice = { kind: 'ok', text: (parkedFirst ? '已 revive 并发送：' : '已发送：') +
      'session.prompt(text, { streamingBehavior: "steer" })' };
    toast('消息已发送（steer）', 'send');
    render();
  }
  function sendIrc(a, text) {
    if (!text.trim()) return;
    HUB.irc.push({ dir: 'out', from: 'main', to: a.id, text, time: Date.now(), outcome: 'injected', read: true });
    toast('IRC 消息已注入（hub op=send）', 'send');
    renderBody();
  }
  function newAgentModal() {
    modal({
      title: 'New Agent',
      body: `<div class="hub-na-grid">
        <div class="hub-na-row"><div class="field"><label class="tiny muted" for="naTask">任务描述</label>
          <textarea class="input" id="naTask" rows="3" placeholder="例如：审计 pi-core 0.82.1 的 breaking changes…"></textarea></div></div>
        <div class="hub-na-row">
          <div class="field"><label class="tiny muted" for="naRole">Model role</label>
            <select class="select" id="naRole"><option>@smol</option><option>@worker</option><option>@writer</option><option>@vision</option><option>@audit</option></select></div>
          <div class="field"><label class="tiny muted" for="naCount">并发数量</label>
            <select class="select" id="naCount"><option>1</option><option>2</option><option>3</option></select></div>
        </div>
        <div class="tiny muted">对齐 OMP：spawn 即注册 registry（status=running），父级为当前主 Agent。</div>
      </div>`,
      okText: 'Spawn', onOk(m) {
        const task = $('#naTask', m).value.trim() || '未命名任务';
        const role = $('#naRole', m).value;
        const n = Number($('#naCount', m).value);
        for (let i = 0; i < n; i++) {
          const id = 'agent-' + Math.random().toString(16).slice(2, 10).padEnd(8, '0');
          HUB.agents.unshift({
            id, name: task.slice(0, 6) + ' 子 Agent', kind: 'sub', parentId: 'main',
            status: 'running', activity: 'thinking', task,
            currentTool: null, lastIntent: null, retryState: null,
            modelRole: role, resolvedModel: 'gemini-3.6-flash', fallback: null,
            metrics: { cost: 0, durationMs: 1000, durationKind: 'active', requests: 0, tools: 0, tokens: 0, contextTokens: 0, contextWindow: 128000 },
            readOnly: false, outputPath: null, patchPath: null, branchName: null,
            children: [], ircUnread: 0, sessionFile: id + '.jsonl',
            createdAt: Date.now(), lastActivity: Date.now(), hasTranscript: false
          });
        }
        toast(`已 spawn ${n} 个 Agent`, 'bot');
        render();
      }
    });
  }

  /* ---------------- modal（照抄 workbench openCheckpointModal 写法） ---------------- */
  function modal(opts) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <div class="modal-head"><b>${esc(opts.title)}</b>
        <button class="icon-btn small" data-x data-tip="关闭">${icon('x', 'sm')}</button></div>
      <div class="modal-body">${opts.body}</div>
      <div class="modal-foot">
        <button class="btn outline" data-x>取消</button>
        <button class="btn ${opts.danger ? 'danger solid' : 'primary'}" data-ok>${esc(opts.okText || '确定')}</button>
      </div></div>`;
    document.body.appendChild(wrap);
    OMP.injectIcons(wrap);
    OMP.ui.labelIconButtons(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', e => {
      if (e.target === wrap || e.target.closest('[data-x]')) close();
      else if (e.target.closest('[data-ok]')) { if (opts.onOk) opts.onOk(wrap); close(); }
    });
    wrap.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    const first = wrap.querySelector('textarea, input, select, [data-ok]');
    if (first) first.focus();
  }

  /* ---------------- 场景菜单 ---------------- */
  const SCENARIOS = [
    ['full', 'Full Parity Runtime（默认）'],
    ['limited', 'Limited Runtime（缺 hub.chat / hub.revive / jobs.cancel）'],
    ['offline', 'Runtime 离线'],
    ['reconnecting', '重连中'],
    ['stale', '快照过期（stale）'],
    ['resync', '重新同步（registry 扫描 → 复活 parked）'],
    ['empty', '空 roster']
  ];
  function scenarioMenu(anchor) {
    const m = OMP.ui.menu('<div class="menu-label">Agent Hub 演示场景（验收用）</div>' +
      SCENARIOS.map(s => `<button class="menu-item" data-sc="${s[0]}">
        <span class="sc-no">${(S.runtime === s[0] || S.conn === s[0]) ? '●' : ''}</span><span>${s[1]}</span></button>`).join(''));
    m.addEventListener('click', ev => {
      const sc = ev.target.closest('[data-sc]');
      if (!sc) return;
      applyScenario(sc.dataset.sc);
      OMP.ui.closeOverlay();
    });
    OMP.ui.openOverlay(m, anchor);
  }
  function applyScenario(sc) {
    S.notice = null;
    switch (sc) {
      case 'full': S.runtime = 'full'; S.conn = 'online'; S.query = ''; persist(); break;
      case 'limited': S.runtime = 'limited'; S.conn = 'online'; persist(); break;
      case 'offline': case 'reconnecting': case 'stale': S.conn = sc; break;
      case 'resync':
        S.conn = 'resync'; S.scanned = false; S.revivedShown = false;
        render();
        setTimeout(() => {
          if (document.body.dataset.page !== 'agent-hub') return;
          S.scanned = true; S.revivedShown = true;
          render();
        }, 1200);
        return;
      case 'empty': S.conn = 'online'; S.query = 'zzzz-no-match'; break;
    }
    render();
  }

  /* ================================================================
     事件
     ================================================================ */
  function onClick(e) {
    const act = e.target.closest('[data-act]');
    const row = e.target.closest('[data-row]');
    const child = e.target.closest('[data-child]');
    const artifact = e.target.closest('[data-artifact]');
    const tab = e.target.closest('#hubTabs [role="tab"]');

    if (tab) {
      S.tab = tab.dataset.tab;
      $$('#hubTabs [role="tab"]').forEach(t => {
        const on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
        t.setAttribute('tabindex', on ? '0' : '-1');
      });
      persist(); renderBody(); return;
    }
    if (child) { e.preventDefault(); select(child.dataset.child, { scroll: true }); return; }
    if (artifact) {
      e.preventDefault();
      toast('agent:// 为该 Agent 的最终输出 artifact（.md），history:// 才是 transcript', 'info');
      return;
    }
    if (row && !act) { select(row.dataset.row); return; }
    if (!act) return;

    const a = agentById(S.selected);
    switch (act.dataset.act) {
      case 'view-flat': S.view = 'flat'; persist(); render(); break;
      case 'view-tree': S.view = 'tree'; persist(); render(); break;
      case 'new-agent': newAgentModal(); break;
      case 'open-main': toast('打开主对话（ambient session 视图）', 'message'); break;
      case 'drawer-back': S.drawerOpen = false; { const d = $('#hubDetail'); if (d) d.classList.remove('open'); break; }
      case 'open-agent': if (a) openChat(a.id); break;
      case 'chat-agent': if (a) { if (caps(a).chat) openChat(a.id); else { S.notice = { kind: 'warn', text: caps(a).chatWhy }; renderBody(); } } break;
      case 'revive-agent': if (a) revive(a); break;
      case 'kill-agent': if (a) kill(a); break;
      case 'send-msg': {
        if (!a) break;
        const ta = $('[data-intent]');
        if (ta) sendPrompt(a, ta.value);
        break;
      }
      case 'send-irc': {
        if (!a) break;
        const inp = $('[data-irc]');
        if (inp) { sendIrc(a, inp.value); inp.value = ''; }
        break;
      }
      case 'cancel-job': {
        const id = act.dataset.job;
        S.cancelledJobs.add(id);
        const j = HUB.jobs.find(x => x.id === id);
        if (j) { j.status = 'cancelled'; j.errorText = 'cancelled by owner agent'; }
        toast(`已取消 ${id}（owner-scoped）`, 'stop');
        renderBody(); break;
      }
      case 'jobs-mine': S.jobsTab = 'mine'; renderBody(); break;
      case 'jobs-all': S.jobsTab = 'all'; renderBody(); break;
      case 'conn-retry': S.conn = 'online'; toast('已重新连接 runtime', 'network'); render(); break;
      case 'conn-ok': S.conn = 'online'; render(); break;
    }
  }

  function onInput(e) {
    if (e.target.hasAttribute('data-hub-search')) {
      /* 中文 IME 组合输入期间不重建（会销毁 input、丢组合态）；
         只重建列表 + usage + 状态计数，不动搜索框本身，caret 不跳。 */
      if (e.isComposing) return;
      S.query = e.target.value;
      const rows = filtered();
      const list = $('#hubList');
      if (list) { list.innerHTML = listHtml(); OMP.injectIcons(list); OMP.ui.labelIconButtons(list); }
      const usage = $('.hub-usage');
      if (usage) usage.outerHTML = usageHtml();
      const counts = $('.hub-status-counts');
      if (counts) {
        const vis = visibleAgents(), c = {};
        vis.forEach(a => { const s = effStatus(a); c[s] = (c[s] || 0) + 1; });
        counts.innerHTML = ['running', 'idle', 'parked', 'aborted'].filter(k => c[k])
          .map(k => `<span class="sc-item"><span class="dot ${STATUS_DOT[k]}"></span>${c[k]} ${STATUS_LABEL[k]}</span>`).join('');
      }
      return;
    }
    if (e.target.hasAttribute('data-intent')) {
      const a = agentById(S.selected);
      if (a) S.intents[a.id] = e.target.value;
    }
  }

  function onKeydown(e) {
    if (document.body.dataset.page !== 'agent-hub') return;
    const inField = e.target.matches('input, textarea, select');
    if (inField) {
      if (e.key === 'Enter' && e.target.hasAttribute('data-intent') && !e.shiftKey) {
        e.preventDefault();
        const a = agentById(S.selected);
        if (a) sendPrompt(a, e.target.value);
      }
      return;
    }
    /* modal 或 app.js 的 overlay 菜单（场景下拉等）打开时不抢键 */
    if (document.querySelector('.modal-backdrop, #overlayRoot .menu, #overlayRoot [data-overlay]')) return;
    /* 线性序列：flat=排序后全部；tree=组头→其子→孤儿（与视觉顺序一致） */
    let seq;
    if (S.view === 'tree') {
      const t = treeGroups(filtered());
      seq = [];
      t.groups.forEach(g => { seq.push(g.head); g.kids.forEach(k => seq.push(k)); });
      t.orphans.forEach(a => seq.push(a));
    } else {
      seq = sortFlat(filtered());
    }
    const i = seq.findIndex(a => a.id === S.selected);
    switch (e.key) {
      case 'j': case 'ArrowDown':
        e.preventDefault();
        if (seq.length) select(seq[Math.min(seq.length - 1, i + 1)].id, { scroll: true });
        break;
      case 'k': case 'ArrowUp':
        e.preventDefault();
        if (seq.length) select(seq[Math.max(0, i < 0 ? 0 : i - 1)].id, { scroll: true });
        break;
      case 'Enter':
        if (S.selected) { e.preventDefault(); openChat(S.selected); }
        break;
      case 't':
        e.preventDefault();
        S.view = S.view === 'flat' ? 'tree' : 'flat';
        persist(); render();
        break;
      case 'r': {
        const a = agentById(S.selected);
        if (a) { e.preventDefault(); revive(a); }
        break;
      }
      case 'x': {
        const a = agentById(S.selected);
        if (a) { e.preventDefault(); kill(a); }
        break;
      }
      case 'Escape': {
        if (S.drawerOpen) { S.drawerOpen = false; const d = $('#hubDetail'); if (d) d.classList.remove('open'); }
        break;
      }
    }
  }

  /* ---------------- 工作台联动：消费 hubIntent ---------------- */
  function consumeIntent() {
    try {
      const raw = sessionStorage.getItem(SS_INTENT);
      if (!raw) return;
      sessionStorage.removeItem(SS_INTENT);
      const intent = JSON.parse(raw);
      if (intent && intent.agentId && agentById(intent.agentId)) {
        if (intent.tab) S.tab = intent.tab;
        select(intent.agentId, { scroll: true });
      }
    } catch (e) {}
  }

  /* ---------------- init（注册到 router） ---------------- */
  function init() {
    const root = $('#hubRoot');
    if (!root) return;
    if (!root._hubMounted) {
      root._hubMounted = true;
      root.addEventListener('click', onClick);
      root.addEventListener('input', onInput);
      /* 页级键盘：挂 document 一次（capture=false，不抢 Command Palette / Esc 菜单） */
      if (!init._kb) { init._kb = true; document.addEventListener('keydown', onKeydown); }
    }
    if (!S.booted) {
      render();
      setTimeout(() => { S.booted = true; consumeIntent(); render(); }, 350);
      return;
    }
    consumeIntent();
    render();
  }

  /* 供 workbench 入口徽标 / 联动使用：与 roster 同源计数 */
  window.OMP = window.OMP || {};
  OMP.agentHub = {
    summary() {
      return {
        running: HUB.agents.filter(a => a.status === 'running').length,
        waiting: HUB.agents.filter(a => waiting(a)).length,
        failed: HUB.agents.filter(a => a.activity === 'failed').length,
        unread: HUB.agents.reduce((n, a) => n + (a.ircUnread || 0), 0)
      };
    },
    open(agentId, tab) {
      try {
        sessionStorage.setItem(SS_INTENT, JSON.stringify({ agentId: agentId || null, tab: tab || null }));
      } catch (e) {}
      OMP.router.goto('agent-hub');
    }
  };

  /* page-agent-hub.js 在 router.js 之前加载，OMP.router 此时尚不存在；
     延迟到 DOMContentLoaded 再注册（与 pages.js 同一模式）。 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => OMP.router.register('agent-hub', init));
  } else {
    OMP.router.register('agent-hub', init);
  }
})();
