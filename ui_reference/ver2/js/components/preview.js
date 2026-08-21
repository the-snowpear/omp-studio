/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — preview.js
     Live app preview: toolbar, viewport, element picker, console/network,
     and the 12 lifecycle states.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { iconBtn, attachTooltip } = OMP.mod['js/ui'];
    const { PREVIEW_STATES, PREVIEW_CONSOLE, PREVIEW_NETWORK, PREVIEW_VIEWPORTS, PICKED_ELEMENT } = OMP.mod['data/preview'];
  function createPreview() {
    const el = h('div', { class: 'preview' });
    let panelTab = 'console';
    let pickedElement = null;

    function render() {
      clear(el);

      const scenario = store.get('scenario');
      let state = store.get('previewState');

      /* Scenario overrides */
      if (scenario === 'wb:preview-error') state = 'compile-error';
      if (scenario === 'wb:preview-hmr') state = 'hmr';
      if (scenario === 'wb:preview-ok' || scenario === 'wb:preview-pick') state = 'running';

      el.append(renderToolbar(state));

      const showsPage = state === 'running' || state === 'hmr';

      if (showsPage) {
        el.append(renderFrame(state));
      } else {
        el.append(renderState(state));
      }

      if (pickedElement) {
        el.append(renderPickedElement());
      }

      el.append(renderPanel());
    }

    /* ---- Toolbar --------------------------------------------------------- */
    function renderToolbar(state) {
      const picking = store.get('previewPicking');
      const info = PREVIEW_STATES[state];
      const viewport = store.get('previewViewport');

      return h('div', { class: 'preview-toolbar' },
        h('div', { class: 'preview-nav' },
          iconBtn('arrowLeft', '后退', () => store.toast('后退', 'info'), { small: true }),
          iconBtn('arrowRight', '前进', () => store.toast('前进', 'info'), { small: true }),
          iconBtn('refresh', '刷新', () => {
            store.set({ previewState: 'building' });
            setTimeout(() => store.set({ previewState: 'running' }), 900);
          }, { small: true }),
        ),

        h('div', { class: 'preview-url' },
          (() => {
            const d = h('span', {
              class: 'preview-url-status',
              style: { background: `var(--${info.tone === 'ok' ? 'ok' : info.tone === 'danger' ? 'danger' : info.tone === 'warn' ? 'warn' : 'run'})` },
            });
            attachTooltip(d, info.label);
            return d;
          })(),
          h('input', {
            value: store.get('previewUrl'),
            'aria-label': 'Preview 地址',
            spellcheck: 'false',
          }),
          h('span', { class: 'preview-url-meta' }, info.label),
        ),

        h('div', { class: 'preview-toolbar-right' },
          h('div', { class: 'preview-viewports', role: 'group', 'aria-label': '视口尺寸' },
            PREVIEW_VIEWPORTS.map(v => {
              const btn = h('button', {
                class: 'preview-viewport-btn',
                'aria-label': v.label,
                'aria-pressed': String(viewport === v.id),
                data: viewport === v.id ? { active: 'true' } : {},
                onclick: () => store.set({ previewViewport: v.id }),
              }, icon(v.icon, 'icon-sm'));
              attachTooltip(btn, `${v.label} · ${v.width}×${v.height}`);
              return btn;
            }),
          ),

          iconBtn('crosshair', '选择页面元素', () => {
            const next = !picking;
            store.set({ previewPicking: next });
            if (next) store.toast('在页面中点击一个元素', 'info');
          }, { small: true, active: picking, className: 'preview-pick-btn' }),

          iconBtn('camera', '截图', () => store.toast('已截图并加入上下文', 'ok'), { small: true }),
          iconBtn('play', '重启开发服务器', () => {
            store.set({ previewState: 'starting' });
            setTimeout(() => store.set({ previewState: 'running' }), 1400);
          }, { small: true }),
          iconBtn('externalLink', '在系统浏览器中打开', () => store.toast('已在浏览器中打开', 'ok'), { small: true }),
          (() => {
            const b = iconBtn('refresh', '自动刷新', () => store.toast('自动刷新已开启', 'ok'), { small: true, active: true });
            return b;
          })(),
        ),
      );
    }

    /* ---- Page frame ------------------------------------------------------ */
    function renderFrame(state) {
      const viewport = store.get('previewViewport');
      const picking = store.get('previewPicking');

      const frame = h('div', { class: 'preview-frame' },
        h('div', { class: 'preview-viewport', data: { size: viewport } },
          renderMockPage(),
          picking ? renderPicker() : null,
          state === 'hmr' ? h('div', { class: 'preview-hmr-flash' }) : null,
        ),
        state === 'hmr'
          ? h('div', { class: 'preview-hmr-toast' },
              icon('zap', 'icon-sm'),
              'HMR · CapabilityProbe.tsx')
          : null,
        picking
          ? h('div', { class: 'preview-picker-hint' },
              icon('crosshair', 'icon-sm'),
              '点击一个元素以引用它 · Esc 退出选择模式')
          : null,
      );

      return frame;
    }

    /* A stylized fake app so the frame shows something believable */
    function renderMockPage() {
      const page = h('div', { class: 'preview-page' },
        h('div', { class: 'mock-app' },
          h('div', { class: 'mock-app-header' },
            h('div', { class: 'mock-app-logo' }),
            h('div', { class: 'mock-app-title' }, 'omp-web'),
            h('div', { class: 'mock-app-nav' },
              h('span', {}, 'Threads'),
              h('span', {}, 'Settings'),
              h('span', {}, 'Docs'),
            ),
          ),
          h('div', { class: 'mock-app-body' },
            h('div', { class: 'mock-app-h1' }, '结账'),
            h('div', { class: 'mock-app-p' },
              '确认订单信息后提交。支付将在下一步完成。'),
            h('div', { class: 'mock-app-card' },
              h('div', { class: 'mock-app-card-title' }, '配送地址'),
              h('div', { class: 'mock-app-card-desc' }, '北京市海淀区中关村大街 1 号'),
            ),
            h('div', { class: 'mock-app-card' },
              h('div', { class: 'mock-app-card-title' }, '订单摘要'),
              h('div', { class: 'mock-app-card-desc' }, '2 件商品 · 合计 ¥248.00'),
            ),
            h('div', { class: 'mock-app-actions' },
              h('button', {
                class: 'mock-app-btn mock-app-btn-primary',
                'data-pickable': 'true',
                'data-selector': 'button.btn-primary[type="submit"]',
              }, '提交订单'),
              h('button', {
                class: 'mock-app-btn mock-app-btn-ghost',
                'data-pickable': 'true',
                'data-selector': 'button.btn-ghost',
              }, '返回购物车'),
            ),
          ),
        ),
      );

      return page;
    }

    /* ---- Element picker overlay ------------------------------------------ */
    function renderPicker() {
      const overlay = h('div', { class: 'preview-picker-overlay' });
      const highlight = h('div', { class: 'preview-picker-highlight' });
      overlay.appendChild(highlight);

      overlay.addEventListener('pointermove', (e) => {
        overlay.style.pointerEvents = 'none';
        const target = document.elementFromPoint(e.clientX, e.clientY);
        overlay.style.pointerEvents = '';

        const pickable = target?.closest('[data-pickable]');
        if (!pickable) { highlight.style.display = 'none'; return; }

        const r = pickable.getBoundingClientRect();
        const o = overlay.getBoundingClientRect();

        highlight.style.display = 'block';
        highlight.style.left = `${r.left - o.left}px`;
        highlight.style.top = `${r.top - o.top}px`;
        highlight.style.width = `${r.width}px`;
        highlight.style.height = `${r.height}px`;

        clear(highlight);
        highlight.append(
          h('div', { class: 'preview-picker-label' },
            pickable.tagName.toLowerCase(),
            `.${pickable.className.split(' ').filter(c => c.startsWith('mock-app-btn-'))[0] || 'btn'}`),
          h('div', { class: 'preview-picker-dims' },
            `${Math.round(r.width)} × ${Math.round(r.height)}`),
        );
      });

      overlay.addEventListener('click', (e) => {
        overlay.style.pointerEvents = 'none';
        const target = document.elementFromPoint(e.clientX, e.clientY);
        overlay.style.pointerEvents = '';

        const pickable = target?.closest('[data-pickable]');
        if (!pickable) return;

        const r = pickable.getBoundingClientRect();
        pickedElement = {
          ...PICKED_ELEMENT,
          text: pickable.textContent.trim(),
          selector: pickable.dataset.selector,
          rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        };

        store.set({ previewPicking: false });
        store.toast(`已选择「${pickedElement.text}」`, 'ok');
        render();
      });

      return overlay;
    }

    function renderPickedElement() {
      const p = pickedElement;

      return h('div', { class: 'picked-element' },
        h('div', { class: 'picked-element-head' },
          h('span', { class: 'picked-element-icon' }, icon('crosshair', 'icon')),
          h('span', { class: 'picked-element-title' }, `@Preview ${p.kind} "${p.text}"`),
          iconBtn('close', '取消选择', () => { pickedElement = null; render(); }, { small: true }),
        ),
        h('div', { class: 'picked-element-body' },
          row('页面', p.url),
          row('Selector', p.selector),
          row('DOM 路径', p.domPath),
          row('位置尺寸', `x ${p.rect.x} · y ${p.rect.y} · ${p.rect.width}×${p.rect.height}`),
          row('样式', `${p.styles.fontSize} / ${p.styles.fontWeight} · ${p.styles.backgroundColor} · r${p.styles.borderRadius}`),
          row('可访问性', `role=${p.a11y.role} · label="${p.a11y.label}" · 键盘可达 ${p.a11y.keyboardAccessible ? '是' : '否'}`),
        ),
        h('div', { class: 'picked-element-actions' },
          h('button', {
            class: 'btn btn-sm btn-primary',
            onclick: () => {
              store.toast(`已把 @Preview ${p.kind} "${p.text}" 放入输入区`, 'ok');
              pickedElement = null;
              render();
            },
          }, icon('paperclip', 'icon-sm'), '放入输入区'),
          h('button', {
            class: 'btn btn-sm btn-outline',
            onclick: () => store.toast('已请求 OMP 修改此元素', 'info'),
          }, icon('sparkles', 'icon-sm'), '请求 OMP 修改'),
          h('button', {
            class: 'btn btn-sm btn-outline',
            onclick: () => store.toast('已复制 Selector', 'ok'),
          }, icon('copy', 'icon-sm'), '复制 Selector'),
        ),
      );
    }

    function row(k, v) {
      return h('div', { class: 'picked-element-row' },
        h('span', { class: 'picked-element-key' }, k),
        h('span', { class: 'picked-element-value' }, v),
      );
    }

    /* ---- Non-page states (10 of the 12) ---------------------------------- */
    function renderState(state) {
      const info = PREVIEW_STATES[state];

      return h('div', { class: 'preview-state', data: { tone: info.tone } },
        h('span', { class: 'preview-state-icon' }, icon(info.icon, 'icon-lg')),
        h('div', { class: 'preview-state-title' }, info.label),
        info.message ? h('div', { class: 'preview-state-message' }, info.message) : null,

        info.progress != null
          ? h('div', { class: 'progress preview-state-progress' },
              h('div', { class: 'progress-fill', style: { width: `${info.progress * 100}%` } }))
          : null,

        info.error ? renderPreviewError(info.error) : null,

        info.actions?.length
          ? h('div', { class: 'preview-state-actions' },
              info.actions.map((a, i) =>
                h('button', {
                  class: i === 0 ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline',
                  onclick: () => handleAction(a, info.error),
                }, a)))
          : null,
      );
    }

    function renderPreviewError(err) {
      return h('div', { class: 'error-region' },
        h('div', { class: 'error-head' },
          icon('alertCircle', 'icon'),
          h('div', {},
            h('div', { class: 'error-title' }, err.summary),
            err.file
              ? h('div', { class: 'error-meta' },
                  h('span', {
                    class: 'path-link',
                    onclick: () => store.set({ activeFile: err.file }),
                  }, `${err.file}:${err.line}${err.column ? ':' + err.column : ''}`),
                )
              : null,
          ),
        ),
        h('div', { class: 'error-detail' }, err.detail),
      );
    }

    function handleAction(action, err) {
      switch (action) {
        case '打开文件':
          store.set({ activeFile: err?.file });
          store.toast(`已打开 ${err?.file}:${err?.line}`, 'ok');
          break;
        case '复制错误':
          store.toast('错误已复制到剪贴板', 'ok');
          break;
        case '加入上下文':
        case '加入 OMP 上下文':
          store.toast('已加入 OMP 上下文', 'ok');
          break;
        case '请求 OMP 修复':
          store.toast('已请求 OMP 修复该错误', 'info');
          break;
        case '查看完整日志':
          store.set({ bottomPanelOpen: true, bottomPanelTab: 'preview-logs' });
          break;
        case '重启 Preview':
        case '重启':
        case '重启开发服务器':
          store.set({ previewState: 'starting' });
          setTimeout(() => store.set({ previewState: 'running' }), 1400);
          break;
        case '更换端口':
          store.set({ previewState: 'starting', previewUrl: 'http://localhost:5174/' });
          setTimeout(() => store.set({ previewState: 'running' }), 1200);
          store.toast('已切换到端口 5174', 'ok');
          break;
        case '终止占用进程':
          store.toast('已终止 PID 8214', 'ok');
          store.set({ previewState: 'starting' });
          setTimeout(() => store.set({ previewState: 'running' }), 1200);
          break;
        case '配置启动命令':
          store.set({ screen: 'settings' });
          break;
        case '自动检测':
          store.set({ previewState: 'detecting' });
          setTimeout(() => store.set({ previewState: 'installing' }), 900);
          setTimeout(() => store.set({ previewState: 'starting' }), 2000);
          setTimeout(() => store.set({ previewState: 'running' }), 3200);
          break;
        default:
          store.toast(action, 'info');
      }
    }

    /* ---- Bottom panel: Console / Network / Errors / Server logs ---------- */
    function renderPanel() {
      const tabs = [
        ['console', 'Console', PREVIEW_CONSOLE.length],
        ['network', 'Network', PREVIEW_NETWORK.length],
        ['errors', '页面错误', PREVIEW_CONSOLE.filter(c => c.kind === 'error').length],
        ['server', '开发服务器日志', null],
      ];

      return h('div', { class: 'preview-panel' },
        h('div', { class: 'tabs' },
          tabs.map(([id, label, count]) =>
            h('button', {
              class: 'tab',
              role: 'tab',
              'aria-selected': String(panelTab === id),
              data: panelTab === id ? { active: 'true' } : {},
              onclick: () => { panelTab = id; render(); },
            },
              label,
              count != null ? h('span', { class: 'tab-count' }, String(count)) : null,
            )),
          h('div', { class: 'tabs-actions' },
            iconBtn('trash', '清空', () => store.toast('已清空', 'ok'), { small: true }),
          ),
        ),
        h('div', { class: 'preview-panel-body' }, renderPanelBody()),
      );
    }

    function renderPanelBody() {
      if (panelTab === 'network') {
        return h('div', {}, PREVIEW_NETWORK.map(n =>
          h('div', { class: 'network-row' },
            h('span', { class: 'network-method' }, n.method),
            h('span', { class: 'network-url' }, n.url),
            h('span', { class: 'network-status', data: { ok: String(n.status < 400) } }, String(n.status)),
            h('span', { class: 'network-size' }, n.size),
            h('span', { class: 'network-time' }, n.time),
            n.cached ? h('span', { class: 'network-cached' }, 'cached') : null,
          )));
      }

      if (panelTab === 'server') {
        return h('div', {},
          ['$ bun run dev', '  ▲ Next.js 15.1.3', '  - Local: http://localhost:5173',
           ' ✓ Ready in 1.8s', ' ○ Compiling / ...', ' ✓ Compiled / in 2.1s (1284 modules)',
           ' ✓ Compiled in 184ms (1285 modules)'].map(l =>
            h('div', { class: 'console-row' },
              h('span', { class: 'console-text' }, l))));
      }

      const rows = panelTab === 'errors'
        ? PREVIEW_CONSOLE.filter(c => c.kind === 'error')
        : PREVIEW_CONSOLE;

      if (!rows.length) {
        return h('div', { class: 'empty-state' },
          icon('checkCircle', 'icon-lg'),
          h('div', { class: 'empty-state-title' }, '没有错误'),
          h('div', { class: 'empty-state-desc' }, '页面运行期间未产生错误。'),
        );
      }

      return h('div', {}, rows.map(c =>
        h('div', { class: 'console-row', data: { kind: c.kind } },
          h('span', { class: 'console-time' }, c.time),
          h('span', { class: 'console-text' }, c.text),
          h('span', {
            class: 'console-source',
            onclick: () => store.toast(`已定位到 ${c.source}`, 'ok'),
          }, c.source),
        )));
    }

    /* Esc exits picking mode */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && store.get('previewPicking')) {
        store.set({ previewPicking: false });
      }
    });

    store.subscribe(
      ['previewState', 'previewUrl', 'previewViewport', 'previewPicking', 'scenario'],
      render
    );

    render();
    return { el, render };
  }


  OMP.mod['js/components/preview'] = { createPreview };
})(window.OMP = window.OMP || { mod: {} });
