/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — minimap.js
     Semantic scroll navigator. Not a scrollbar — a typed event ribbon.

     Quiet at rest (14px strip). Expands on hover/pin into a labelled event
     list with filtering and jump-to-next-error / file-change / user-message.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
    const { showPopover, closePopover, iconBtn, attachTooltip } = OMP.mod['js/ui'];
    const { TIMELINE, MINIMAP_KINDS, minimapKind, buildLongTimeline } = OMP.mod['data/timeline'];
  function createMinimap(getTimelineEl) {
    const el = h('div', {
      class: 'minimap',
      role: 'navigation',
      'aria-label': 'Conversation Minimap',
    });

    const header = h('div', { class: 'minimap-header' });
    const strip = h('div', { class: 'minimap-strip' });
    const viewport = h('div', { class: 'minimap-viewport' });
    const list = h('div', { class: 'minimap-list' });

    el.append(header, strip, viewport, list);

    let currentIndex = 0;

    function events() {
      const s = store.get('scenario');
      const src = s === 'wb:minimap-long' ? buildLongTimeline()
        : s === 'wb:idle' ? []
        : TIMELINE;

      const filters = store.get('minimapFilters');

      return src
        .filter(ev => ev.type !== 'turn-header')
        .map((ev, i) => ({ ev, kind: minimapKind(ev), index: i }))
        .filter(x => !filters || filters.includes(x.kind));
    }

    function render() {
      const pinned = store.get('minimapPinned');
      el.setAttribute('data-pinned', String(pinned));

      renderHeader();
      renderStrip();
      renderList();
    }

    function renderHeader() {
      clear(header);
      header.append(
        h('span', { class: 'minimap-title' }, 'Minimap'),
        h('div', { class: 'minimap-actions' },
          iconBtn('filter', '筛选事件类型', (e) => openFilterMenu(e.currentTarget), { small: true }),
          iconBtn('alertCircle', '下一个错误', () => jumpToKind('error'), { small: true, kbd: '⌘⇧E' }),
          iconBtn('file', '下一个文件修改', () => jumpToKind('file'), { small: true, kbd: '⌘⇧M' }),
          iconBtn('user', '下一个用户消息', () => jumpToKind('user'), { small: true, kbd: '⌘↓' }),
          h('button', {
            class: 'minimap-pin',
            'aria-label': store.get('minimapPinned') ? '取消固定' : '固定展开',
            'aria-pressed': String(store.get('minimapPinned')),
            onclick: () => store.set({ minimapPinned: !store.get('minimapPinned') }),
          }, icon('pin', 'icon-sm')),
        ),
      );
    }

    function renderStrip() {
      clear(strip);
      const evs = events();

      if (!evs.length) return;

      evs.forEach(({ ev, kind }, i) => {
        const marker = h('div', {
          class: 'minimap-event',
          data: { kind },
          role: 'button',
          tabindex: '-1',
          'aria-label': summaryOf(ev, kind),
          onclick: () => jumpTo(ev, i),
        });

        attachTooltip(marker, () => h('div', {},
          h('div', { class: 'tooltip-title' }, MINIMAP_KINDS[kind].label),
          h('div', {}, summaryOf(ev, kind)),
        ), { delay: 120, placement: 'left' });

        strip.appendChild(marker);
      });
    }

    function renderList() {
      clear(list);
      const evs = events();

      evs.forEach(({ ev, kind }, i) => {
        list.appendChild(
          h('div', {
            class: 'minimap-list-item',
            data: { kind, active: String(i === currentIndex) },
            onclick: () => jumpTo(ev, i),
          },
            h('span', { class: 'minimap-list-item-marker' }),
            h('div', { class: 'minimap-list-item-info' },
              h('div', { class: 'minimap-list-item-label' }, summaryOf(ev, kind)),
              h('div', { class: 'minimap-list-item-meta' }, metaOf(ev, kind)),
            ),
          )
        );
      });
    }

    /* Human-readable one-liner per event — the minimap is only useful if
       hovering tells you what you'd be jumping to. */
    function summaryOf(ev, kind) {
      switch (ev.type) {
        case 'user': return truncate(ev.text, 48);
        case 'assistant': return truncate(ev.text, 48);
        case 'thinking': return `Thinking · ${ev.duration}`;
        case 'plan': return `Plan · ${ev.items.length} 步`;
        case 'tool': return `${ev.tool} · ${truncate(ev.target, 36)}`;
        case 'tool-group': return `${ev.tool} ×${ev.count} · ${ev.summary}`;
        case 'approval': return `审批 · ${truncate(ev.command || ev.path || '', 34)}`;
        case 'checkpoint': return ev.label;
        case 'compact': return `Compact · 节省 ${Math.round(ev.tokensSaved / 1000)}k tok`;
        case 'subagent-group': return `${ev.count} 个子 Agent`;
        default: return MINIMAP_KINDS[kind].label;
      }
    }

    function metaOf(ev, kind) {
      if (ev.time) return ev.time;
      if (ev.duration) return ev.duration;
      if (ev.status) return ev.status;
      return MINIMAP_KINDS[kind].label;
    }

    function truncate(s, n) {
      const t = String(s).replace(/\n/g, ' ').replace(/`/g, '');
      return t.length > n ? t.slice(0, n - 1) + '…' : t;
    }

    /* ---- Navigation ------------------------------------------------------ */
    function jumpTo(ev, index) {
      currentIndex = index;
      const tl = getTimelineEl();
      if (!tl) return;

      /* Map event index → scroll offset. In a real build this would use
         measured element positions; here we approximate proportionally. */
      const evs = events();
      const ratio = evs.length > 1 ? index / (evs.length - 1) : 0;
      const target = ratio * (tl.scrollHeight - tl.clientHeight);

      tl.scrollTo({ top: target, behavior: 'smooth' });
      renderList();
    }

    function jumpToKind(kind) {
      const evs = events();
      const start = currentIndex + 1;

      let found = evs.findIndex((x, i) => i >= start && x.kind === kind);
      if (found === -1) found = evs.findIndex(x => x.kind === kind);

      if (found === -1) {
        store.toast(`没有找到${MINIMAP_KINDS[kind].label}`, 'info');
        return;
      }

      jumpTo(evs[found].ev, found);
    }

    function openFilterMenu(anchor) {
      const active = store.get('minimapFilters');
      const allKinds = Object.keys(MINIMAP_KINDS);

      showPopover(anchor, [
        h('button', {
          class: 'minimap-filter-item',
          onclick: () => { store.set({ minimapFilters: null }); closePopover(); },
        },
          h('span', { class: 'minimap-filter-marker', style: { background: 'var(--text-secondary)' } }),
          h('span', { class: 'minimap-filter-label' }, '显示全部'),
          !active ? h('span', { class: 'minimap-filter-check' }, icon('check', 'icon-sm')) : null,
        ),
        h('div', { class: 'menu-sep' }),
        ...allKinds.map(k => {
          const on = !active || active.includes(k);
          return h('button', {
            class: 'minimap-filter-item',
            data: { hidden: String(!on) },
            onclick: (e) => {
              e.stopPropagation();
              const cur = active || allKinds;
              const next = cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k];
              store.set({ minimapFilters: next.length === allKinds.length ? null : next });
            },
          },
            h('span', { class: 'minimap-filter-marker', style: { background: MINIMAP_KINDS[k].color } }),
            h('span', { class: 'minimap-filter-label' }, MINIMAP_KINDS[k].label),
            on ? h('span', { class: 'minimap-filter-check' }, icon('check', 'icon-sm')) : null,
          );
        }),
      ], { placement: 'left-start', className: 'popover minimap-filter-menu' });
    }

    /* ---- Viewport indicator: follows the timeline's scroll --------------- */
    function syncViewport() {
      const tl = getTimelineEl();
      if (!tl || !tl.scrollHeight) return;

      const ratio = tl.clientHeight / tl.scrollHeight;
      const pos = tl.scrollTop / tl.scrollHeight;
      const stripH = strip.clientHeight;

      viewport.style.height = `${Math.max(12, ratio * stripH)}px`;
      viewport.style.top = `${pos * stripH}px`;
    }

    /* Attach the scroll listener once the timeline element exists */
    requestAnimationFrame(() => {
      const tl = getTimelineEl();
      tl?.addEventListener('scroll', syncViewport, { passive: true });
      syncViewport();
    });

    store.subscribe(['scenario', 'activeThreadId', 'minimapFilters', 'minimapPinned'], render);
    render();

    return { el, render, syncViewport };
  }


  OMP.mod['js/components/minimap'] = { createMinimap };
})(window.OMP = window.OMP || { mod: {} });
