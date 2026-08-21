/* ============================================================
   OMP Studio — 应用壳逻辑
   侧栏渲染与布局 · 菜单浮层 · Command Palette · Toast · 快捷键
   ============================================================ */
(function () {
  const D = window.OMP_DATA;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* ---------------- 状态（布局持久化） ---------------- */
  const LS_KEY = 'omp-studio-layout';
  const state = {
    sidebarW: 272,
    ratio: 0.46,               // 项目对话区占比
    filesCollapsed: false,
    sidebarCollapsed: false,
    activeThread: 't1',
    drafts: {},                // threadId -> 草稿
    expandedDirs: new Set(['app', 'components']),
    expandedProjects: new Set(['p1'])
  };
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    Object.assign(state, saved, {
      expandedDirs: new Set(saved.expandedDirs || ['app', 'components']),
      expandedProjects: new Set(saved.expandedProjects || ['p1'])
    });
  } catch (e) {}

  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        sidebarW: state.sidebarW, ratio: state.ratio,
        filesCollapsed: state.filesCollapsed,
        sidebarCollapsed: state.sidebarCollapsed, activeThread: state.activeThread,
        expandedDirs: [...state.expandedDirs], expandedProjects: [...state.expandedProjects]
      }));
    } catch (e) {}
  }

  /* ---------------- 浮层系统 ---------------- */
  const overlayRoot = $('#overlayRoot');
  let currentOverlay = null;
  let currentAnchorEl = null;

  function closeOverlay() {
    if (!currentOverlay) return;
    const returnTo = currentAnchorEl;
    currentOverlay.remove();
    currentOverlay = null;
    document.removeEventListener('mousedown', onDocDown);
    document.removeEventListener('keydown', onOverlayKey);
    if (returnTo) {
      returnTo.setAttribute('aria-expanded', 'false');
      // Focus goes back to the control that opened the menu. Without this,
      // dismissing a menu drops focus to <body> and the next Tab restarts from
      // the top of the document.
      if (document.body.contains(returnTo)) returnTo.focus();
    }
  }

  /* Roving focus inside an open menu: Up/Down move between items, Home/End jump
     to the ends, Escape closes. Tab is also contained so focus cannot wander
     into the page behind an open menu. */
  function onOverlayKey(e) {
    if (!currentOverlay) return;
    const items = Array.from(currentOverlay.querySelectorAll(
      '.menu-item, .cmdk-item, .complete-item, button:not([disabled]), [href]'
    )).filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      // Wraps, so holding one direction cycles rather than dead-ending.
      items[(i + dir + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault(); items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault(); items[items.length - 1].focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      items[(Math.max(0, i) + dir + items.length) % items.length].focus();
    }
  }
  function onDocDown(e) {
    if (!currentOverlay) return;
    if (currentOverlay.contains(e.target)) return;
    // 点在锚点自身上 → 交给 click 走 toggle（收起），不要在这里先关掉再重开
    if (currentAnchorEl && currentAnchorEl.contains(e.target)) return;
    closeOverlay();
  }
  function openOverlay(node, anchor, place) {
    // 同一锚点再次点击 → 收起（toggle）
    if (currentOverlay && anchor && currentAnchorEl === anchor) {
      closeOverlay();
      currentAnchorEl = null;
      return null;
    }
    closeOverlay();
    node.dataset.overlay = '1';
    overlayRoot.appendChild(node);
    currentOverlay = node;
    currentAnchorEl = anchor || null;
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'true');
      anchor.setAttribute('aria-haspopup', 'true');
      const r = anchor.getBoundingClientRect();
      node.style.position = 'fixed';
      if (place === 'up-left') { node.style.left = r.left + 'px'; node.style.bottom = (window.innerHeight - r.top + 6) + 'px'; }
      else if (place === 'up-right') { node.style.right = (window.innerWidth - r.right) + 'px'; node.style.bottom = (window.innerHeight - r.top + 6) + 'px'; }
      else if (place === 'down-right') { node.style.right = (window.innerWidth - r.right) + 'px'; node.style.top = (r.bottom + 6) + 'px'; }
      else { node.style.left = r.left + 'px'; node.style.top = (r.bottom + 6) + 'px'; }

      // Menus were positioned from the anchor with no viewport check, so a
      // control near the right or bottom edge opened a menu that ran off-screen
      // with no way to scroll to it. Clamp after layout, once the real size is
      // known.
      requestAnimationFrame(() => {
        const b = node.getBoundingClientRect();
        const pad = 8;
        if (b.right > window.innerWidth - pad) {
          node.style.left = Math.max(pad, window.innerWidth - b.width - pad) + 'px';
          node.style.right = 'auto';
        }
        if (b.left < pad) { node.style.left = pad + 'px'; node.style.right = 'auto'; }
        if (b.bottom > window.innerHeight - pad) {
          node.style.top = Math.max(pad, window.innerHeight - b.height - pad) + 'px';
          node.style.bottom = 'auto';
        }
        if (b.top < pad) { node.style.top = pad + 'px'; node.style.bottom = 'auto'; }
      });
    }
    labelIconButtons(node);
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onOverlayKey);
    // Move focus into the menu so keyboard users land on the first item rather
    // than staying on the trigger with an open, unreachable list.
    const first = node.querySelector('.menu-item, .cmdk-item, button, [href]');
    if (first) requestAnimationFrame(() => first.focus());
    return node;
  }
  function menu(html, cls) {
    const m = document.createElement('div');
    m.className = 'menu' + (cls ? ' ' + cls : '');
    m.innerHTML = html;
    // menu() serves two different things: actual action menus and read-only
    // popovers (Token usage, Context breakdown). Only the former is a menu —
    // labelling an info panel role="menu" would promise interactive items that
    // do not exist, so the role is applied by content, not by container.
    if (m.querySelector('.menu-item')) {
      m.setAttribute('role', 'menu');
      m.querySelectorAll('.menu-item').forEach(it => it.setAttribute('role', 'menuitem'));
      m.querySelectorAll('.menu-label').forEach(l => l.setAttribute('role', 'presentation'));
    } else {
      // Popover: announce it as a grouping with a name taken from its heading.
      m.setAttribute('role', 'group');
      const head = m.querySelector('.tp-head');
      if (head) m.setAttribute('aria-label', head.textContent.trim());
    }
    return m;
  }
  function mi(icon, label, opts) {
    opts = opts || {};
    // Keyboard hints are decorative duplicates of the shortcut the label already
    // implies, so they are hidden from the accessibility tree rather than read
    // out as "Ctrl N" noise after every item name.
    return `<button class="menu-item${opts.danger ? ' danger' : ''}" data-act="${opts.act || ''}">
      ${OMP.icon(icon, 'sm')}<span>${label}</span>${opts.hint ? `<span class="hint">${opts.hint}</span>` : ''}${opts.kbd ? `<span class="kbd" aria-hidden="true">${opts.kbd}</span>` : ''}
    </button>`;
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOverlay(); });

  /* ---------------- Toast ----------------
     The wrapper is an aria-live region declared once in the HTML, so appending
     a toast announces it without moving focus. Announcing via focus would yank
     the caret out of the composer mid-typing. */
  function toast(text, icon) {
    const t = document.createElement('div');
    t.className = 'toast';
    // Icon is decorative here — the text beside it carries the same meaning.
    t.innerHTML = (icon ? OMP.icon(icon, 'sm') : '') + `<span>${text}</span>`;
    $('#toastWrap').appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity var(--dur-exit) var(--ease-in)';
      setTimeout(() => t.remove(), 320);
    }, 2400);
  }

  /* ---------------- Accessibility plumbing ----------------
     Three systematic gaps, fixed once here rather than at ~90 call sites:

     1. Icon-only buttons had no accessible name. Every one already carries the
        label as data-tip for the visual tooltip, so that string is promoted to
        aria-label whenever the control has no text of its own. One source of
        truth, no duplicated copy.
     2. Rows rendered as <div> with a click handler (threads, tree rows, tool
        headers, change rows) were unreachable by keyboard and announced as
        plain text. They get button semantics and Enter/Space activation.
     3. Expand/collapse controls never exposed their state, so a screen reader
        could not tell an open tool card from a closed one. */
  function labelIconButtons(root) {
    (root || document).querySelectorAll('[data-tip]').forEach(el => {
      const tip = el.getAttribute('data-tip');
      if (!tip) return;
      // Only name controls; a tooltip on a static span is not a control.
      const isControl = el.matches('button, a, [role="button"], [tabindex]');
      if (!isControl) return;
      if (el.getAttribute('aria-label')) return;
      // If the control has its own visible text, that is already the name.
      if (el.textContent.trim()) return;
      el.setAttribute('aria-label', tip);
    });
  }

  /* Makes non-button elements behave like buttons for assistive tech and for
     keyboard users. Applied by selector so render functions stay declarative. */
  function asButtons(root, selector, opts) {
    opts = opts || {};
    (root || document).querySelectorAll(selector).forEach(el => {
      if (el.dataset.kb === '1') return;
      el.dataset.kb = '1';
      if (!el.matches('button, a')) {
        el.setAttribute('role', opts.role || 'button');
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      }
    });
  }

  /* Tablist keyboard behaviour.
     Both panels styled their tabs as tabs but wired them as six independent
     buttons: every one was a tab stop, arrow keys did nothing, and nothing
     tracked aria-selected. This gives them the standard pattern — one tab stop
     for the whole set (roving tabindex), arrows to move, Home/End to jump — and
     keeps aria-selected in sync with the .active class the CSS already uses. */
  function initTablist(listSelector) {
    const list = $(listSelector);
    if (!list) return;
    const tabs = () => $$('[role="tab"]', list);

    function select(tab, moveFocus) {
      tabs().forEach(t => {
        const on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        // Only the selected tab stays tabbable, so Tab moves past the whole set
        // rather than through every tab in it.
        t.setAttribute('tabindex', on ? '0' : '-1');
      });
      if (moveFocus) tab.focus();
      tab.click();
    }

    list.addEventListener('keydown', e => {
      const all = tabs();
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowRight') next = all[(i + 1) % all.length];
      else if (e.key === 'ArrowLeft') next = all[(i - 1 + all.length) % all.length];
      else if (e.key === 'Home') next = all[0];
      else if (e.key === 'End') next = all[all.length - 1];
      if (!next) return;
      e.preventDefault();
      select(next, true);
    });

    // Pointer clicks must keep the same state in sync as the keyboard path.
    list.addEventListener('click', e => {
      const tab = e.target.closest('[role="tab"]');
      if (!tab) return;
      tabs().forEach(t => {
        const on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.setAttribute('tabindex', on ? '0' : '-1');
      });
    });
  }

  /* Single delegated listener: Space and Enter activate anything with button
     semantics that is not a real <button> (real buttons already do this).
     Space is preventDefault-ed to stop the page scrolling underneath. */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const el = e.target;
    if (!el || el.matches('button, a, input, textarea, select')) return;
    if (el.getAttribute('role') !== 'button' && el.getAttribute('role') !== 'switch') return;
    e.preventDefault();
    el.click();
  });

  OMP.ui = { toast, closeOverlay, openOverlay, menu, mi, state, persist, labelIconButtons, asButtons, initTablist };

  /* ---------------- 侧栏：项目与对话 ---------------- */
  const statusChip = {
    archived: '<span class="chip gray xs">已归档</span>',
    idle: ''
  };

  function renderProjects(opts) {
    const restoreFocus = opts && opts.focus;
    const wrap = $('#projectList');
    if (!wrap) return;
    wrap.innerHTML = D.projects.map(p => {
      const open = state.expandedProjects.has(p.id);
      // Status flags were bare coloured dots: a blue dot and an amber dot are
      // indistinguishable to anyone who cannot separate the hues, and they were
      // silent to screen readers (data-tip only feeds the CSS tooltip). Each now
      // carries role="img" + a real name, so colour is a redundant cue rather
      // than the only one.
      const flags = [];
      if (p.running) flags.push('<span class="dot blue pulse" role="img" aria-label="有运行中任务" data-tip="有运行中任务"></span>');
      if (p.attention) flags.push('<span class="dot amber" role="img" aria-label="需要处理" data-tip="需要处理"></span>');
      if (p.preview === 'running') flags.push(`<span role="img" aria-label="Preview 运行中" data-tip="Preview 运行中">${OMP.icon('globe', 'sm')}</span>`);
      if (p.dirty) flags.push(`<span class="tiny muted mono" data-tip="${p.dirty} 个未提交修改">${p.dirty}M<span class="sr-only"> 个未提交修改</span></span>`);
      // role="option" would be invalid here — it requires a listbox parent, and
      // this container interleaves project headers with threads. These rows
      // navigate, so button + aria-current is both valid standalone and the
      // conventional way to announce "this is the one you're on".
      const threads = open ? p.threads.map(t => `
        <div class="thread${t.id === state.activeThread ? ' active' : ''}" data-thread="${t.id}" data-title="${t.title}"
             role="button" tabindex="0"${t.id === state.activeThread ? ' aria-current="true"' : ''}>
          ${t.status === 'running' ? '<span class="t-spin" role="img" aria-label="运行中"></span>' : ''}
          <span class="t-title ellipsis">${t.pinned ? `<span class="t-pin" role="img" aria-label="已置顶">${OMP.icon('pin', 'sm')}</span>` : ''}${t.title}</span>
          <span class="t-badges">${statusChip[t.status] || ''}${t.hasSub ? `<span role="img" aria-label="含子 Agent">${OMP.icon('bot', 'sm')}</span>` : ''}</span>
          ${t.unread ? `<span class="unread">${t.unread}<span class="sr-only"> 条未读</span></span>` : ''}
          ${t.status === 'approval'
            ? `<span class="chip amber xs t-approval">待审批</span>`
            : t.status === 'running'
              ? ''   // 运行中不显示时间 · 消息数
              : `<span class="t-meta">${t.time} · ${t.msgs} msgs</span>`}
        </div>`).join('') : '';
      return `
      <div class="project">
        <div class="project-head" data-project="${p.id}" role="button" tabindex="0" aria-expanded="${open}">
          <span class="tw"><svg class="icon sm" style="transform:rotate(${open ? 90 : 0}deg)" aria-hidden="true">${''}</svg></span>
          <div class="p-name ellipsis">${OMP.icon('folder', 'sm')}<span class="ellipsis">${p.name}</span></div>
          <div class="project-flags">${flags.join('')}</div>
        </div>
        ${threads}
      </div>`;
    }).join('');

    // chevron 修正（避免 innerHTML svg 空内容）
    $$('#projectList .project-head .tw svg').forEach(svg => { svg.setAttribute('viewBox', '0 0 16 16'); svg.innerHTML = '<path d="M6 3.5 10.5 8 6 12.5"/>'; });

    $$('#projectList .project-head').forEach(h => h.addEventListener('click', () => {
      const id = h.dataset.project;
      state.expandedProjects.has(id) ? state.expandedProjects.delete(id) : state.expandedProjects.add(id);
      persist();
      // Expanding rebuilds the whole list via innerHTML, which destroys the node
      // that currently has focus — keyboard users were dropped to <body> on every
      // toggle and had to tab in from the top again. Re-find the same row after
      // the rebuild and restore focus to it.
      renderProjects({ focus: `#projectList [data-project="${id}"]` });
    }));
    $$('#projectList .thread').forEach(el => el.addEventListener('click', e => {
      e.stopPropagation();
      switchThread(el.dataset.thread, el.dataset.title);
    }));

    labelIconButtons(wrap);
    if (restoreFocus) {
      const target = $(restoreFocus);
      if (target) target.focus();
    }
  }

  function switchThread(id, title) {
    // 保存当前草稿
    const input = $('#composerInput');
    if (input) { state.drafts[state.activeThread] = input.value; }
    state.activeThread = id;
    persist();
    renderProjects();
    const nameEl = $('#tbThreadName'); if (nameEl && title) nameEl.textContent = title;
    if (input) { input.value = state.drafts[id] || ''; input.dispatchEvent(new Event('input')); }
    toast(`已切换到「${title || id}」· 草稿已保留`, 'message');
  }

  /* ---------------- 侧栏：文件树 ----------------
     Git status is an SVG icon chip (pencil/plus/trash/file-plus) + tint, with an
     sr-only expansion — the icon carries meaning without colour, and the text
     names the status for screen readers. */
  const GIT_LABEL = { M: '已修改', A: '新增', D: '已删除', '?': '未跟踪' };

  function treeRow(node, depth, path) {
    // Indentation is data-driven (depth), so it stays inline — but it is set as
    // a custom property rather than a raw padding declaration so the row's own
    // padding rule keeps control of the box.
    const pad = `style="--depth-pad:${depth * 14 + 6}px"`;
    if (node.type === 'dir') {
      const open = state.expandedDirs.has(path);
      const kids = (node.children || []).map(c => treeRow(c, depth + 1, path + '/' + c.name)).join('');
      return `<div class="tree-row${open ? ' open' : ''}" data-dir="${path}" ${pad}
                   role="treeitem" tabindex="0" aria-expanded="${open}" aria-label="${node.name} 文件夹">
          <span class="tw">${OMP.icon('chevron-r')}</span>
          <span class="fi">${OMP.icon(open ? 'folder-open' : 'folder')}</span>
          <span class="fname ellipsis">${node.name}</span>
        </div>
        <div class="tree-children" role="group">${kids}</div>`;
    }
    const stat = node.status
      ? `<span class="fstat ${node.status === 'M' ? 'm' : node.status === 'A' ? 'a' : node.status === 'D' ? 'd' : 'u'}">${OMP.icon({ M: 'pencil', A: 'plus', D: 'trash' }[node.status] || 'file-plus')}<span class="sr-only"> ${GIT_LABEL[node.status] || ''}</span></span>`
      : '';
    const live = node.writing ? `<span class="live" role="img" aria-label="OMP 正在写入" data-tip="OMP 正在写入"><span class="dot blue pulse"></span></span>`
      : node.reading ? `<span class="live" role="img" aria-label="OMP 正在读取" data-tip="OMP 正在读取"><span class="dot purple pulse"></span></span>` : '';
    const diagLabel = node.diagnostic === 'error' ? '存在诊断错误' : '存在诊断警告';
    const diag = node.diagnostic ? `<span class="diag ${node.diagnostic === 'error' ? 'err' : 'warn'}" role="img" aria-label="${diagLabel}" data-tip="${diagLabel}"></span>` : '';
    return `<div class="tree-row${node.turn ? ' turn-file' : ''}" data-file="${path}" ${pad} role="treeitem" tabindex="0">
        <span class="tw"></span>
        <span class="fi">${OMP.icon(node.name.endsWith('.tsx') || node.name.endsWith('.ts') ? 'file-code' : 'file')}</span>
        <span class="fname ellipsis">${node.name}</span>
        ${live}${diag}${stat}
        <span class="fop">
          <button class="icon-btn" data-tip="加入上下文">${OMP.icon('at')}</button>
          <button class="icon-btn" data-tip="更多">${OMP.icon('more')}</button>
        </span>
      </div>`;
  }
  function renderTree(opts) {
    const restoreFocus = opts && opts.focus;
    const wrap = $('#fileTree');
    if (!wrap) return;
    // The tree needs its container role for the treeitem children to be valid,
    // and a name so it is not announced as an unlabelled group.
    wrap.setAttribute('role', 'tree');
    wrap.setAttribute('aria-label', 'Explorer 文件树');
    wrap.innerHTML = D.fileTree.map(n => treeRow(n, 0, n.name)).join('');
    $$('#fileTree [data-dir]').forEach(el => el.addEventListener('click', () => {
      const p = el.dataset.dir;
      state.expandedDirs.has(p) ? state.expandedDirs.delete(p) : state.expandedDirs.add(p);
      persist();
      // Same focus-loss trap as the project list: innerHTML discards the focused
      // row on every expand.
      renderTree({ focus: `#fileTree [data-dir="${p}"]` });
    }));
    $$('#fileTree [data-file]').forEach(el => el.addEventListener('click', () => {
      toast(`打开 ${el.dataset.file}`, 'file');
    }));
    // The per-row action buttons sit inside the row, so their clicks bubbled into
    // the row handler — pressing "加入上下文" also fired "打开 <file>". Both the
    // action and the row-open ran on a single click.
    $$('#fileTree .fop .icon-btn').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const row = b.closest('[data-file]');
      toast(b.getAttribute('data-tip') === '加入上下文'
        ? `已加入上下文：${row ? row.dataset.file : ''}`
        : '更多操作', 'at');
    }));
    labelIconButtons(wrap);
    if (restoreFocus) {
      const target = $(restoreFocus);
      if (target) target.focus();
    }
  }

  /* ---------------- 侧栏布局：宽度拖拽 / 上下比例 / 收起 ---------------- */
  function applySidebarLayout() {
    const sb = $('#sidebar');
    if (!sb) return;
    sb.style.width = state.sidebarW + 'px';
    sb.style.setProperty('--sidebar-w', state.sidebarW + 'px');
    sb.classList.toggle('collapsed', state.sidebarCollapsed);
    // A collapsed sidebar was only slid out of view with a negative margin — it
    // stayed in the tab order and in the accessibility tree, so keyboard users
    // tabbed into ~30 invisible controls. inert removes it from both.
    sb.inert = state.sidebarCollapsed;
    sb.setAttribute('aria-hidden', state.sidebarCollapsed ? 'true' : 'false');

    // 项目与对话 is fixed (Codex-style): never collapsible. Force-expand so a
    // stale persisted value from before its collapse button was removed can't
    // leave it folded with no way to unfold.
    state.projectsCollapsed = false;
    const pj = $('#sbProjects'), fl = $('#sbFiles'), dv = $('#sbDivider');
    pj.classList.toggle('collapse', false);
    fl.classList.toggle('collapse', state.filesCollapsed);

    // Explorer's collapse button is the only state cue for a folded section, so
    // the chevron and tooltip have to flip with it — a collapsed panel that
    // still shows a down-chevron + "收起" reads as "expand me". One writer owns
    // icon + tooltip + aria together, the same single-writer rule
    // setBottomCollapsed already uses (workbench.js).
    const bcf = $('#btnCollapseFiles');
    if (bcf) syncCollapseButton(bcf, state.filesCollapsed, 'chevron-u', 'chevron-d', '收起 Explorer', '展开 Explorer');
    const bts = $('#btnToggleSidebar');
    if (bts) bts.setAttribute('aria-expanded', String(!state.sidebarCollapsed));

    if (state.filesCollapsed) {
      pj.style.flex = '1 1 100%';
      fl.style.flex = 'none';
    } else {
      pj.style.flex = `1 1 ${state.ratio * 100}%`;
      fl.style.flex = `1 1 ${(1 - state.ratio) * 100}%`;
    }
    dv.style.display = '';
    // Both resizers are drag-only affordances; expose the value they control so
    // the keyboard path below has something to announce.
    const res = $('#sbResizer');
    if (res) res.setAttribute('aria-valuenow', String(Math.round(state.sidebarW)));
    if (dv) dv.setAttribute('aria-valuenow', String(Math.round(state.ratio * 100)));
  }

  /* Single writer for a section-collapse button. The chevron points the way the
     section moves on the next click, and the tooltip/aria-label say what the
     click does — never what it just did. iconCollapsed/iconExpanded: chevrons
     while folded vs open; tipOpen/tipCollapsed: full tooltip strings. */
  function syncCollapseButton(btn, collapsed, iconCollapsed, iconExpanded, tipOpen, tipCollapsed) {
    const open = !collapsed;
    btn.setAttribute('aria-expanded', String(open));
    btn.innerHTML = OMP.icon(open ? iconExpanded : iconCollapsed, 'sm');
    const tip = open ? tipOpen : tipCollapsed;
    btn.setAttribute('data-tip', tip);
    btn.setAttribute('aria-label', tip);
  }

  const SB_MIN = 200, SB_MAX = 400;

  /* Both panel resizers were mouse-drag-only. Three problems, fixed together:
       - Drag-only means no keyboard path at all. WCAG asks for a single-pointer
         alternative to any drag operation (SC 2.5.7), and arrow keys on a
         focusable separator is the standard one.
       - Dragging selected text across the whole app, because only the initial
         mousedown was preventDefault-ed, not the subsequent moves.
       - The resize cursor reverted the moment the pointer left the 6px handle,
         so a fast drag looked like it had been dropped. */
  function initResizer(el, opts) {
    if (!el) return;
    el.setAttribute('role', 'separator');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', opts.label);
    el.setAttribute('aria-orientation', opts.orientation);
    el.setAttribute('aria-valuemin', String(opts.min));
    el.setAttribute('aria-valuemax', String(opts.max));

    el.addEventListener('mousedown', e => {
      e.preventDefault();
      el.classList.add('dragging');
      // Lock the cursor and kill selection for the whole drag, not just the handle.
      document.body.style.cursor = opts.orientation === 'vertical' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      const move = ev => { ev.preventDefault(); opts.onDrag(ev); applySidebarLayout(); };
      const up = () => {
        el.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        persist();
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    el.addEventListener('keydown', e => {
      const dec = opts.orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
      const inc = opts.orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
      let handled = true;
      // Shift multiplies the step so crossing the full range does not take 40
      // keypresses; Home/End jump to the extremes.
      const step = e.shiftKey ? opts.bigStep : opts.step;
      if (e.key === dec) opts.onKey(-step);
      else if (e.key === inc) opts.onKey(step);
      else if (e.key === 'Home') opts.onKey(-1e6);
      else if (e.key === 'End') opts.onKey(1e6);
      else handled = false;
      if (!handled) return;
      e.preventDefault();
      applySidebarLayout();
      persist();
    });
  }

  function initSidebarDrag() {
    const sb = $('#sidebar');
    initResizer($('#sbResizer'), {
      label: '调整侧栏宽度', orientation: 'vertical',
      min: SB_MIN, max: SB_MAX, step: 16, bigStep: 48,
      onDrag: ev => { state.sidebarW = Math.min(SB_MAX, Math.max(SB_MIN, ev.clientX)); },
      onKey: d => { state.sidebarW = Math.min(SB_MAX, Math.max(SB_MIN, state.sidebarW + d)); }
    });

    const dv = $('#sbDivider');
    initResizer(dv, {
      label: '调整项目与文件树的高度比例', orientation: 'horizontal',
      min: 15, max: 85, step: 5, bigStep: 15,
      onDrag: ev => {
        const r = sb.getBoundingClientRect();
        const y = ev.clientY - r.top - 60;
        const h = r.height - 60 - 90;
        state.ratio = Math.min(0.85, Math.max(0.15, y / h));
      },
      onKey: d => { state.ratio = Math.min(0.85, Math.max(0.15, state.ratio + d / 100)); }
    });
    if (dv) {
      dv.addEventListener('dblclick', () => { state.ratio = 0.5; persist(); applySidebarLayout(); toast('已恢复上下平分'); });
    }

    // 项目与对话 is fixed, so only Explorer keeps a collapse toggle.
    const bcf = $('#btnCollapseFiles');
    if (bcf) bcf.addEventListener('click', () => { state.filesCollapsed = !state.filesCollapsed; persist(); applySidebarLayout(); });
  }

  function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    persist(); applySidebarLayout();
  }

  /* ---------------- 菜单：左上应用菜单 ---------------- */
  function appMenu() {
    const m = menu(`
      <div class="menu-label">全局操作</div>
      ${mi('plus', '新建对话', { act: 'new-thread', kbd: 'Ctrl N' })}
      ${mi('folder-open', '打开本地项目…')}
      ${mi('branch', '克隆 Git 仓库…')}
      ${mi('flask', '创建临时工作区')}
      <div class="menu-sep"></div>
      ${mi('layers', '切换项目', { hint: '3 个项目' })}
      ${mi('clock', '最近项目', { hint: 'omp-web' })}
      ${mi('history', '打开会话历史', { act: 'history' })}
      <div class="menu-sep"></div>
      ${mi('search', '全局搜索', { kbd: 'Ctrl K' })}
      ${mi('command', 'Command Palette', { kbd: 'Ctrl K' })}
      ${mi('terminal', '打开终端', { kbd: 'Ctrl J' })}
      ${mi('external', '在外部编辑器中打开项目')}
      ${mi('folder', '打开系统文件管理器')}
      ${mi('wrench', '打开 OMP 配置目录')}
      ${mi('server', '模型配置', { act: 'model-config', hint: '供应商 · 角色' })}
      <div class="menu-sep"></div>
      ${mi('settings', '设置', { act: 'settings', kbd: 'Ctrl ,' })}
      ${mi('keyboard', '快捷键')}
      ${mi('info', '关于 OMP Studio')}
    `);
    m.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'history') OMP.router.goto('history');
      else if (act === 'settings') OMP.router.goto('settings');
      else if (act === 'model-config') OMP.router.goto('model-config');
      else if (act === 'new-thread') toast('已创建新对话', 'plus');
      closeOverlay();
    });
    return m;
  }

  function newMenu() {
    const m = menu(`
      ${mi('message', '新建对话', { kbd: 'Ctrl N' })}
      ${mi('play', '在当前项目中开始')}
      ${mi('worktree', '在新 Worktree 中开始')}
      <div class="menu-sep"></div>
      ${mi('folder-open', '打开新项目…')}
      ${mi('branch', '克隆仓库…')}
      ${mi('flask', '创建临时工作区')}
    `, '');
    m.style.minWidth = '220px';
    m.addEventListener('click', () => { toast('已创建新对话', 'plus'); closeOverlay(); });
    return m;
  }

  /* ---------------- 菜单：左下 OMP 环境菜单 ---------------- */
  function ompMenu(error) {
    const m = menu(`
      <div class="omp-menu-head">
        <span class="logo">π</span>
        <div>
          <div style="font-weight:var(--fw-semibold)">OMP</div>
          <div class="v">${error ? '<span style="color:var(--red)">Disconnected</span>' : '<span style="color:var(--green)">Ready</span>'} · v0.82.1 · rpc/2.1</div>
        </div>
      </div>
      ${error ? `<div class="omp-menu-err">${OMP.icon('alert', 'sm')}<span>Bridge 连接中断（code 1006）。正在自动重连…</span></div>` : ''}
      <div class="menu-sep"></div>
      ${mi('refresh', '重启 OMP Bridge')}
      ${mi('pulse', '重新检测 OMP')}
      ${mi('wrench', '打开 OMP 配置')}
      ${mi('pulse', '打开诊断中心', { act: 'diag' })}
      ${mi('update', '检查更新', { hint: 'v0.82.2 可用' })}
    `, 'omp-menu');
    m.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'diag') OMP.router.goto('diagnostics');
      else toast('已执行', 'check');
      closeOverlay();
    });
    return m;
  }

  /* ---------------- 顶栏面包屑：项目 › 分支 › 标题（ver2 风格） ----------------
     各段都是按钮，点击弹菜单。分支菜单携带 dirty/上游详情，对齐 ver2。 */
  const activeProject = () => D.projects.find(p => p.id === 'p1') || D.projects[0];

  function renderTopbar() {
    const p = activeProject();
    const setTxt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    setTxt('#tbProjectName', p.name);
    setTxt('#tbBranchName', p.branch);
    setTxt('#ctxProjectName', p.name);
    setTxt('#ctxBranchName', p.branch);
    setTxt('#ctxProjectPath', p.path);

    // dirty 圆点：无未提交修改时隐藏
    const dot = $('#tbBranchDot'), cdot = $('#ctxBranchDot');
    const n = p.dirty || 0;
    if (dot) { dot.style.display = n ? '' : 'none'; dot.setAttribute('data-tip', `${n} 个未提交修改`); }
    if (cdot) { cdot.style.display = n ? '' : 'none'; cdot.setAttribute('data-tip', `${n} 个未提交修改`); }

    // 已加载文件数（递归统计文件树）
    const countFiles = nodes => nodes.reduce((sum, node) => sum + (node.type === 'dir' ? countFiles(node.children || []) : 1), 0);
    const fc = $('#ctxFileCount');
    if (fc) fc.innerHTML = `${OMP.icon('file', 'sm')}${countFiles(D.fileTree)} 个文件`;

    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('#tbProject', e => openOverlay(projectMenu(), e.currentTarget));
    on('#tbBranch', e => openOverlay(branchMenu(), e.currentTarget));
    on('#tbThread', e => openOverlay(threadMenu(), e.currentTarget));
  }

  function projectMenu() {
    const cur = activeProject();
    const m = menu(`
      <div class="menu-label">切换项目</div>
      ${D.projects.map(p => mi(p.worktree ? 'branch' : 'folder-open', p.name, {
        act: 'switch:' + p.id, hint: p.dirty ? `${p.dirty} 处修改` : null
      })).join('')}
      <div class="menu-sep"></div>
      ${mi('external', '在外部编辑器中打开项目')}
      ${mi('terminal', '在终端中打开')}
      ${mi('folder-open', '打开项目目录')}
      <div class="menu-sep"></div>
      ${mi('home', '项目主页')}
    `);
    m.addEventListener('click', e => {
      const item = e.target.closest('[data-act]');
      const act = item ? item.dataset.act : '';
      if (act.startsWith('switch:')) {
        const p = D.projects.find(x => x.id === act.slice(7));
        toast(`已切换到 ${p ? p.name : act}`, 'folder-open');
      } else toast('已执行（原型）', 'check');
      closeOverlay();
    });
    m.querySelectorAll('.menu-item').forEach(it => {
      if (it.dataset.act === 'switch:' + cur.id) it.setAttribute('aria-current', 'true');
    });
    return m;
  }

  function branchMenu() {
    const p = activeProject();
    const m = menu(`
      <div class="branch-menu-head">
        <div class="bmh-title">${OMP.icon('branch', 'sm')}<b>${p.branch}</b></div>
        <div class="bmh-meta">${p.dirty ? `${p.dirty} 个未提交修改` : '工作区干净'}${p.worktree ? ` · Worktree「${p.worktree}」` : ' · 无上游分支'}</div>
      </div>
      ${mi('commit', `${p.dirty} 个未提交修改`, { act: 'changes', hint: p.dirty ? '在 Changes 面板查看' : null })}
      <div class="menu-sep"></div>
      ${mi('columns', '查看 Changes', { act: 'changes' })}
      ${mi('commit', '创建 Commit')}
      ${mi('branch', '切换分支')}
      ${mi('fork', '新建 Worktree')}
    `);
    m.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'changes') OMP.router.goto('workbench');
      toast(act === 'changes' ? '已打开 Changes 面板' : '已执行（原型）', 'check');
      closeOverlay();
    });
    return m;
  }

  function threadMenu() {
    const m = menu(`
      ${mi('pencil', '重命名对话')}
      ${mi('fork', 'Fork 当前对话')}
      ${mi('handoff', 'Handoff 到新对话')}
      <div class="menu-sep"></div>
      ${mi('minimize', 'Compact 当前上下文')}
      ${mi('export', '导出对话')}
      <div class="menu-sep"></div>
      ${mi('history', '会话历史', { act: 'history' })}
      ${mi('archive', '归档')}
    `);
    m.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'history') OMP.router.goto('history');
      else toast('已执行（原型）', 'check');
      closeOverlay();
    });
    return m;
  }

  /* ---------------- Command Palette ---------------- */
  const paletteItems = [
    { icon: 'message', label: '新建对话', kind: '命令' },
    { icon: 'fork', label: 'Fork 当前对话', kind: '命令' },
    { icon: 'handoff', label: 'Handoff 到新 Thread', kind: '命令' },
    { icon: 'compact', label: '/compact 立即压缩上下文', kind: 'Slash' },
    { icon: 'test', label: '/test 运行测试并汇总', kind: 'Slash' },
    { icon: 'diff', label: '/review 审查当前 Changes', kind: 'Slash' },
    { icon: 'file-code', label: 'components/MermaidBlock.tsx', kind: '文件' },
    { icon: 'file-code', label: 'components/DirectoryPicker.tsx', kind: '文件' },
    { icon: 'file', label: 'docs/UPSTREAM-SYNC.md', kind: '文件' },
    { icon: 'message', label: 'Mermaid 渲染优化与全屏缩放拖拽', kind: '对话' },
    { icon: 'message', label: 'Audit and fix OSS repository issues', kind: '对话' },
    { icon: 'book', label: 'Skill · upstream-sync', kind: 'Skill' },
    { icon: 'plug', label: 'MCP · github (26 tools)', kind: 'MCP' },
    { icon: 'globe', label: '打开 Preview', kind: '命令' },
    { icon: 'settings', label: '打开设置', kind: '页面', href: '#!settings' },
    { icon: 'server', label: '模型配置 · 供应商', kind: '页面', href: '#!model-config/providers' },
    { icon: 'steering', label: '模型配置 · 角色（模型路由）', kind: '页面', href: '#!model-config/roles' },
    { icon: 'pulse', label: '打开诊断中心', kind: '页面', href: '#!diagnostics' },
    { icon: 'home', label: '项目主页', kind: '页面', href: '#!home' },
    { icon: 'history', label: '会话历史与 Time Travel', kind: '页面', href: '#!history' }
  ];
  /* Rebuilt from a plain div overlay. What was wrong with the original:
       - Nothing tracked the open palette, so a second Ctrl+K stacked another
         copy on top of the first (closeOverlay only knows about #overlayRoot).
       - The Escape listener was only removed inside its own Escape branch, so
         closing via the backdrop leaked a listener holding a detached node —
         once per open, forever.
       - Arrow keys did nothing. `.sel` was painted on index 0 and never moved,
         so Enter always ran the first result no matter what you were looking at.
       - No dialog semantics, no focus trap, no focus restore. */
  let openCmdk = null;

  function openPalette() {
    closeOverlay();
    // Reopening while open should refocus, not stack a second layer.
    if (openCmdk) { openCmdk.querySelector('input').focus(); return; }

    const returnFocusTo = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
      <div class="cmdk-input">
        ${OMP.icon('command')}
        <input type="text" role="combobox" aria-expanded="true" aria-controls="cmdkList"
               aria-autocomplete="list" aria-label="搜索命令、文件、对话、Skills、MCP Tools"
               placeholder="搜索命令、文件、对话、Skills、MCP Tools…">
        <span class="kbd" aria-hidden="true">esc</span>
      </div>
      <div class="cmdk-list" id="cmdkList" role="listbox" aria-label="搜索结果"></div>
      <div class="sr-only" role="status" aria-live="polite" id="cmdkCount"></div>
    </div>`;
    const list = wrap.querySelector('.cmdk-list');
    const input = wrap.querySelector('input');
    const count = wrap.querySelector('#cmdkCount');
    let items = [];
    let sel = 0;

    function close() {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      openCmdk = null;
      // Ctrl+K is usually pressed mid-task; dropping focus to <body> on close
      // would lose the user's place in the document.
      if (returnFocusTo && document.body.contains(returnFocusTo)) returnFocusTo.focus();
    }

    function paintSel() {
      $$('.cmdk-item', list).forEach((el, i) => {
        const on = i === sel;
        el.classList.toggle('sel', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
        // aria-activedescendant keeps focus in the input (so typing continues to
        // work) while still telling a screen reader which row is current.
        if (on) {
          input.setAttribute('aria-activedescendant', el.id);
          el.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    function renderList(q) {
      items = paletteItems.filter(i => !q || i.label.toLowerCase().includes(q.toLowerCase()));
      sel = 0;
      list.innerHTML = items.length
        ? items.map((i, idx) => `
          <div class="cmdk-item" id="cmdkItem${idx}" role="option" aria-selected="false" data-idx="${idx}" data-href="${i.href || ''}">
            ${OMP.icon(i.icon, 'sm')}<span>${i.label}</span><span class="ci-kind">${i.kind}</span>
          </div>`).join('')
        : `<div class="empty">${OMP.icon('search')}无匹配结果</div>`;
      // Result count was silent before: a screen reader user typing a query got
      // no signal that the list had changed, or emptied.
      count.textContent = items.length ? `${items.length} 个结果` : '无匹配结果';
      $$('.cmdk-item', list).forEach(el => el.addEventListener('click', () => run(+el.dataset.idx)));
      paintSel();
    }

    function run(idx) {
      const it = items[idx];
      if (!it) return;
      close();
      if (it.href) location.href = it.href;
      else toast('已执行：' + it.label, 'check');
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        paintSel();
      } else if (e.key === 'Home' && items.length) {
        e.preventDefault(); sel = 0; paintSel();
      } else if (e.key === 'End' && items.length) {
        e.preventDefault(); sel = items.length - 1; paintSel();
      } else if (e.key === 'Enter') {
        e.preventDefault(); run(sel);
      } else if (e.key === 'Tab') {
        // Focus trap: the palette is modal, so Tab must not reach the workbench
        // behind it. There is one focusable control, so Tab simply stays put.
        e.preventDefault();
      }
    }

    input.addEventListener('input', () => renderList(input.value));
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    openCmdk = wrap;
    renderList('');
    input.focus();
  }

  /* ============================================================
     侧栏内嵌技能 & 插件 抽屉面板
     数据源：OMP_DATA.skills / OMP_DATA.plugins（mock-data.js）
     设计：顶栏 [+] 新建对话 / [⊞] 技能 & 插件 两个常驻按钮，
           点击后者覆盖 .sb-section 区域（不覆盖 .sb-top / .sb-footer）。
     ============================================================ */
  function initSkillsDrawer() {
    const sb = $('#sidebar');
    const drawer = $('#skillsDrawer');
    const toggleBtn = $('#btnSkills');
    const closeBtn = $('#sdClose');
    const openHubBtn = $('#sdOpenHub');
    const searchInput = $('#sdSearchInput');
    const tabs = $$('.sd-tab', drawer);
    const body = $('#sdBody');
    const badge = $('#skillsBadge');
    const countLabel = $('#sdCount');
    if (!sb || !drawer || !toggleBtn || !body) return;

    /* 装配数据：把 skills + plugins 统一为内部条目。
       skills: {kind:'skill', name, desc, src, scope, path, enabled, error}
       plugins: {kind:'plugin', name, src, status, tools, commands, hooks, ui, err}
       已启用的判定：
         skill.enabled = true → 加入当前对话
         plugin.status = 'loaded' → 视为「在对话中可用」
         任一项 error / err ≠ null → 异常组 */
    const items = [];
    const D = window.OMP_DATA || {};
    (D.skills || []).forEach(s => items.push(Object.assign({ kind: 'skill' }, s)));
    (D.plugins || []).forEach(p => items.push(Object.assign({ kind: 'plugin' }, p)));

    const ICON_BY_NAME = {
      'upstream-sync': 'refresh', 'code-review-graph': 'network',
      'mermaid-verify': 'image', 'commit-msg': 'pencil',
      'oss-audit': 'shield',
      'omp-preview-tools': 'eye', 'git-worktree-plus': 'branch',
      'browser-lab': 'globe'
    };
    const COLOR_BY_NAME = {
      'upstream-sync': 'green', 'code-review-graph': 'purple',
      'mermaid-verify': 'blue', 'commit-msg': 'amber',
      'oss-audit': 'red',
      'omp-preview-tools': 'green', 'git-worktree-plus': 'blue',
      'browser-lab': 'red'
    };

    const state = { cat: 'all', q: '', open: false, collapsed: new Set() };

    /* 抽屉定位：根据 .sb-top / .sb-footer 的实际高度写 CSS 变量。
       覆盖范围 = 从工具栏（OMP Studio 行）下沿到用户区上沿，
       即 .sb-actions 两枚 action 行 + 项目/Explorer 区域全部被遮住；
       关闭入口用抽屉自身的 × 按钮 / Esc。 */
    function layout() {
      const topBar = sb.querySelector('.sb-top');
      const foot = sb.querySelector('.sb-footer');
      if (!topBar || !foot) return;
      const sbRect = sb.getBoundingClientRect();
      const topRect = topBar.getBoundingClientRect();
      const footRect = foot.getBoundingClientRect();
      sb.style.setProperty('--drawer-top', (topRect.bottom - sbRect.top) + 'px');
      sb.style.setProperty('--drawer-bottom', (sbRect.bottom - footRect.top) + 'px');
    }

    /* 渲染 */
    function isEnabled(it) {
      return it.kind === 'skill' ? !!it.enabled : it.status === 'loaded';
    }
    function isErr(it) {
      return it.kind === 'skill' ? !!it.error : !!it.err;
    }
    function visible() {
      const q = state.q.trim().toLowerCase();
      return items.filter(it => {
        if (state.cat === 'skill' && it.kind !== 'skill') return false;
        if (state.cat === 'plugin' && it.kind !== 'plugin') return false;
        if (q) {
          const blob = (it.name + ' ' + (it.desc || '') + ' ' + (it.src || '')).toLowerCase();
          if (!blob.includes(q)) return false;
        }
        return true;
      });
    }

    function render() {
      const list = visible();
      if (!list.length) {
        body.innerHTML =
          '<div class="sd-empty">' + OMP.icon('search') +
          '没有匹配的技能或插件<br>试试换个关键词，或在「能力中心」浏览全部</div>';
        return;
      }
      const groups = [
        ['workspace', '项目', list.filter(it => it.kind === 'skill' && it.scope === 'workspace')],
        ['global', '全局', list.filter(it => it.kind === 'skill' && it.scope === 'global')],
        ['builtin-plugin', '内置与插件', list.filter(it =>
          (it.kind === 'skill' && it.scope === 'builtin') || it.kind === 'plugin')],
      ].filter(([, , entries]) => entries.length);

      body.innerHTML = groups.map(([key, label, entries]) => {
        const open = !state.collapsed.has(key);
        return '<section class="sk-group' + (open ? '' : ' is-collapsed') + '" aria-label="' + label + '">' +
          '<button class="sk-group-head" type="button" aria-expanded="' + open + '" data-scope="' + key + '">' +
            '<span class="sk-group-chevron">' + OMP.icon('chevron-r', 'sm') + '</span>' +
            '<span class="sk-group-label">' + label + '</span>' +
            '<span class="sk-group-count">' + entries.length + '</span>' +
            '<span class="sk-group-rule"></span>' +
          '</button>' +
          '<div class="sk-group-items">' + (open ? entries.map(card).join('') : '') + '</div>' +
        '</section>'
      }).join('');

      body.querySelectorAll('.sk-group-head').forEach(head => {
        head.addEventListener('click', e => {
          e.stopPropagation();
          const key = head.dataset.scope;
          if (state.collapsed.has(key)) state.collapsed.delete(key);
          else state.collapsed.add(key);
          render();
        });
      });

      body.querySelectorAll('.sk-card').forEach(el => {
        const name = el.dataset.name;
        const it = items.find(x => x.name === name);
        if (!it) return;
        el.addEventListener('click', () => primaryItem(it));
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            primaryItem(it);
          }
        });
        el.querySelector('.add-btn') && el.querySelector('.add-btn')
          .addEventListener('click', e => {
            e.stopPropagation();
            isErr(it) ? retryItem(it) : toggleItem(it);
          });
        el.querySelector('.open-hub') && el.querySelector('.open-hub')
          .addEventListener('click', e => {
            e.stopPropagation();
            toast('在能力中心打开「' + it.name + '」', 'package');
          });
      });
    }

    function card(it) {
      const err = isErr(it);
      const enabled = isEnabled(it);
      const retrying = !!it.retrying;
      const iconName = ICON_BY_NAME[it.name] || (it.kind === 'plugin' ? 'plug' : 'puzzle');
      const scope = it.kind === 'skill' ? it.scope : 'plugin';
      const color = err ? 'red' : ({ workspace: 'purple', global: 'green', builtin: 'gray', plugin: 'amber' }[scope] || 'gray');
      const scopeShort = ({ workspace: 'PRJ', global: 'GLB', builtin: 'SYS', plugin: 'PLG' }[scope] || '');
      const desc = retrying ? '正在重新加载清单…' : (it.desc || (err ? it.err : '-'));
      const meta = it.kind === 'plugin' ? ((it.src || '').split('·')[0] || '').trim() : '';
      const detailMeta = it.meta || meta;

      const cls = ['sk-card'];
      if (enabled) cls.push('is-added');
      if (err) cls.push('has-error');
      if (retrying) cls.push('is-retrying');

      return (
        '<article class="' + cls.join(' ') + '" data-name="' + esc(it.name) + '"' +
          ' role="option" aria-selected="' + enabled + '" aria-disabled="' + (!enabled && it.disabled ? 'true' : 'false') + '" tabindex="0">' +
          '<span class="sk-icon ' + esc(color) + (it.kind === 'plugin' ? ' sk-icon-plugin' : '') + '">' +
            (retrying ? OMP.icon('refresh', 'sm') : OMP.icon(iconName)) +
            (enabled ? '<span class="sk-added-mark">' + OMP.icon('check', 'sm') + '</span>' : '') +
            (err && !retrying ? '<span class="sk-error-mark"></span>' : '') +
          '</span>' +
          '<div class="sk-content">' +
            '<div class="sk-row1">' +
              '<span class="sk-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
              '<span class="sk-scope sk-scope-' + esc(scope) + '">' + scopeShort + '</span>' +
              (it.kind === 'plugin' ? '<span class="sk-external">' + OMP.icon('external', 'sm') + '</span>' : '') +
            '</div>' +
            '<div class="sk-desc">' +
              (err && !retrying ? OMP.icon('alert', 'sm') : '') + esc(desc || '-') +
            '</div>' +
          '</div>' +
          '<div class="sk-action-zone">' +
            '<div class="sk-actions">' +
            (!retrying && enabled ? '<span class="sk-persistent">已加入</span>' : '') +
            (!retrying && err ? '<button class="add-btn persistent-retry" aria-label="重试加载 ' + esc(it.name) + '">' + OMP.icon('refresh', 'sm') + '重试</button>' : '') +
            (retrying ? '<span class="sk-persistent">重试中…</span>' : '') +
            (err
              ? (!retrying ? '<button class="add-btn hover-action retry-hover" aria-label="重试加载 ' + esc(it.name) + '">' + OMP.icon('refresh', 'sm') + '重试</button>' : '')
              : (!retrying && enabled
                ? '<button class="add-btn hover-action" aria-label="从当前对话移除 ' + esc(it.name) + '">' + OMP.icon('x', 'sm') + '移出</button>'
                : (!retrying ? '<button class="add-btn hover-action" aria-label="把 ' + esc(it.name) + ' 加入当前对话">' + OMP.icon('plus', 'sm') + '加入</button>' : ''))) +
            '<button class="icon-btn open-hub" data-tip="打开能力中心" aria-label="打开能力中心查看 ' + esc(it.name) + '">' +
              OMP.icon('more') + '</button>' +
            (!retrying && !enabled && !err && detailMeta ? '<span class="sk-meta">' + esc(detailMeta) + '</span>' : '') +
            '</div>' +
          '</div>' +
        '</article>'
      );
    }

    function primaryItem(it) {
      if (isErr(it)) return retryItem(it);
      if (it.kind === 'plugin') {
        toast('插件「' + it.name + '」已是会话级加载（点击进入能力中心管理）', 'plug');
        return;
      }
      toggleItem(it);
    }

    function retryItem(it) {
      if (it.retrying) return;
      it.retrying = true;
      render();
      setTimeout(() => {
        it.retrying = false;
        render();
      }, 1600);
    }

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    /* toggleItem：在原型里只切 UI 状态并 toast，不真正变更 mock data。
       注意：不能叫 toggle —— 抽屉开关函数同名（声明在后，提升覆盖前者），
       会导致点「加入对话」变成关抽屉。 */
    function toggleItem(it) {
      if (it.kind === 'plugin') {
        /* 插件不是单对话粒度，原型只给提示 */
        toast('插件「' + it.name + '」已是会话级加载（点击进入能力中心管理）', 'plug');
        return;
      }
      it.enabled = !it.enabled;
      syncBadge();
      render();
      toast(it.enabled
        ? '已把「' + it.name + '」加入当前对话'
        : '已从当前对话移除「' + it.name + '」',
        it.enabled ? 'check' : 'x');
    }

    /* 计数同步 */
    function syncBadge() {
      const total = items.length;
      const skillN = items.filter(it => it.kind === 'skill').length;
      const pluginN = items.filter(it => it.kind === 'plugin').length;
      badge.textContent = String(items.filter(isEnabled).length);
      countLabel.textContent = String(total);
      tabs.forEach(t => {
        const c = t.dataset.cat;
        let n;
        if (c === 'all') n = total;
        else if (c === 'skill') n = skillN;
        else if (c === 'plugin') n = pluginN;
        else n = 0;
        const span = t.querySelector('.count');
        if (span) span.textContent = String(n);
      });
    }

    /* 抽屉开关 */
    function openDrawer() {
      if (state.open) return;
      state.open = true;
      layout();
      drawer.hidden = false;
      void drawer.offsetWidth;
      drawer.classList.add('open');
      drawer.setAttribute('aria-hidden', 'false');
      toggleBtn.classList.add('open');
      toggleBtn.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => searchInput && searchInput.focus());
    }
    function closeDrawer(returnFocus) {
      if (!state.open) return;
      state.open = false;
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
      toggleBtn.classList.remove('open');
      toggleBtn.setAttribute('aria-expanded', 'false');
      setTimeout(() => { if (!state.open) drawer.hidden = true; }, 260);
      if (returnFocus) toggleBtn.focus();
    }
    function toggle() { state.open ? closeDrawer(true) : openDrawer(); }

    /* 绑定 */
    toggleBtn.addEventListener('click', toggle);
    closeBtn && closeBtn.addEventListener('click', () => closeDrawer(true));
    openHubBtn && openHubBtn.addEventListener('click', () => {
      toast('进入能力中心', 'package');
      closeDrawer(false);
      /* 真实场景：OMP.router.goto('capabilities') */
    });
    tabs.forEach(t => t.addEventListener('click', () => {
      tabs.forEach(x => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
      t.classList.add('active');
      t.setAttribute('aria-selected', 'true');
      state.cat = t.dataset.cat;
      render();
    }));
    searchInput && searchInput.addEventListener('input', e => {
      state.q = e.target.value; render();
    });

    /* 全局键盘：Esc 关闭 / / 聚焦 / Ctrl+Shift+K 切换 / Ctrl+Shift+O 新建 */
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.open) {
        e.preventDefault(); closeDrawer(true); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
        e.preventDefault(); toggle(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        if (state.open) closeDrawer(false);
        toast('已新建空对话', 'plus');
        return;
      }
      if (state.open && e.key === '/' &&
          document.activeElement !== searchInput) {
        e.preventDefault(); searchInput.focus();
      }
    });

    /* 侧栏尺寸变化时重定位 */
    if (window.ResizeObserver) {
      new ResizeObserver(() => { if (state.open) layout(); }).observe(sb);
    } else {
      window.addEventListener('resize', () => { if (state.open) layout(); });
    }

    syncBadge();
    render();

    /* 对外暴露 API */
    window.OMP_SKILLS_DRAWER = {
      open: openDrawer, close: closeDrawer, toggle, isOpen: () => state.open
    };
  }

  /* ---------------- 绑定 ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    renderProjects();
    renderTree();
    renderTopbar();
    applySidebarLayout();
    initSidebarDrag();

    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('#btnAppMenu', e => openOverlay(appMenu(), e.currentTarget));
    on('#btnNewConvo', () => {
      // 关闭抽屉再 toast：避免「新建」之后按钮被遮
      if (window.OMP_SKILLS_DRAWER && window.OMP_SKILLS_DRAWER.isOpen()) {
        window.OMP_SKILLS_DRAWER.close(false);
      }
      toast('已新建空对话（原型不真正创建）', 'plus');
    });
    /* #btnSkills 的点击事件由 initSkillsDrawer() 内部直接 addEventListener 绑定，
       避免与此处 on() 形成两个互斥 toggle —— 否则一次点击开+关互相抵消。
       这里只保留键盘快捷键（CPA/Super 单独处理）。 */
    on('#btnSearch', () => openPalette());
    on('#btnOmpMenu', e => openOverlay(ompMenu(document.body.dataset.ompDown === '1'), e.currentTarget, 'up-left'));
    on('#btnToggleSidebar', toggleSidebar);
    on('#brandHome', () => OMP.router.goto('workbench'));
    on('#btnHistory', () => OMP.router.goto('history'));
    on('#btnAgentHub', () => OMP.router.goto('agent-hub'));
    on('#btnNewProject', () => toast('新建项目（原型不真正创建）', 'folder-open'));

    // 初始化侧栏技能抽屉（依赖 OMP_DATA.skills / OMP_DATA.plugins）
    initSkillsDrawer();

    // Explorer 操作组：新建文件 / 新建目录 / 搜索文件 / 刷新
    $$('#sbFiles .sb-head-actions .icon-btn').forEach(b => b.addEventListener('click', () => {
      const tip = b.getAttribute('data-tip');
      if (tip === '新建文件') toast('新建文件（原型不真正创建）', 'plus');
      else if (tip === '新建目录') toast('新建目录（原型不真正创建）', 'folder');
      else if (tip === '搜索文件') { OMP.ui.openPalette(); }
      else if (tip === '刷新') toast('文件树已刷新', 'refresh');
    }));

    // Names every icon-only control in the static shell from its data-tip.
    labelIconButtons();

    document.addEventListener('keydown', e => {
      // 快捷键属于工作台视图：二级页原本没有这些绑定，SPA 下保持一致，
      // 只在工作台视图响应（否则命令面板/侧栏会在二级页也弹出来）。
      if (!OMP.router.isWorkbench()) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
    });
  });

  OMP.ui.openPalette = openPalette;
  OMP.ui.renderProjects = renderProjects;
})();
