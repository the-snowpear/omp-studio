/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — sidebar.js
     The composite left rail. Four zones:
       1. header      — app menu, brand, new, search
       2. threads     — projects + their threads
       3. files       — file tree for the active project/worktree
       4. footer      — user + global OMP status (env menu)

     Layout state is per-project and persisted. The system never adjusts a
     ratio the user set by hand.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon, fileIcon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { showPopover, closePopover, menuItem, menuSep, menuGroupLabel, attachContextMenu, makeResizer, animateLayout, iconBtn, attachTooltip, elidePath, showDialog, closeDialog } = OMP.mod['js/ui'];
    const { WORKSPACES, FILE_TREE, GIT_STATUS_LABEL } = OMP.mod['data/workspaces'];
    const { THREADS, THREAD_STATUS, threadsFor } = OMP.mod['data/threads'];
    const { OMP_STATUS_LABEL } = OMP.mod['data/diagnostics'];
  /* Three divider presets, cycled by double-click */
  const RATIO_PRESETS = [
    { ratio: 0.5, label: '上下平分' },
    { ratio: 0.75, label: '项目与对话为主' },
    { ratio: 0.25, label: '文件树为主' },
  ];

  function createSidebar() {
    const el = h('aside', { class: 'sidebar', 'aria-label': '侧栏' });

    const header = h('div', { class: 'sidebar-header' });
    const body = h('div', { class: 'sidebar-body' });
    const footer = h('button', { class: 'sidebar-footer' });

    const threadsSection = h('div', { class: 'sidebar-section' });
    const divider = h('div', {
      class: 'sidebar-divider',
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': '调整项目与文件树的比例',
      tabindex: '0',
    });
    const filesSection = h('div', { class: 'sidebar-section' });

    body.append(threadsSection, divider, filesSection);
    el.append(header, body, footer);

    /* ---- Header ---------------------------------------------------------- */
    function renderHeader() {
      clear(header);

      const logo = h('button', {
        class: 'sidebar-header-logo',
        'aria-label': '应用菜单',
        onclick: (e) => { e.stopPropagation(); openAppMenu(logo); },
      }, icon('pi', 'icon-lg'));

      attachTooltip(logo, '应用菜单');

      header.append(
        logo,
        h('span', { class: 'sidebar-header-title' }, 'OMP Studio'),
        h('div', { class: 'sidebar-header-actions' },
          iconBtn('search', '统一搜索', () => openSearch(), { small: true, kbd: '⌘K' }),
          (() => {
            const b = iconBtn('plus', '新建', (e) => openNewMenu(e.currentTarget), { small: true, kbd: '⌘N' });
            return b;
          })(),
        ),
      );
    }

    /* ---- Threads section ------------------------------------------------- */
    function renderThreads() {
      clear(threadsSection);

      const layout = store.getProjectLayout();
      threadsSection.classList.toggle('sidebar-section-collapsed', layout.threadsCollapsed);

      const head = h('div', { class: 'sidebar-section-header' },
        h('button', {
          class: 'section-collapse-btn',
          'aria-label': layout.threadsCollapsed ? '展开项目与对话' : '收起项目与对话',
          'aria-expanded': String(!layout.threadsCollapsed),
          onclick: () => animateLayout(() => {
            store.setProjectLayout({ threadsCollapsed: !layout.threadsCollapsed });
          }),
        }, icon('chevronRight', 'icon-sm')),
        h('span', { class: 'section-label' }, '项目与对话'),
        h('div', { class: 'sidebar-section-actions' },
          iconBtn('plus', '新建对话', () => newThread(), { small: true }),
          iconBtn('refresh', '刷新', () => store.toast('已刷新项目列表', 'ok'), { small: true }),
        ),
      );

      const list = h('div', { class: 'sidebar-section-body' });

      WORKSPACES.forEach(ws => {
        const expanded = layout.expandedProjects.includes(ws.id);
        list.appendChild(renderProjectRow(ws, expanded, layout));

        if (expanded) {
          const threads = threadsFor(ws.id);
          if (!threads.length) {
            list.appendChild(
              h('div', { class: 'sidebar-empty' },
                h('div', { class: 'sidebar-empty-text' }, '还没有对话'),
                h('button', {
                  class: 'btn btn-sm btn-outline sidebar-empty-action',
                  onclick: () => newThread(ws.id),
                }, '新建对话'),
              )
            );
          }
          threads.forEach(t => list.appendChild(renderThreadRow(t)));
        }
      });

      threadsSection.append(head, list);
    }

    function renderProjectRow(ws, expanded, layout) {
      const active = store.get('activeProjectId') === ws.id;

      const row = h('div', {
        class: 'project-row',
        role: 'treeitem',
        'aria-expanded': String(expanded),
        data: active ? { active: 'true' } : {},
        tabindex: '0',
        onclick: () => {
          const next = expanded
            ? layout.expandedProjects.filter(id => id !== ws.id)
            : [...layout.expandedProjects, ws.id];
          store.setProjectLayout({ expandedProjects: next });
          store.set({ activeProjectId: ws.id });
        },
      },
        h('span', {
          class: 'project-row-icon',
          style: { transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' },
        }, icon('chevronRight', 'icon-sm')),
        icon(ws.kind === 'worktree' ? 'gitBranch' : ws.kind === 'temp' ? 'flask' : 'folder', 'icon-sm'),
        h('div', { class: 'project-row-info' },
          h('div', { class: 'project-row-name' }, ws.name),
          h('div', { class: 'project-row-path', title: ws.path }, elidePath(ws.path, 32)),
        ),
        h('div', { class: 'project-row-meta' },
          ws.branch ? h('span', { class: 'project-row-branch' },
            icon('gitBranch', 'icon-sm'),
            ws.branch.length > 14 ? ws.branch.slice(0, 13) + '…' : ws.branch,
          ) : null,
          h('div', { class: 'status-dots' },
            ws.dirty ? mkDot('dirty', `${ws.dirtyCount} 个未提交修改`) : null,
            ws.running ? mkDot('run', '有任务正在运行') : null,
            ws.needsAttention ? mkDot('warn', '需要你处理') : null,
            ws.previewRunning ? mkDot('preview', 'Preview 正在运行') : null,
          ),
        ),
      );

      attachContextMenu(row, () => [
        menuItem('新建对话', { iconName: 'plus', onClick: () => newThread(ws.id) }),
        menuItem('新建 Worktree 对话', { iconName: 'gitBranch', onClick: () => store.toast('已创建 Worktree 对话', 'ok') }),
        menuSep(),
        menuItem('打开项目目录', { iconName: 'folderOpen', onClick: () => store.toast(`已打开 ${ws.path}`, 'ok') }),
        menuItem('在终端中打开', { iconName: 'terminal', onClick: () => store.set({ bottomPanelOpen: true, bottomPanelTab: 'terminal' }) }),
        menuItem('在外部编辑器中打开', { iconName: 'externalLink', onClick: () => store.toast('已在 VS Code 中打开', 'ok') }),
        menuSep(),
        menuItem(ws.pinned ? '取消固定' : '固定项目', { iconName: 'pin', onClick: () => store.toast(ws.pinned ? '已取消固定' : '已固定', 'ok') }),
        menuItem('重命名显示名称', { iconName: 'edit', onClick: () => store.toast('重命名', 'info') }),
        menuSep(),
        menuItem('关闭项目', { iconName: 'close', onClick: () => store.toast('已关闭项目', 'ok') }),
        menuItem('从最近项目中移除', { iconName: 'trash', danger: true, onClick: () => store.toast('已移除', 'ok') }),
      ]);

      return row;
    }

    function mkDot(kind, tip) {
      const d = h('span', { class: `status-dot status-dot-${kind}` });
      attachTooltip(d, tip);
      return d;
    }

    function renderThreadRow(t) {
      const active = store.get('activeThreadId') === t.id;
      const st = THREAD_STATUS[t.status];

      const row = h('div', {
        class: 'thread-row',
        role: 'treeitem',
        tabindex: '0',
        data: {
          ...(active ? { active: 'true' } : {}),
          status: t.status,
          archived: String(t.archived),
          pinned: String(t.pinned),
        },
        onclick: () => selectThread(t),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectThread(t); } },
      },
        h('span', { class: 'thread-row-status' },
          st.icon ? icon(st.icon, 'icon-sm') : h('span', { class: 'dot dot-muted' })),
        h('div', { class: 'thread-row-info' },
          h('div', { class: 'thread-row-title', title: t.title }, t.title),
          h('div', { class: 'thread-row-meta' },
            h('span', { class: 'thread-row-meta-item' }, st.label),
            h('span', { class: 'thread-row-meta-item' }, t.updatedAt),
            h('span', { class: 'thread-row-meta-item' }, `${t.messageCount} msgs`),
          ),
        ),
        h('div', { class: 'thread-row-badges' },
          t.subagentCount > 0 ? (() => {
            const b = h('span', { class: 'thread-row-badge' },
              icon('toolSubagent', 'icon-sm'), String(t.subagentCount));
            attachTooltip(b, `${t.subagentCount} 个子 Agent`);
            return b;
          })() : null,
          t.needsApproval ? (() => {
            const b = h('span', { class: 'thread-row-badge thread-row-badge-warn' }, icon('shield', 'icon-sm'));
            attachTooltip(b, '等待审批');
            return b;
          })() : null,
          t.status === 'failed' ? (() => {
            const b = h('span', { class: 'thread-row-badge thread-row-badge-danger' }, icon('alertCircle', 'icon-sm'));
            attachTooltip(b, t.lastError || '任务失败');
            return b;
          })() : null,
          t.archived ? icon('archive', 'icon-sm') : null,
        ),
        t.hasNewEvents && !active ? h('span', { class: 'thread-row-new' }) : null,
      );

      attachContextMenu(row, () => [
        menuItem('打开', { iconName: 'arrowRight', onClick: () => selectThread(t) }),
        menuItem('重命名', { iconName: 'edit', onClick: () => store.toast('重命名对话', 'info') }),
        menuItem('Fork', { iconName: 'gitFork', onClick: () => store.toast(`已从「${t.title}」Fork`, 'ok') }),
        menuItem('在新窗口打开', { iconName: 'externalLink', onClick: () => store.toast('已在新窗口打开', 'ok') }),
        menuSep(),
        menuItem(t.pinned ? '取消固定' : '固定', { iconName: 'pin', onClick: () => store.toast(t.pinned ? '已取消固定' : '已固定', 'ok') }),
        menuItem('导出', { iconName: 'download', onClick: () => store.toast('已导出为 Markdown', 'ok') }),
        menuItem(t.archived ? '取消归档' : '归档', { iconName: 'archive', onClick: () => store.toast(t.archived ? '已取消归档' : '已归档', 'ok') }),
        menuSep(),
        menuItem('删除', { iconName: 'trash', danger: true, onClick: () => confirmDeleteThread(t) }),
      ]);

      return row;
    }

    function selectThread(t) {
      /* Switching threads must never lose the draft — store.drafts is keyed
         by thread id, so nothing needs clearing here. */
      store.set({ activeThreadId: t.id, activeProjectId: t.projectId });
    }

    function confirmDeleteThread(t) {
      showDialog({
        title: '删除对话',
        iconName: 'trash',
        desc: `「${t.title}」将被永久删除。`,
        body: h('div', {},
          h('div', { class: 'impact-list' },
            impactItem('trash', `${t.messageCount} 条消息将被删除`, 'danger'),
            impactItem('file', `${t.filesChanged} 个文件的修改记录将丢失`, 'danger'),
            impactItem('checkCircle', '工作区中的文件不会被还原', 'ok'),
          ),
        ),
        footer: [
          h('button', { class: 'btn btn-outline', onclick: closeDialog }, '取消'),
          h('button', {
            class: 'btn btn-danger-solid',
            onclick: () => { closeDialog(); store.toast(`已删除「${t.title}」`, 'ok'); },
          }, '删除对话'),
        ],
      });
    }

    /* ---- Files section --------------------------------------------------- */
    function renderFiles() {
      clear(filesSection);

      const layout = store.getProjectLayout();
      filesSection.classList.toggle('sidebar-section-collapsed', layout.filesCollapsed);

      const head = h('div', { class: 'sidebar-section-header' },
        h('button', {
          class: 'section-collapse-btn',
          'aria-label': layout.filesCollapsed ? '展开文件树' : '收起文件树',
          'aria-expanded': String(!layout.filesCollapsed),
          onclick: () => animateLayout(() => {
            store.setProjectLayout({ filesCollapsed: !layout.filesCollapsed });
          }),
        }, icon('chevronRight', 'icon-sm')),
        h('span', { class: 'section-label' }, 'Explorer'),
        h('div', { class: 'sidebar-section-actions' },
          iconBtn('search', '搜索文件', () => store.toast('文件搜索', 'info'), { small: true }),
          iconBtn('filePlus', '新建文件', () => store.toast('新建文件', 'info'), { small: true }),
          iconBtn('folderPlus', '新建目录', () => store.toast('新建目录', 'info'), { small: true }),
          iconBtn('refresh', '刷新', () => store.toast('已刷新文件树', 'ok'), { small: true }),
        ),
      );

      const list = h('div', { class: 'sidebar-section-body' });
      const tree = FILE_TREE[store.get('activeProjectId')] || [];
      renderTreeNodes(tree, list, layout, []);

      filesSection.append(head, list);
    }

    function renderTreeNodes(nodes, container, layout, parents) {
      nodes.forEach(node => {
        const path = [...parents, node.name].join('/');
        const isDir = node.type === 'dir';
        const expanded = isDir && (layout.expandedDirs.includes(path) || node.expanded);

        container.appendChild(renderTreeRow(node, path, expanded, layout));

        if (isDir && expanded && node.children) {
          renderTreeNodes(node.children, container, layout, [...parents, node.name]);
        }
      });
    }

    function renderTreeRow(node, path, expanded, layout) {
      const isDir = node.type === 'dir';
      const active = store.get('activeFile') === path;

      const row = h('div', {
        class: 'tree-row',
        role: 'treeitem',
        tabindex: '0',
        title: path,
        style: { '--depth': String(node.depth) },
        data: {
          type: node.type,
          expanded: String(expanded),
          ...(active ? { active: 'true' } : {}),
          ...(node.activity ? { activity: node.activity } : {}),
          ...(node.diagnostics ? { diagnostics: String(node.diagnostics) } : {}),
        },
        onclick: () => {
          if (isDir) {
            const next = expanded
              ? layout.expandedDirs.filter(p => p !== path)
              : [...layout.expandedDirs, path];
            store.setProjectLayout({ expandedDirs: next });
          } else {
            store.set({ activeFile: path });
          }
        },
      },
        h('span', { class: 'tree-row-expand' }, isDir ? icon('chevronRight', 'icon-sm') : null),
        h('span', { class: 'tree-row-icon' },
          icon(isDir ? (expanded ? 'folderOpen' : 'folder') : fileIcon(node.name), 'icon-sm')),
        h('span', { class: 'tree-row-label' }, node.name),
        node.status
          ? (() => {
              const s = h('span', { class: `tree-row-status tree-row-status-${node.status}` }, node.status);
              attachTooltip(s, node.renamedFrom
                ? `${GIT_STATUS_LABEL[node.status]} · 原名 ${node.renamedFrom}`
                : GIT_STATUS_LABEL[node.status]);
              return s;
            })()
          : null,
      );

      /* Activity states carry their own explanation — color alone is not
         enough to tell "OMP is reading" from "OMP is writing". */
      if (node.activity) {
        const labels = {
          reading: 'OMP 正在读取',
          writing: 'OMP 正在写入',
          'turn-modified': '本轮修改',
          unsaved: '手动编辑但尚未保存',
        };
        attachTooltip(row, labels[node.activity] || node.activity);
      }

      attachContextMenu(row, () => [
        !isDir ? menuItem('打开文件', { iconName: 'file', onClick: () => store.set({ activeFile: path }) }) : null,
        !isDir ? menuItem('打开 Diff', { iconName: 'columns', onClick: () => {
          store.set({ activeDiffFile: path, mainPrimary: 'diff', mainLayout: 'single' });
        }}) : null,
        menuSep(),
        menuItem('添加到当前对话上下文', { iconName: 'paperclip', onClick: () => store.toast(`已添加 ${node.name} 到上下文`, 'ok') }),
        menuItem('请求 OMP 修改此文件', { iconName: 'sparkles', onClick: () => store.toast(`已请求修改 ${node.name}`, 'info') }),
        menuSep(),
        menuItem('重命名', { iconName: 'edit', onClick: () => store.toast('重命名', 'info') }),
        menuItem('复制路径', { iconName: 'copy', onClick: () => store.toast('路径已复制', 'ok') }),
        menuItem('在系统文件管理器中显示', { iconName: 'folderOpen', onClick: () => store.toast('已在资源管理器中显示', 'ok') }),
        menuItem('在外部编辑器中打开', { iconName: 'externalLink', onClick: () => store.toast('已在 VS Code 中打开', 'ok') }),
        menuSep(),
        menuItem('删除', { iconName: 'trash', danger: true, onClick: () => store.toast(`已删除 ${node.name}`, 'ok') }),
      ].filter(Boolean));

      return row;
    }

    /* ---- Divider: drag + double-click preset cycle ----------------------- */
    let hintEl = null;

    makeResizer(divider, {
      axis: 'y',
      onMove: (delta) => {
        const rect = body.getBoundingClientRect();
        const layout = store.getProjectLayout();
        const current = layout.splitRatio * rect.height;
        const next = Math.min(Math.max(current + delta, 80), rect.height - 80);
        applyRatio(next / rect.height, false);
      },
      onEnd: () => {
        const rect = body.getBoundingClientRect();
        const h1 = threadsSection.getBoundingClientRect().height;
        store.setProjectLayout({ splitRatio: h1 / rect.height });
      },
    });

    divider.addEventListener('dblclick', () => {
      const layout = store.getProjectLayout();
      const idx = RATIO_PRESETS.findIndex(p => Math.abs(p.ratio - layout.splitRatio) < 0.04);
      const next = RATIO_PRESETS[(idx + 1) % RATIO_PRESETS.length];

      animateLayout(() => {
        store.setProjectLayout({ splitRatio: next.ratio, threadsCollapsed: false, filesCollapsed: false });
      });
      showRatioHint(next.label);
    });

    divider.addEventListener('keydown', (e) => {
      const layout = store.getProjectLayout();
      const step = 0.05;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        store.setProjectLayout({ splitRatio: Math.max(0.1, layout.splitRatio - step) });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        store.setProjectLayout({ splitRatio: Math.min(0.9, layout.splitRatio + step) });
      }
    });

    function showRatioHint(label) {
      hintEl?.remove();
      hintEl = h('div', { class: 'sidebar-divider-hint' }, label);
      divider.appendChild(hintEl);
      setTimeout(() => { hintEl?.remove(); hintEl = null; }, 1200);
    }

    function applyRatio(ratio, persist = true) {
      const layout = store.getProjectLayout();
      const bothOpen = !layout.threadsCollapsed && !layout.filesCollapsed;

      if (layout.threadsCollapsed && layout.filesCollapsed) {
        threadsSection.style.flex = '0 0 auto';
        filesSection.style.flex = '0 0 auto';
        divider.style.display = 'none';
        return;
      }

      divider.style.display = bothOpen ? 'flex' : 'none';

      if (layout.threadsCollapsed) {
        threadsSection.style.flex = '0 0 auto';
        filesSection.style.flex = '1 1 auto';
      } else if (layout.filesCollapsed) {
        threadsSection.style.flex = '1 1 auto';
        filesSection.style.flex = '0 0 auto';
      } else {
        threadsSection.style.flex = `${ratio} 1 0`;
        filesSection.style.flex = `${1 - ratio} 1 0`;
      }

      if (persist) store.setProjectLayout({ splitRatio: ratio });
    }

    /* ---- Footer: OMP global status --------------------------------------- */
    function renderFooter() {
      clear(footer);

      const status = store.get('ompStatus');
      const info = OMP_STATUS_LABEL[status];

      footer.setAttribute('data-status', status);
      footer.setAttribute('aria-label', `OMP 状态：${info.text}`);
      footer.onclick = (e) => { e.stopPropagation(); openOmpMenu(footer); };

      footer.append(
        h('span', { class: 'sidebar-footer-avatar' }, 'N'),
        h('div', { class: 'sidebar-footer-info' },
          h('div', { class: 'sidebar-footer-name' }, 'the_snowpear'),
          /* Only the global OMP state lives here — never session data. */
          h('div', { class: 'sidebar-footer-status' }, info.text),
        ),
        h('span', { class: 'sidebar-footer-chevron' }, icon('chevronUp', 'icon-sm')),
      );
    }

    /* ---- Menus ----------------------------------------------------------- */
    function openAppMenu(anchor) {
      showPopover(anchor, [
        menuGroupLabel('新建'),
        menuItem('新建对话', { iconName: 'plus', hint: '⌘N', onClick: () => newThread() }),
        menuItem('打开本地项目', { iconName: 'folderOpen', hint: '⌘O', onClick: () => store.toast('打开项目', 'info') }),
        menuItem('克隆 Git 仓库', { iconName: 'gitBranch', onClick: () => store.toast('克隆仓库', 'info') }),
        menuItem('创建临时工作区', { iconName: 'flask', onClick: () => store.toast('已创建临时工作区', 'ok') }),
        menuSep(),
        menuGroupLabel('切换'),
        menuItem('切换项目', { iconName: 'layers', hint: '⌘P', onClick: () => store.toast('切换项目', 'info') }),
        menuItem('最近项目', { iconName: 'clock', onClick: () => store.set({ screen: 'project-home' }) }),
        menuItem('最近对话', { iconName: 'history', onClick: () => store.set({ screen: 'history' }) }),
        menuItem('打开会话历史', { iconName: 'history', onClick: () => store.set({ screen: 'history' }) }),
        menuSep(),
        menuGroupLabel('查找'),
        menuItem('全局搜索', { iconName: 'search', hint: '⌘⇧F', onClick: () => openSearch() }),
        menuItem('Command Palette', { iconName: 'command', hint: '⌘K', onClick: () => store.set({ paletteOpen: true }) }),
        menuSep(),
        menuGroupLabel('工具'),
        menuItem('打开终端', { iconName: 'terminal', hint: '⌃`', onClick: () => store.set({ bottomPanelOpen: true, bottomPanelTab: 'terminal' }) }),
        menuItem('在外部编辑器中打开当前项目', { iconName: 'externalLink', onClick: () => store.toast('已在 VS Code 中打开', 'ok') }),
        menuItem('打开系统文件管理器', { iconName: 'folderOpen', onClick: () => store.toast('已打开资源管理器', 'ok') }),
        menuItem('打开 OMP 配置目录', { iconName: 'settings', onClick: () => store.toast('已打开 ~/.omp/agent/', 'ok') }),
        menuSep(),
        menuItem('设置', { iconName: 'settings', hint: '⌘,', onClick: () => store.set({ screen: 'settings' }) }),
        menuItem('快捷键', { iconName: 'keyboard', hint: '⌘/', onClick: () => showShortcuts() }),
        menuItem('关于 OMP Studio', { iconName: 'info', onClick: () => showAbout() }),
      ], { placement: 'bottom-start' });
    }

    function openNewMenu(anchor) {
      showPopover(anchor, [
        menuItem('新建对话', { iconName: 'plus', hint: '⌘N', onClick: () => newThread() }),
        menuItem('在当前项目中开始', { iconName: 'folder', onClick: () => newThread() }),
        menuItem('在新 Worktree 中开始', { iconName: 'gitBranch', onClick: () => store.toast('已创建 Worktree 对话', 'ok') }),
        menuSep(),
        menuItem('打开新项目', { iconName: 'folderOpen', onClick: () => store.toast('打开项目', 'info') }),
        menuItem('克隆仓库', { iconName: 'gitFork', onClick: () => store.toast('克隆仓库', 'info') }),
        menuItem('创建临时工作区', { iconName: 'flask', onClick: () => store.toast('已创建临时工作区', 'ok') }),
      ], { placement: 'bottom-end' });
    }

    /* The OMP env menu holds GLOBAL environment actions only.
       No model, thinking level, permission mode, token, cost, agent count,
       task state, approval, preview or file-change info may appear here. */
    function openOmpMenu(anchor) {
      const status = store.get('ompStatus');
      const info = OMP_STATUS_LABEL[status];
      const err = store.get('ompError');
      const updateAvailable = status === 'update-available';

      footer.setAttribute('data-menu-open', 'true');

      showPopover(anchor, [
        h('div', { class: 'menu-header' },
          h('div', { class: 'menu-header-title' }, icon('pi', 'icon'), 'OMP'),
          h('div', { class: 'menu-header-meta' },
            h('span', { class: `dot dot-${info.tone}` }),
            info.text,
            h('span', {}, '·'),
            h('span', { style: { fontFamily: 'var(--font-mono)' } }, `v${store.get('ompVersion')}`),
          ),
        ),
        err ? h('div', { class: 'menu-error' },
          icon('alertCircle', 'icon-sm'),
          h('div', {}, err),
        ) : null,
        err ? menuItem('重新连接', { iconName: 'refresh', onClick: () => reconnect() }) : null,
        err ? menuSep() : null,
        menuItem('重启 OMP Bridge', { iconName: 'refresh', onClick: () => restartBridge() }),
        menuItem('重新检测 OMP', { iconName: 'search', onClick: () => redetect() }),
        menuItem('打开 OMP 配置', { iconName: 'settings', onClick: () => store.toast('已打开 ~/.omp/agent/config.yml', 'ok') }),
        menuItem('打开诊断中心', { iconName: 'activity', onClick: () => store.set({ screen: 'diagnostics' }) }),
        menuItem('检查更新', {
          iconName: 'download',
          badge: updateAvailable ? h('span', { class: 'badge badge-warn' }, '新') : null,
          onClick: () => checkUpdate(),
        }),
      ].filter(Boolean), {
        placement: 'top-start',
        onClose: () => footer.removeAttribute('data-menu-open'),
      });
    }

    /* ---- Actions --------------------------------------------------------- */
    function newThread(projectId) {
      store.toast('已新建对话', 'ok');
    }

    function openSearch() {
      store.set({ paletteOpen: true });
    }

    function restartBridge() {
      store.set({ ompStatus: 'starting', ompError: null });
      store.toast('正在重启 OMP Bridge…', 'info');
      setTimeout(() => {
        store.set({ ompStatus: 'ready' });
        store.toast('OMP Bridge 已重启', 'ok');
      }, 1600);
    }

    function redetect() {
      store.toast('正在重新检测 OMP…', 'info');
      setTimeout(() => store.set({ screen: 'env-check', scenario: 'env-check:ok' }), 900);
    }

    function reconnect() {
      store.set({ ompStatus: 'reconnecting' });
      setTimeout(() => {
        store.set({ ompStatus: 'ready', ompError: null });
        store.toast('已重新连接', 'ok');
      }, 1800);
    }

    function checkUpdate() {
      store.toast('正在检查更新…', 'info');
      setTimeout(() => store.toast('已是最新版本 v0.8.4', 'ok'), 1200);
    }

    function showShortcuts() {
      showDialog({
        title: '快捷键',
        iconName: 'keyboard',
        wide: true,
        body: h('div', {},
          ...[
            ['全局', [
              ['⌘K', 'Command Palette'],
              ['⌘N', '新建对话'],
              ['⌘O', '打开项目'],
              ['⌘,', '设置'],
              ['⌘⇧S', '场景切换器'],
            ]],
            ['布局', [
              ['⌘B', '切换侧栏'],
              ['⌃`', '切换底部面板'],
              ['⌘⌥B', '切换右侧面板'],
              ['⌘⇧R', '恢复默认布局'],
            ]],
            ['对话', [
              ['Enter', '发送'],
              ['⇧Enter', '换行'],
              ['⌘Enter', '加入 Follow-up 队列'],
              ['Esc', 'Abort 当前任务'],
              ['@', '引用文件 / Agent / Diff'],
              ['/', 'Slash Commands'],
            ]],
            ['导航', [
              ['⌘↑ / ⌘↓', '上一个 / 下一个用户消息'],
              ['⌘⇧E', '下一个错误'],
              ['⌘⇧M', '下一个文件修改'],
              ['⌘End', '回到最新'],
            ]],
          ].map(([group, rows]) =>
            h('div', { class: 'screen-section' },
              h('div', { class: 'section-label', style: { marginBottom: '8px' } }, group),
              h('table', { class: 'table' },
                h('tbody', {}, rows.map(([k, label]) =>
                  h('tr', {},
                    h('td', { style: { width: '160px' } }, h('kbd', {}, k)),
                    h('td', {}, label),
                  )
                )),
              ),
            )
          ),
        ),
        footer: [h('button', { class: 'btn btn-primary', onclick: closeDialog }, '知道了')],
      });
    }

    function showAbout() {
      showDialog({
        title: '关于 OMP Studio',
        iconName: 'pi',
        body: h('div', {},
          h('p', { style: { fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', lineHeight: '1.7' } },
            'OMP Studio 是 Oh My Pi (OMP) CLI 的桌面图形化客户端。Agent 运行时来自你本机安装的 OMP CLI，Studio 通过本地 Bridge 与 OMP RPC 协议控制真实进程。'),
          h('div', { class: 'diag-grid', style: { marginTop: '16px' } },
            diagField('Studio 版本', '2.0.0-preview.3'),
            diagField('OMP CLI 版本', store.get('ompVersion')),
            diagField('RPC 协议', 'v3'),
            diagField('平台', 'win32 · Windows 11'),
          ),
        ),
        footer: [
          h('button', { class: 'btn btn-outline', onclick: () => { closeDialog(); store.set({ screen: 'diagnostics' }); } }, '打开诊断中心'),
          h('button', { class: 'btn btn-primary', onclick: closeDialog }, '关闭'),
        ],
      });
    }

    /* ---- Render orchestration -------------------------------------------- */
    function render() {
      const collapsed = store.get('sidebarCollapsed');
      el.classList.toggle('sidebar-mini', collapsed);

      renderHeader();
      renderFooter();

      if (!collapsed) {
        renderThreads();
        renderFiles();
        applyRatio(store.getProjectLayout().splitRatio, false);
      } else {
        clear(threadsSection);
        clear(filesSection);
        divider.style.display = 'none';
      }
    }

    store.subscribe(
      ['activeProjectId', 'activeThreadId', 'activeFile', 'layoutByProject',
       'sidebarCollapsed', 'ompStatus', 'ompError', 'scenario'],
      render
    );

    render();

    return { el, render };
  }

  /* Small local helpers reused by dialogs above */
  function impactItem(iconName, text, tone = 'ok') {
    return h('div', { class: `impact-item impact-item-${tone}` }, icon(iconName, 'icon-sm'), text);
  }

  function diagField(label, value) {
    return h('div', { class: 'diag-field' },
      h('div', { class: 'diag-field-label' }, label),
      h('div', { class: 'diag-field-value' }, value),
    );
  }


  OMP.mod['js/components/sidebar'] = { createSidebar };
})(window.OMP = window.OMP || { mod: {} });
