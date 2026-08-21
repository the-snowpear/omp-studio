/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — mock workspaces + file tree
     Data has to read as real: believable paths, branches, dirty state.
     ========================================================================== */

  const WORKSPACES = [
    {
      id: 'ws-omp-web',
      name: 'omp-web',
      path: 'C:\\Aspace\\Tools\\omp-web',
      kind: 'git',
      branch: 'feat/rpc-capability-probe',
      upstream: 'origin/main',
      ahead: 3,
      behind: 0,
      dirty: true,
      dirtyCount: 7,
      running: true,
      needsAttention: true,
      previewRunning: true,
      previewUrl: 'http://localhost:5173/',
      lastOpened: '刚刚',
      pinned: true,
    },
    {
      id: 'ws-omp-bridge',
      name: 'omp-bridge',
      path: 'C:\\Aspace\\Tools\\omp-web\\.worktrees\\bridge-rewrite',
      kind: 'worktree',
      parentId: 'ws-omp-web',
      branch: 'refactor/bridge-transport',
      upstream: 'origin/refactor/bridge-transport',
      ahead: 0,
      behind: 2,
      dirty: true,
      dirtyCount: 2,
      running: false,
      needsAttention: false,
      previewRunning: false,
      lastOpened: '2 小时前',
      pinned: false,
    },
    {
      id: 'ws-scratch',
      name: 'scratch-mcp-probe',
      path: 'C:\\Users\\the_snowpear\\AppData\\Local\\Temp\\omp-scratch-8f21',
      kind: 'temp',
      branch: null,
      dirty: false,
      dirtyCount: 0,
      running: false,
      needsAttention: false,
      previewRunning: false,
      lastOpened: '昨天',
      pinned: false,
    },
  ];

  /* ---- File tree ---------------------------------------------------------
     status: null | 'M' | 'A' | 'D' | 'R' | 'U' | 'C'
     activity: null | 'reading' | 'writing' | 'turn-modified' | 'unsaved'
     diagnostics: number of errors on this file
     ------------------------------------------------------------------------ */
  const FILE_TREE = {
    'ws-omp-web': [
      { name: '.claude', type: 'dir', depth: 0, children: [
        { name: 'settings.json', type: 'file', depth: 1 },
        { name: 'agents', type: 'dir', depth: 1, children: [
          { name: 'reviewer.md', type: 'file', depth: 2 },
        ]},
      ]},
      { name: '.github', type: 'dir', depth: 0, children: [
        { name: 'workflows', type: 'dir', depth: 1, children: [
          { name: 'ci.yml', type: 'file', depth: 2, status: 'M' },
          { name: 'release.yml', type: 'file', depth: 2 },
        ]},
      ]},
      { name: 'app', type: 'dir', depth: 0, expanded: true, children: [
        { name: 'api', type: 'dir', depth: 1, children: [
          { name: 'rpc', type: 'dir', depth: 2, children: [
            { name: 'route.ts', type: 'file', depth: 3, status: 'M', activity: 'turn-modified' },
          ]},
        ]},
        { name: 'layout.tsx', type: 'file', depth: 1 },
        { name: 'page.tsx', type: 'file', depth: 1, status: 'M', activity: 'turn-modified' },
        { name: 'globals.css', type: 'file', depth: 1 },
      ]},
      { name: 'bin', type: 'dir', depth: 0, children: [
        { name: 'omp-web.mjs', type: 'file', depth: 1 },
      ]},
      { name: 'components', type: 'dir', depth: 0, expanded: true, children: [
        { name: 'bridge', type: 'dir', depth: 1, expanded: true, children: [
          { name: 'CapabilityProbe.tsx', type: 'file', depth: 2, status: 'A', activity: 'writing' },
          { name: 'RpcClient.ts', type: 'file', depth: 2, status: 'M', activity: 'turn-modified', diagnostics: 2 },
          { name: 'Transport.ts', type: 'file', depth: 2, status: 'M' },
          { name: 'index.ts', type: 'file', depth: 2, status: 'M' },
        ]},
        { name: 'DirectoryPicker.tsx', type: 'file', depth: 1 },
        { name: 'MermaidBlock.tsx', type: 'file', depth: 1, status: 'R', renamedFrom: 'Mermaid.tsx' },
        { name: 'MessageList.tsx', type: 'file', depth: 1, activity: 'reading' },
        { name: 'Composer.tsx', type: 'file', depth: 1, activity: 'unsaved' },
      ]},
      { name: 'docs', type: 'dir', depth: 0, children: [
        { name: 'rpc-protocol.md', type: 'file', depth: 1, status: 'M' },
        { name: 'capabilities.md', type: 'file', depth: 1, status: 'A' },
      ]},
      { name: 'hooks', type: 'dir', depth: 0, children: [
        { name: 'useCodeTheme.ts', type: 'file', depth: 1 },
        { name: 'useRpc.ts', type: 'file', depth: 1, status: 'M', diagnostics: 1 },
      ]},
      { name: 'lib', type: 'dir', depth: 0, children: [
        { name: 'capability.ts', type: 'file', depth: 1, status: 'A' },
        { name: 'protocol.ts', type: 'file', depth: 1, status: 'C' },
        { name: 'session.ts', type: 'file', depth: 1 },
        { name: 'legacy-transport.ts', type: 'file', depth: 1, status: 'D' },
      ]},
      { name: 'public', type: 'dir', depth: 0, children: [
        { name: 'logo.svg', type: 'file', depth: 1 },
        { name: 'preview.png', type: 'file', depth: 1, status: 'U' },
      ]},
      { name: '.gitignore', type: 'file', depth: 0 },
      { name: 'AGENTS.md', type: 'file', depth: 0, status: 'M' },
      { name: 'README.md', type: 'file', depth: 0 },
      { name: 'bun.lockb', type: 'file', depth: 0, status: 'M', binary: true },
      { name: 'package.json', type: 'file', depth: 0, status: 'M' },
      { name: 'tsconfig.json', type: 'file', depth: 0 },
    ],

    'ws-omp-bridge': [
      { name: 'src', type: 'dir', depth: 0, expanded: true, children: [
        { name: 'transport.rs', type: 'file', depth: 1, status: 'M' },
        { name: 'main.rs', type: 'file', depth: 1, status: 'M' },
      ]},
      { name: 'Cargo.toml', type: 'file', depth: 0 },
    ],

    'ws-scratch': [
      { name: 'probe.ts', type: 'file', depth: 0 },
      { name: 'package.json', type: 'file', depth: 0 },
    ],
  };

  /* Flatten a tree honoring expansion state */
  function flattenTree(nodes, expandedDirs, out = []) {
    nodes.forEach(node => {
      out.push(node);
      if (node.type === 'dir') {
        const isExpanded = expandedDirs.includes(pathOf(node)) || node.expanded;
        if (isExpanded && node.children) {
          flattenTree(node.children, expandedDirs, out);
        }
      }
    });
    return out;
  }

  function pathOf(node, parents = []) {
    return [...parents, node.name].join('/');
  }

  /* Git status → human label. Used by the tree and the Changes list so
     they can never describe the same state with different words. */
  const GIT_STATUS_LABEL = {
    M: '已修改',
    A: '新增',
    D: '已删除',
    R: '重命名',
    U: '未跟踪',
    C: '冲突',
  };

  const GIT_STATUS_COLOR = {
    M: 'var(--git-modified)',
    A: 'var(--git-added)',
    D: 'var(--git-deleted)',
    R: 'var(--git-renamed)',
    U: 'var(--git-untracked)',
    C: 'var(--git-conflict)',
  };


  OMP.mod['data/workspaces'] = { flattenTree, pathOf, WORKSPACES, FILE_TREE, GIT_STATUS_LABEL, GIT_STATUS_COLOR };
})(window.OMP = window.OMP || { mod: {} });
