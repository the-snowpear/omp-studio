/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — composer.js
     The input area. Handles the 10 input states from §9.

     The Steering / Follow-up distinction is load-bearing and must never be
     ambiguous:
       Steering  — adjusts the task that is running RIGHT NOW
       Follow-up — queued, runs after the current task finishes
     They get different buttons, different colors, and different copy.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { showPopover, closePopover, iconBtn, attachTooltip } = OMP.mod['js/ui'];
    const { modelById, fmtTokens, fmtPercent, contextTone, SESSION_TELEMETRY } = OMP.mod['data/telemetry'];
    const { SLASH_COMMANDS } = OMP.mod['data/capabilities'];
  function createComposer() {
    const el = h('div', { class: 'composer' });
    let textarea = null;
    let contextChips = [
      { kind: 'file', label: 'RpcClient.ts', path: 'components/bridge/RpcClient.ts' },
      { kind: 'diff', label: 'Diff · 7 个文件' },
    ];

    function state() {
      const run = store.get('runState');
      const omp = store.get('ompStatus');

      if (omp === 'disconnected' || omp === 'error') return 'disconnected';
      if (run === 'aborting') return 'aborting';
      if (run === 'compacting') return 'compacting';
      if (store.get('followUpQueue').length) return 'followup';
      if (run === 'running') return 'steering';
      if (run === 'awaiting-approval' || run === 'awaiting-user') return 'awaiting';
      return 'idle';
    }

    function render() {
      const draft = store.getDraft();
      const cursorPos = textarea?.selectionStart;
      const hadFocus = document.activeElement === textarea;

      clear(el);

      const s = state();
      const t = SESSION_TELEMETRY;
      const ctxRatio = t.context.used / t.context.total;
      const tone = contextTone(ctxRatio);
      const model = modelById(store.get('model'));
      const queue = store.get('followUpQueue');

      el.setAttribute('data-running', String(s === 'steering'));
      el.setAttribute('data-disabled', String(s === 'disconnected'));
      el.setAttribute('data-context-warn', String(tone === 'warn'));
      el.setAttribute('data-context-danger', String(tone === 'danger'));

      /* ---- Context pressure banner ---- */
      el.appendChild(
        h('div', { class: 'composer-warning' },
          h('span', { class: 'composer-warning-icon' }, icon('alertTriangle', 'icon')),
          h('div', { class: 'composer-warning-text' },
            tone === 'danger'
              ? `Context 已使用 ${fmtPercent(ctxRatio)}，接近上限。继续对话可能触发自动 Compact。`
              : `Context 已使用 ${fmtPercent(ctxRatio)}。达到 90% 时会自动 Compact。`),
          h('div', { class: 'composer-warning-actions' },
            h('button', {
              class: 'btn btn-sm btn-outline',
              onclick: () => { store.set({ runState: 'compacting', scenario: 'wb:compacting' }); },
            }, '立即 Compact'),
            h('button', {
              class: 'btn btn-sm btn-outline',
              onclick: () => store.set({ screen: 'history' }),
            }, '开新对话'),
          ),
        )
      );

      /* ---- Disconnected banner ---- */
      if (s === 'disconnected') {
        el.appendChild(
          h('div', { class: 'composer-warning', style: { display: 'flex', background: 'var(--danger-subtle)', borderBottomColor: 'var(--danger-border)' } },
            h('span', { class: 'composer-warning-icon', style: { color: 'var(--danger)' } }, icon('wifiOff', 'icon')),
            h('div', { class: 'composer-warning-text' },
              'OMP 已断开连接。输入已保存为草稿，重连后可继续发送。'),
            h('div', { class: 'composer-warning-actions' },
              h('button', {
                class: 'btn btn-sm btn-primary',
                onclick: () => {
                  store.set({ ompStatus: 'reconnecting' });
                  setTimeout(() => { store.set({ ompStatus: 'ready', ompError: null }); store.toast('已重新连接', 'ok'); }, 1600);
                },
              }, '重新连接'),
              h('button', {
                class: 'btn btn-sm btn-outline',
                onclick: () => store.set({ screen: 'diagnostics' }),
              }, '打开诊断'),
            ),
          )
        );
      }

      /* ---- Follow-up queue ---- */
      if (queue.length) {
        el.appendChild(
          h('div', { style: { padding: '10px 16px 0' } },
            h('div', { class: 'section-label', style: { marginBottom: '6px' } },
              `Follow-up 队列 · ${queue.length} 条（当前任务完成后依次执行）`),
            ...queue.map((q, i) =>
              h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '6px 10px', marginBottom: '4px',
                  background: 'var(--accent-subtle)', borderRadius: 'var(--r-sm)',
                  fontSize: 'var(--fs-sm)',
                },
              },
                h('span', { style: { fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--accent)' } }, `${i + 1}`),
                h('span', { style: { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, q),
                iconBtn('chevronUp', '上移', () => reorderQueue(i, -1), { small: true }),
                iconBtn('chevronDown', '下移', () => reorderQueue(i, 1), { small: true }),
                iconBtn('edit', '编辑', () => { store.setDraft(q); removeFromQueue(i); }, { small: true }),
                iconBtn('close', '移除', () => removeFromQueue(i), { small: true }),
              )
            ),
          )
        );
      }

      /* ---- Main input ---- */
      const main = h('div', { class: 'composer-main' });

      if (contextChips.length) {
        main.appendChild(
          h('div', { class: 'composer-chips' },
            contextChips.map((c, i) => renderChip(c, i)))
        );
      }

      textarea = h('textarea', {
        class: 'composer-textarea',
        rows: '2',
        placeholder: placeholderFor(s),
        disabled: s === 'disconnected' ? 'disabled' : null,
        'aria-label': '消息输入',
        oninput: (e) => {
          autoGrow(e.target);
          store.setDraft(e.target.value);
          maybeAutocomplete(e.target);
        },
        onkeydown: onKeyDown,
      });
      textarea.value = draft;

      main.appendChild(
        h('div', { class: 'composer-input-wrap' },
          textarea,
          renderSendButton(s),
        )
      );

      /* Steering / Follow-up explanation — only when it matters */
      if (s === 'steering') {
        main.appendChild(
          h('div', { class: 'composer-mode-info', style: { display: 'flex' } },
            icon('zap', 'icon-sm'),
            h('div', {},
              h('strong', {}, 'Steering'), ' 会立即打断并调整正在运行的任务。',
              '如果你想等当前任务跑完再执行，用右边的',
              h('strong', {}, ' 排队 '), '按钮加入 Follow-up。'),
          )
        );
      }

      main.appendChild(renderControls(s, model, t, ctxRatio, tone));
      el.appendChild(main);

      /* ---- Keyboard hints ---- */
      el.appendChild(
        h('div', { class: 'composer-hint' },
          h('div', { class: 'composer-hint-left' },
            hintItem('Enter', s === 'steering' ? '发送 Steering' : '发送'),
            hintItem('⇧Enter', '换行'),
            s === 'steering' ? hintItem('⌘Enter', '加入 Follow-up') : null,
            hintItem('@', '引用'),
            hintItem('/', '命令'),
          ),
          h('div', {},
            s === 'steering'
              ? h('span', { style: { color: 'var(--run)' } }, 'Esc 中止当前任务')
              : null,
          ),
        )
      );

      /* Restore caret and focus — never steal focus the user didn't give */
      if (hadFocus && textarea) {
        textarea.focus();
        if (cursorPos != null) textarea.setSelectionRange(cursorPos, cursorPos);
      }
      if (textarea) autoGrow(textarea);
    }

    function placeholderFor(s) {
      return {
        idle: '描述你想做的事… 输入 / 触发命令，@ 引用文件',
        steering: 'Steering：立即调整当前任务，或 ⌘Enter 加入 Follow-up 队列…',
        followup: '继续输入以追加 Follow-up…',
        aborting: '正在中止…',
        compacting: '正在 Compact 上下文，稍候…',
        awaiting: 'OMP 正在等待你的回应（见上方卡片）',
        disconnected: 'OMP 已断开，输入会保存为草稿',
      }[s] || '输入消息…';
    }

    function renderChip(c, i) {
      const iconMap = {
        file: 'file', dir: 'folder', diff: 'columns', agent: 'toolSubagent',
        preview: 'toolPreview', 'preview-element': 'crosshair', terminal: 'terminal',
        error: 'alertCircle', screenshot: 'image', checkpoint: 'bookmark', project: 'layers',
      };

      return h('span', {
        class: `chip${c.invalid ? ' chip-invalid' : ''}${c.loading ? ' chip-loading' : ''}`,
        title: c.path || c.label,
      },
        icon(iconMap[c.kind] || 'file', 'icon-sm'),
        h('span', { class: 'chip-label' }, c.label),
        h('button', {
          class: 'chip-remove',
          'aria-label': `移除 ${c.label}`,
          onclick: () => { contextChips.splice(i, 1); render(); },
        }, icon('close', 'icon-sm')),
      );
    }

    function renderSendButton(s) {
      if (s === 'steering') {
        const btn = h('button', {
          class: 'composer-send',
          'aria-label': 'Abort 当前任务',
          onclick: abort,
        }, icon('stop', 'icon'));
        attachTooltip(btn, 'Abort — 立即停止当前任务（Esc）');
        return btn;
      }

      if (s === 'aborting') {
        return h('button', { class: 'composer-send', disabled: 'disabled', 'aria-label': '正在中止' },
          icon('clock', 'icon'));
      }

      const btn = h('button', {
        class: 'composer-send',
        'aria-label': '发送',
        disabled: s === 'disconnected' ? 'disabled' : null,
        onclick: send,
      }, icon('send', 'icon'));
      attachTooltip(btn, '发送（Enter）');
      return btn;
    }

    function renderControls(s, model, t, ctxRatio, tone) {
      return h('div', { class: 'composer-controls' },
        h('div', { class: 'composer-controls-left' },
          (() => {
            const b = iconBtn('paperclip', '添加引用', (e) => openAttachMenu(e.currentTarget), { small: true, kbd: '@' });
            return b;
          })(),
          iconBtn('image', '粘贴或拖入图片', () => store.toast('可直接粘贴或拖入图片', 'info'), { small: true }),
          iconBtn('command', 'Slash Commands', (e) => openSlashMenu(e.currentTarget), { small: true, kbd: '/' }),
          iconBtn('history', '输入历史', () => store.toast('输入历史', 'info'), { small: true }),
        ),

        h('div', { class: 'composer-controls-right' },
          /* Steering / Follow-up controls — only while a task is running */
          s === 'steering'
            ? h('button', {
                class: 'composer-control-btn',
                onclick: queueFollowUp,
                title: '当前任务完成后再执行（⌘Enter）',
              }, icon('cornerDownLeft', 'icon-sm'), '排队为 Follow-up')
            : null,

          /* Model + params — these belong to the SESSION, so they live here
             and in the topbar, never in the bottom-left OMP env menu. */
          h('button', {
            class: 'composer-model',
            onclick: (e) => openModelQuickMenu(e.currentTarget),
          },
            icon('sparkles', 'icon-sm'),
            model.short,
          ),
          h('button', {
            class: 'composer-control-btn',
            onclick: (e) => openModelQuickMenu(e.currentTarget),
          }, icon('brain', 'icon-sm'), store.get('thinkingLevel')),
          h('button', {
            class: 'composer-control-btn',
            onclick: (e) => openModelQuickMenu(e.currentTarget),
          }, icon(store.get('permissionMode') === 'full' ? 'unlock' : 'shield', 'icon-sm'),
            { review: 'Review', workspace: 'Workspace', full: 'Full Access' }[store.get('permissionMode')]),

          h('span', {
            class: 'composer-tokens',
            style: tone !== 'muted' ? { color: `var(--${tone})` } : {},
          },
            icon('gauge', 'icon-sm'),
            `${fmtPercent(ctxRatio)} · ${fmtTokens(t.context.used)}`,
          ),
        ),
      );
    }

    function hintItem(key, label) {
      return h('span', { class: 'composer-hint-item' },
        h('kbd', {}, key), label);
    }

    /* ---- Behaviour ------------------------------------------------------- */
    function autoGrow(ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
    }

    function onKeyDown(e) {
      /* ⌘Enter → queue as follow-up while running */
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        queueFollowUp();
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
        return;
      }

      if (e.key === 'Escape' && store.get('runState') === 'running') {
        e.preventDefault();
        abort();
      }
    }

    function send() {
      const text = store.getDraft().trim();
      if (!text) return;

      const s = state();
      if (s === 'steering') {
        store.toast('Steering 已发送 — OMP 会立即调整当前任务', 'ok');
        store.setDraft('');
        render();
        return;
      }

      store.setDraft('');
      store.set({ runState: 'running', scenario: 'wb:streaming' });
      store.toast('已发送', 'ok');
      render();
    }

    function queueFollowUp() {
      const text = store.getDraft().trim();
      if (!text) { store.toast('输入内容后才能加入队列', 'warn'); return; }

      store.set({ followUpQueue: [...store.get('followUpQueue'), text] });
      store.setDraft('');
      store.toast('已加入 Follow-up 队列，当前任务完成后执行', 'ok');
      render();
    }

    function removeFromQueue(i) {
      const q = [...store.get('followUpQueue')];
      q.splice(i, 1);
      store.set({ followUpQueue: q });
    }

    function reorderQueue(i, dir) {
      const q = [...store.get('followUpQueue')];
      const j = i + dir;
      if (j < 0 || j >= q.length) return;
      [q[i], q[j]] = [q[j], q[i]];
      store.set({ followUpQueue: q });
    }

    function abort() {
      store.set({ runState: 'aborting' });
      render();
      setTimeout(() => {
        store.set({ runState: 'idle' });
        store.toast('已中止当前任务', 'warn');
      }, 700);
    }

    /* ---- @ reference menu ------------------------------------------------ */
    function openAttachMenu(anchor) {
      const kinds = [
        ['file', 'file', '文件', '引用一个文件的完整内容'],
        ['folder', 'dir', '目录', '引用目录结构与关键文件'],
        ['layers', 'project', '项目', '引用整个项目的概览'],
        ['toolSubagent', 'agent', 'Agent', '引用某个 Agent 的输出'],
        ['columns', 'diff', 'Diff', '引用当前的文件改动'],
        ['terminal', 'terminal', 'Terminal 输出', '引用终端最近的输出'],
        ['alertCircle', 'error', '错误', '引用 Problems 中的错误'],
        ['toolPreview', 'preview', 'Preview 页面', '引用当前预览页面'],
        ['crosshair', 'preview-element', 'Preview 元素', '在 Preview 中选择一个元素'],
        ['image', 'screenshot', '截图', '引用一张 Preview 截图'],
        ['bookmark', 'checkpoint', 'Checkpoint', '引用某个 Checkpoint 的状态'],
      ];

      showPopover(anchor, kinds.map(([ic, kind, label, hint]) =>
        h('button', {
          class: 'attachment-menu-item',
          onclick: () => {
            closePopover();
            if (kind === 'preview-element') {
              store.set({ previewPicking: true, mainPrimary: 'preview', scenario: 'wb:preview-pick' });
              store.toast('在 Preview 中点击一个元素', 'info');
              return;
            }
            contextChips.push({ kind, label: sampleLabel(kind) });
            render();
          },
        },
          icon(ic, 'icon'),
          h('div', { class: 'attachment-menu-item-info' },
            h('span', { class: 'attachment-menu-item-label' }, label),
            h('span', { class: 'attachment-menu-item-hint' }, hint),
          ),
        )
      ), { placement: 'top-start', className: 'popover attachment-menu' });
    }

    function sampleLabel(kind) {
      return {
        file: 'lib/protocol.ts',
        dir: 'components/bridge/',
        project: 'omp-web',
        agent: 'test-runner',
        diff: 'Diff · 7 个文件',
        terminal: 'bun test 输出',
        error: 'TS2339 · RpcClient.ts:84',
        preview: 'localhost:5173/',
        screenshot: '截图 14:29',
        checkpoint: 'Checkpoint · Turn 2',
      }[kind] || kind;
    }

    /* ---- / slash command menu -------------------------------------------- */
    function openSlashMenu(anchor) {
      showPopover(anchor, SLASH_COMMANDS.map(c =>
        h('button', {
          class: 'composer-autocomplete-item',
          style: { opacity: c.available ? '1' : '0.5' },
          onclick: () => {
            closePopover();
            if (!c.available) { store.toast(`${c.name} 不可用：${c.reason}`, 'warn'); return; }
            store.setDraft(store.getDraft() + c.name + ' ');
            render();
            textarea?.focus();
          },
        },
          h('span', { class: 'composer-autocomplete-icon' }, icon('command', 'icon-sm')),
          h('div', { class: 'composer-autocomplete-info' },
            h('div', { class: 'composer-autocomplete-name' }, c.name + (c.args ? ` ${c.args}` : '')),
            h('div', { class: 'composer-autocomplete-desc' },
              c.available ? c.description : `${c.description} — 不可用：${c.reason}`),
          ),
          h('span', { class: 'composer-autocomplete-source' }, c.source),
        )
      ), { placement: 'top-start', className: 'popover', offset: 8 });
    }

    function maybeAutocomplete(ta) {
      const v = ta.value;
      if (v.endsWith('/') && (v.length === 1 || v[v.length - 2] === ' ' || v[v.length - 2] === '\n')) {
        openSlashMenu(ta);
      } else if (v.endsWith('@')) {
        openAttachMenu(ta);
      }
    }

    function openModelQuickMenu(anchor) {
      /* Reuse the topbar's model menu by dispatching a custom event so both
         entry points always show the identical control set. */
      document.dispatchEvent(new CustomEvent('omp:open-model-menu', { detail: { anchor } }));
    }

    store.subscribe(
      ['runState', 'ompStatus', 'activeThreadId', 'followUpQueue', 'model',
       'thinkingLevel', 'permissionMode', 'scenario', 'drafts'],
      render
    );

    render();
    return { el, render, focus: () => textarea?.focus() };
  }


  OMP.mod['js/components/composer'] = { createComposer };
})(window.OMP = window.OMP || { mod: {} });
