/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — changes.js
     Changes list + Diff viewer (inline / split).

     Two distinctions this file exists to preserve:
     1. Provenance — 本轮 / 本 Thread / Agent 前已存在. Pre-existing rows are
        the user's own work and are never counted into OMP's totals.
     2. Verification — 工具声称写入 (declared) vs watcher 确认落盘 (confirmed).
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon, fileIcon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { iconBtn, attachTooltip, attachContextMenu, menuItem, menuSep, splitPath, showDialog, closeDialog } = OMP.mod['js/ui'];
    const { CHANGES, DIFFS, PROVENANCE_LABEL, changesByScope, changeTotals } = OMP.mod['data/changes'];
    const { GIT_STATUS_LABEL } = OMP.mod['data/workspaces'];
  /* ==========================================================================
     Changes list
     ========================================================================== */

  function createChanges() {
    const el = h('div', { class: 'changes' });
    const collapsedGroups = new Set();

    function render() {
      clear(el);

      const scope = store.get('changesScope');
      const groupBy = store.get('changesGroupBy');
      const list = changesByScope(scope);
      const totals = changeTotals(list);

      el.append(
        renderToolbar(scope, groupBy),
        renderStats(totals, scope),
        renderList(list, groupBy),
        scope !== 'pre-existing' ? renderCommitBar(totals) : null,
      );
    }

    function renderToolbar(scope, groupBy) {
      const counts = {
        turn: changesByScope('turn').length,
        thread: changesByScope('thread').length,
        'pre-existing': changesByScope('pre-existing').length,
      };

      return h('div', { class: 'changes-toolbar' },
        h('div', { class: 'changes-scope', role: 'group', 'aria-label': '变化来源' },
          scopeBtn('turn', '本轮', counts.turn, scope),
          scopeBtn('thread', '本 Thread', counts.thread, scope),
          scopeBtn('pre-existing', 'Agent 前已存在', counts['pre-existing'], scope),
        ),
        h('div', { class: 'changes-toolbar-right' },
          iconBtn('layers', `分组方式：${{ turn: 'Turn', folder: '文件夹', agent: 'Agent' }[groupBy]}`, () => {
            const order = ['turn', 'folder', 'agent'];
            const next = order[(order.indexOf(groupBy) + 1) % order.length];
            store.set({ changesGroupBy: next });
          }, { small: true }),
          iconBtn('filter', '按状态筛选', () => store.toast('按状态筛选', 'info'), { small: true }),
          iconBtn('columns', '查看全部 Diff', () => {
            store.set({ mainPrimary: 'diff', activeDiffFile: null });
          }, { small: true }),
        ),
      );
    }

    function scopeBtn(id, label, count, active) {
      const btn = h('button', {
        class: 'changes-scope-item',
        data: active === id ? { active: 'true' } : {},
        onclick: () => store.set({ changesScope: id }),
      },
        label,
        h('span', { class: 'changes-scope-count' }, String(count)),
      );

      attachTooltip(btn, {
        turn: '当前 Turn 产生的变化',
        thread: '当前 Thread 累积产生的变化',
        'pre-existing': 'Agent 开始前工作区就已存在的修改 — 不计入 OMP 统计',
      }[id]);

      return btn;
    }

    function renderStats(totals, scope) {
      return h('div', { class: 'changes-stats' },
        h('span', {}, `${totals.files} 个文件`),
        h('span', { class: 'changes-stat-add' }, `+${totals.additions}`),
        h('span', { class: 'changes-stat-del' }, `−${totals.deletions}`),
        scope === 'pre-existing'
          ? h('span', { style: { marginLeft: 'auto', color: 'var(--muted)' } }, '这些不是 OMP 的修改')
          : null,
      );
    }

    function renderList(list, groupBy) {
      const container = h('div', { class: 'changes-list' });

      if (!list.length) {
        container.appendChild(
          h('div', { class: 'empty-state' },
            icon('checkCircle', 'icon-lg'),
            h('div', { class: 'empty-state-title' }, '没有变化'),
            h('div', { class: 'empty-state-desc' }, '当前范围内没有文件改动。'),
          )
        );
        return container;
      }

      const groups = groupChanges(list, groupBy);

      Object.entries(groups).forEach(([name, items]) => {
        const collapsed = collapsedGroups.has(name);
        const gt = changeTotals(items);

        container.appendChild(
          h('div', { class: 'changes-group', data: { collapsed: String(collapsed) } },
            h('button', {
              class: 'changes-group-header',
              'aria-expanded': String(!collapsed),
              onclick: () => {
                if (collapsed) collapsedGroups.delete(name);
                else collapsedGroups.add(name);
                render();
              },
            },
              icon('chevronDown', 'icon-sm'),
              name,
              h('span', { class: 'changes-group-count' },
                `${items.length} · +${gt.additions} −${gt.deletions}`),
            ),
            h('div', { class: 'changes-group-body' }, items.map(renderRow)),
          )
        );
      });

      return container;
    }

    function groupChanges(list, groupBy) {
      const out = {};

      list.forEach(c => {
        let key;
        if (groupBy === 'turn') {
          key = c.turn ? `Turn ${c.turn}` : 'Agent 前已存在';
        } else if (groupBy === 'folder') {
          key = splitPath(c.path).dir || '(根目录)';
        } else {
          key = c.agent === 'main' ? '主 Agent' : (c.agent || '未归属');
        }
        (out[key] ||= []).push(c);
      });

      return out;
    }

    function renderRow(c) {
      const { dir, name } = splitPath(c.path);
      const active = store.get('activeDiffFile') === c.path;
      const reviewed = store.get('reviewedFiles').includes(c.path);

      const row = h('div', {
        class: 'change-row',
        data: {
          ...(active ? { active: 'true' } : {}),
          provenance: c.provenance,
          verification: c.verification,
          reviewed: String(reviewed),
          ...(c.writingNow ? { writing: 'true' } : {}),
        },
        onclick: () => store.set({ activeDiffFile: c.path, mainPrimary: 'diff' }),
      },
        /* Verification dot — hollow = tool claimed, filled = watcher confirmed */
        (() => {
          const d = h('span', { class: 'change-verify-dot' });
          attachTooltip(d, c.writingNow
            ? '正在写入…'
            : c.verification === 'declared'
              ? '工具已声明修改，文件系统尚未确认'
              : `文件系统已确认 · ${c.watcherTs}`);
          return d;
        })(),

        (() => {
          const s = h('span', { class: `change-status change-status-${c.status}` }, c.status);
          attachTooltip(s, c.renamedFrom
            ? `${GIT_STATUS_LABEL[c.status]} · 原名 ${c.renamedFrom}`
            : GIT_STATUS_LABEL[c.status]);
          return s;
        })(),

        h('div', { class: 'change-path' },
          h('div', { class: 'change-path-name' }, name),
          dir ? h('div', { class: 'change-path-dir' }, dir) : null,
        ),

        c.diagnostics
          ? h('span', { class: 'change-diagnostics' },
              icon('alertCircle', 'icon-sm'), String(c.diagnostics))
          : null,

        h('span', { class: 'change-provenance' }, PROVENANCE_LABEL[c.provenance]),

        c.binary
          ? h('span', { class: 'change-binary' }, `二进制 · ${c.sizeBefore || '—'} → ${c.sizeAfter}`)
          : h('span', { class: 'change-stat' },
              h('span', { class: 'change-stat-add' }, `+${c.additions}`),
              h('span', { class: 'change-stat-del' }, `−${c.deletions}`)),

        h('div', { class: 'change-actions' },
          iconBtn('paperclip', '加入 OMP 上下文', () => store.toast(`已加入 ${name}`, 'ok'), { small: true }),
          iconBtn('sparkles', '请求 OMP 修改', () => store.toast(`已请求修改 ${name}`, 'info'), { small: true }),
          iconBtn('rotateCcw', '撤销此文件', () => confirmRevert(c), { small: true }),
          iconBtn('externalLink', '在外部编辑器中打开', () => store.toast('已在 VS Code 中打开', 'ok'), { small: true }),
        ),

        (() => {
          const box = h('button', {
            class: 'change-reviewed',
            'aria-label': reviewed ? '取消已审查标记' : '标记为已审查',
            onclick: (e) => {
              e.stopPropagation();
              const cur = store.get('reviewedFiles');
              store.set({
                reviewedFiles: reviewed ? cur.filter(p => p !== c.path) : [...cur, c.path],
              });
            },
          }, reviewed ? icon('check', 'icon-sm') : null);
          attachTooltip(box, reviewed ? '已审查' : '标记为已审查');
          return box;
        })(),
      );

      attachContextMenu(row, () => [
        menuItem('查看 Diff', { iconName: 'columns', onClick: () => store.set({ activeDiffFile: c.path, mainPrimary: 'diff' }) }),
        menuItem('打开文件', { iconName: 'file', onClick: () => store.set({ activeFile: c.path }) }),
        menuItem('在外部编辑器中打开', { iconName: 'externalLink', onClick: () => store.toast('已在 VS Code 中打开', 'ok') }),
        menuSep(),
        menuItem('加入 OMP 上下文', { iconName: 'paperclip', onClick: () => store.toast(`已加入 ${name}`, 'ok') }),
        menuItem('请求 OMP 修改', { iconName: 'sparkles', onClick: () => store.toast(`已请求修改 ${name}`, 'info') }),
        menuSep(),
        menuItem(reviewed ? '取消已审查' : '标记已审查', { iconName: 'check', onClick: () => {} }),
        menuItem('复制路径', { iconName: 'copy', onClick: () => store.toast('路径已复制', 'ok') }),
        menuSep(),
        menuItem('撤销此文件', { iconName: 'rotateCcw', danger: true, onClick: () => confirmRevert(c) }),
      ]);

      return row;
    }

    function confirmRevert(c) {
      showDialog({
        title: '撤销文件修改',
        iconName: 'rotateCcw',
        desc: `${c.path} 将回到修改前的状态。`,
        body: h('div', { class: 'impact-list' },
          h('div', { class: 'impact-item impact-item-danger' },
            icon('trash', 'icon-sm'), `+${c.additions} −${c.deletions} 的改动会丢失`),
          h('div', { class: 'impact-item impact-item-warn' },
            icon('alertTriangle', 'icon-sm'), '此操作不可撤销（未提交的内容无法恢复）'),
          h('div', { class: 'impact-item impact-item-ok' },
            icon('checkCircle', 'icon-sm'), '对话历史不受影响'),
        ),
        footer: [
          h('button', { class: 'btn btn-outline', onclick: closeDialog }, '取消'),
          h('button', {
            class: 'btn btn-danger-solid',
            onclick: () => { closeDialog(); store.toast(`已撤销 ${splitPath(c.path).name}`, 'ok'); },
          }, '撤销修改'),
        ],
      });
    }

    function renderCommitBar(totals) {
      return h('div', { class: 'changes-commit' },
        h('input', {
          class: 'input',
          placeholder: `提交 ${totals.files} 个文件的改动…`,
          'aria-label': 'Commit message',
        }),
        h('button', {
          class: 'btn btn-primary',
          onclick: () => store.toast(`已创建 Commit · ${totals.files} 个文件`, 'ok'),
        }, icon('gitCommit', 'icon-sm'), 'Commit'),
      );
    }

    store.subscribe(
      ['changesScope', 'changesGroupBy', 'activeDiffFile', 'reviewedFiles', 'scenario'],
      render
    );

    render();
    return { el, render };
  }

  /* ==========================================================================
     Diff viewer
     ========================================================================== */

  function createDiff() {
    const el = h('div', { class: 'diff' });

    function render() {
      clear(el);

      const path = store.get('activeDiffFile');
      const mode = store.get('diffMode');

      /* No file selected → continuous view of all changed files */
      if (!path) {
        el.append(renderAllToolbar(mode), renderAllFiles(mode));
        return;
      }

      const change = CHANGES.find(c => c.path === path);
      const diff = DIFFS[path];

      el.append(renderToolbar(path, change, mode));

      if (!diff) {
        el.appendChild(
          h('div', { class: 'diff-special' },
            icon('file', 'icon-lg'),
            h('div', { class: 'diff-special-title' }, '没有可显示的 Diff'),
            h('div', { class: 'diff-special-desc' }, `${path} 没有记录到改动内容。`),
          )
        );
        return;
      }

      el.appendChild(renderDiffBody(path, change, diff, mode));
    }

    function renderToolbar(path, change, mode) {
      const { name } = splitPath(path);

      return h('div', { class: 'diff-toolbar' },
        iconBtn('arrowLeft', '返回文件列表', () => store.set({ activeDiffFile: null }), { small: true }),
        icon(fileIcon(name), 'icon-sm'),
        h('span', { class: 'diff-file-name', title: path }, path),
        change
          ? h('span', { class: 'change-stat' },
              h('span', { class: 'change-stat-add' }, `+${change.additions}`),
              h('span', { class: 'change-stat-del' }, `−${change.deletions}`))
          : null,
        h('div', { class: 'diff-toolbar-right' },
          h('div', { class: 'segmented' },
            h('button', {
              class: 'segmented-item',
              data: mode === 'inline' ? { active: 'true' } : {},
              onclick: () => store.set({ diffMode: 'inline' }),
            }, 'Inline'),
            h('button', {
              class: 'segmented-item',
              data: mode === 'split' ? { active: 'true' } : {},
              onclick: () => store.set({ diffMode: 'split' }),
            }, 'Split'),
          ),
          iconBtn('copy', '复制 Diff', () => store.toast('已复制', 'ok'), { small: true }),
          iconBtn('paperclip', '加入 OMP 上下文', () => store.toast('已加入上下文', 'ok'), { small: true }),
          iconBtn('sparkles', '请求 OMP 修改', () => store.toast('已请求修改', 'info'), { small: true }),
          iconBtn('externalLink', '在外部编辑器中打开', () => store.toast('已在 VS Code 中打开', 'ok'), { small: true }),
        ),
      );
    }

    function renderAllToolbar(mode) {
      return h('div', { class: 'diff-toolbar' },
        icon('columns', 'icon-sm'),
        h('span', { class: 'diff-file-name' }, '全部文件（连续查看）'),
        h('div', { class: 'diff-toolbar-right' },
          h('div', { class: 'segmented' },
            h('button', {
              class: 'segmented-item',
              data: mode === 'inline' ? { active: 'true' } : {},
              onclick: () => store.set({ diffMode: 'inline' }),
            }, 'Inline'),
            h('button', {
              class: 'segmented-item',
              data: mode === 'split' ? { active: 'true' } : {},
              onclick: () => store.set({ diffMode: 'split' }),
            }, 'Split'),
          ),
        ),
      );
    }

    function renderAllFiles(mode) {
      const body = h('div', { class: 'diff-body' });
      const list = changesByScope(store.get('changesScope'));

      list.forEach(c => {
        const diff = DIFFS[c.path];
        body.appendChild(
          h('div', { class: 'diff-hunk-header', style: { fontWeight: 'var(--fw-semi)', color: 'var(--text-primary)' } },
            icon(fileIcon(c.path), 'icon-sm'),
            c.path,
            h('span', { style: { marginLeft: 'auto' } },
              h('span', { style: { color: 'var(--add)' } }, `+${c.additions} `),
              h('span', { style: { color: 'var(--del)' } }, `−${c.deletions}`)),
          )
        );
        if (diff) {
          const sub = renderDiffBody(c.path, c, diff, mode);
          Array.from(sub.children).forEach(ch => body.appendChild(ch));
        }
      });

      return body;
    }

    function renderDiffBody(path, change, diff, mode) {
      const body = h('div', { class: `diff-body ${mode === 'split' ? 'diff-split-wrap' : 'diff-inline'}` });

      /* Special file states first */
      if (diff.binary) {
        body.appendChild(
          h('div', { class: 'diff-special' },
            icon('box', 'icon-lg'),
            h('div', { class: 'diff-special-title' }, '二进制文件'),
            h('div', { class: 'diff-special-desc' }, '无法显示文本 Diff。'),
            h('div', { class: 'diff-special-meta' },
              h('span', {}, `修改前 ${diff.sizeBefore}`),
              h('span', {}, `修改后 ${diff.sizeAfter}`),
            ),
          )
        );
        return body;
      }

      if (change?.renamedFrom) {
        body.appendChild(
          h('div', { class: 'diff-rename' },
            icon('arrowRight', 'icon-sm'),
            `${change.renamedFrom} → ${path}`)
        );
      }

      if (diff.conflict) {
        body.appendChild(
          h('div', { class: 'diff-conflict-banner' },
            icon('alertTriangle', 'icon'),
            h('div', {},
              h('strong', {}, '未解决的合并冲突。'),
              ' 文件中仍有冲突标记。解决后才能提交。'),
            h('button', {
              class: 'btn btn-sm btn-primary',
              style: { marginLeft: 'auto', flexShrink: '0' },
              onclick: () => store.toast('已请求 OMP 解决冲突', 'info'),
            }, '请求 OMP 解决'),
          )
        );
      }

      if (diff.isNew) {
        body.appendChild(
          h('div', { class: 'diff-rename', style: { background: 'var(--ok-subtle)' } },
            icon('filePlus', 'icon-sm'), '新文件')
        );
      }

      if (diff.isDeleted) {
        body.appendChild(
          h('div', { class: 'diff-rename', style: { background: 'var(--danger-subtle)' } },
            icon('trash', 'icon-sm'), '文件已删除')
        );
      }

      diff.hunks?.forEach(hunk => {
        body.appendChild(
          h('div', { class: 'diff-hunk-header' },
            h('span', {}, hunk.header),
            h('button', {
              class: 'diff-expand-btn',
              onclick: () => store.toast('已展开上下文', 'info'),
            }, icon('chevronsUpDown', 'icon-sm'), '展开上下文'),
          )
        );

        if (mode === 'split') {
          body.appendChild(renderSplitHunk(hunk));
        } else {
          hunk.lines.forEach(line => body.appendChild(renderInlineLine(line)));
        }
      });

      return body;
    }

    function renderInlineLine(line) {
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'meta' ? '!' : ' ';

      return h('div', { class: 'diff-line', data: { kind: line.kind } },
        h('span', { class: 'diff-line-num' }, line.old != null ? String(line.old) : ''),
        h('span', { class: 'diff-line-num' }, line.new != null ? String(line.new) : ''),
        h('span', { class: 'diff-line-marker' }, marker),
        h('span', { class: 'diff-line-text' }, ...highlight(line.text)),
      );
    }

    function renderSplitHunk(hunk) {
      const left = [];
      const right = [];

      hunk.lines.forEach(line => {
        if (line.kind === 'context') {
          left.push(line);
          right.push(line);
        } else if (line.kind === 'del') {
          left.push(line);
          right.push(null);
        } else if (line.kind === 'add') {
          left.push(null);
          right.push(line);
        } else {
          left.push(line);
          right.push(line);
        }
      });

      /* Pair up del/add so they sit on the same row */
      const balanced = balance(left, right);

      return h('div', { class: 'diff-split' },
        h('div', { class: 'diff-split-side' },
          h('div', { class: 'diff-split-header' }, '修改前'),
          balanced.left.map(l => l
            ? h('div', { class: 'diff-line', data: { kind: l.kind === 'add' ? 'context' : l.kind } },
                h('span', { class: 'diff-line-num' }, l.old != null ? String(l.old) : ''),
                h('span', { class: 'diff-line-marker' }, l.kind === 'del' ? '−' : ' '),
                h('span', { class: 'diff-line-text' }, ...highlight(l.text)))
            : h('div', { class: 'diff-line diff-line-empty' },
                h('span', { class: 'diff-line-num' }),
                h('span', { class: 'diff-line-marker' }),
                h('span', { class: 'diff-line-text' }, ''))),
        ),
        h('div', { class: 'diff-split-side' },
          h('div', { class: 'diff-split-header' }, '修改后'),
          balanced.right.map(l => l
            ? h('div', { class: 'diff-line', data: { kind: l.kind === 'del' ? 'context' : l.kind } },
                h('span', { class: 'diff-line-num' }, l.new != null ? String(l.new) : ''),
                h('span', { class: 'diff-line-marker' }, l.kind === 'add' ? '+' : ' '),
                h('span', { class: 'diff-line-text' }, ...highlight(l.text)))
            : h('div', { class: 'diff-line diff-line-empty' },
                h('span', { class: 'diff-line-num' }),
                h('span', { class: 'diff-line-marker' }),
                h('span', { class: 'diff-line-text' }, ''))),
        ),
      );
    }

    function balance(left, right) {
      const L = left.filter(Boolean);
      const R = right.filter(Boolean);
      const outL = [];
      const outR = [];
      let i = 0, j = 0;

      while (i < L.length || j < R.length) {
        const l = L[i];
        const r = R[j];

        if (l && r && l.kind === 'context' && r.kind === 'context' && l.text === r.text) {
          outL.push(l); outR.push(r); i++; j++;
        } else if (l && l.kind === 'del' && r && r.kind === 'add') {
          outL.push(l); outR.push(r); i++; j++;
        } else if (l && l.kind === 'del') {
          outL.push(l); outR.push(null); i++;
        } else if (r && r.kind === 'add') {
          outL.push(null); outR.push(r); j++;
        } else if (l) {
          outL.push(l); outR.push(r || null); i++; if (r) j++;
        } else {
          outL.push(null); outR.push(r); j++;
        }
      }

      return { left: outL, right: outR };
    }

    store.subscribe(['activeDiffFile', 'diffMode', 'changesScope', 'scenario'], render);
    render();
    return { el, render };
  }

  /* ==========================================================================
     Lightweight syntax highlighting
     Regex-based, deliberately shallow — a diff viewer needs the shape of the
     code to read clearly, not a full parse.
     ========================================================================== */

  const KEYWORDS = new Set([
    'import', 'export', 'from', 'const', 'let', 'var', 'function', 'return',
    'if', 'else', 'for', 'while', 'class', 'extends', 'interface', 'type',
    'async', 'await', 'new', 'this', 'super', 'try', 'catch', 'finally',
    'throw', 'switch', 'case', 'break', 'continue', 'default', 'public',
    'private', 'protected', 'readonly', 'static', 'implements', 'enum',
    'null', 'undefined', 'true', 'false', 'void', 'never', 'any', 'unknown',
    'string', 'number', 'boolean', 'pub', 'fn', 'impl', 'struct', 'mut', 'use',
  ]);

  function highlight(text) {
    if (!text) return [''];

    const out = [];
    /* comment | string | number | word | other */
    const re = /(\/\/.*$|\/\*[\s\S]*?\*\/|#.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([^\w\s]+)/g;

    let m;
    let last = 0;

    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));

      const [tok, comment, str, num, word, punct] = m;

      if (comment) {
        out.push(h('span', { class: 'tok-comment' }, tok));
      } else if (str) {
        out.push(h('span', { class: 'tok-string' }, tok));
      } else if (num) {
        out.push(h('span', { class: 'tok-number' }, tok));
      } else if (word) {
        if (KEYWORDS.has(word)) {
          out.push(h('span', { class: 'tok-keyword' }, tok));
        } else if (/^[A-Z]/.test(word)) {
          out.push(h('span', { class: 'tok-type' }, tok));
        } else if (text[m.index + tok.length] === '(') {
          out.push(h('span', { class: 'tok-function' }, tok));
        } else {
          out.push(tok);
        }
      } else if (punct) {
        out.push(h('span', { class: 'tok-punct' }, tok));
      } else {
        out.push(tok);
      }

      last = m.index + tok.length;
    }

    if (last < text.length) out.push(text.slice(last));
    return out.length ? out : [''];
  }


  OMP.mod['js/components/changes'] = { createChanges, createDiff };
})(window.OMP = window.OMP || { mod: {} });
