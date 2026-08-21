/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — ui.js
     Shared interaction helpers: popovers, context menus, tooltips, resizers,
     dialogs, toasts.
     ========================================================================== */

    const { h, clear } = OMP.mod['js/dom'];
    const { icon } = OMP.mod['js/icons'];
    const { store } = OMP.mod['js/store'];
  /* ==========================================================================
     Popover / menu positioning
     Anchors to an element, flips when it would overflow the viewport.
     ========================================================================== */

  let openPopover = null;

  function showPopover(anchor, content, opts = {}) {
    closePopover();

    const {
      placement = 'bottom-start',
      offset = 6,
      className = 'popover',
      onClose = null,
    } = opts;

    const el = h('div', { class: className, role: 'menu' }, content);
    document.body.appendChild(el);

    const a = anchor.getBoundingClientRect();
    const p = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top, left;

    switch (placement) {
      case 'bottom-start':
        top = a.bottom + offset;
        left = a.left;
        break;
      case 'bottom-end':
        top = a.bottom + offset;
        left = a.right - p.width;
        break;
      case 'top-start':
        top = a.top - p.height - offset;
        left = a.left;
        break;
      case 'top-end':
        top = a.top - p.height - offset;
        left = a.right - p.width;
        break;
      case 'right-start':
        top = a.top;
        left = a.right + offset;
        break;
      case 'left-start':
        top = a.top;
        left = a.left - p.width - offset;
        break;
      default:
        top = a.bottom + offset;
        left = a.left;
    }

    /* Flip / clamp to stay on screen */
    if (left + p.width > vw - 8) left = vw - p.width - 8;
    if (left < 8) left = 8;
    if (top + p.height > vh - 8) top = a.top - p.height - offset;
    if (top < 8) top = 8;

    el.style.top = `${top}px`;
    el.style.left = `${left}px`;

    openPopover = { el, anchor, onClose };

    /* Close on outside click / Escape */
    requestAnimationFrame(() => {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('keydown', onDocKeyDown, true);
    });

    return el;
  }

  function onDocPointerDown(e) {
    if (!openPopover) return;
    if (openPopover.el.contains(e.target)) return;
    if (openPopover.anchor?.contains(e.target)) return;
    closePopover();
  }

  function onDocKeyDown(e) {
    if (e.key === 'Escape' && openPopover) {
      e.stopPropagation();
      closePopover();
    }
  }

  function closePopover() {
    if (!openPopover) return;
    const { el, onClose } = openPopover;
    el.remove();
    openPopover = null;
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    onClose?.();
  }

  function isPopoverOpen() {
    return openPopover !== null;
  }

  /* ==========================================================================
     Menu item builders
     ========================================================================== */

  function menuItem(label, opts = {}) {
    const {
      iconName = null,
      hint = null,
      badge = null,
      danger = false,
      disabled = false,
      active = false,
      onClick = null,
      keepOpen = false,
    } = opts;

    return h('button', {
      class: `menu-item${danger ? ' menu-item-danger' : ''}`,
      role: 'menuitem',
      disabled: disabled || null,
      data: active ? { active: 'true' } : {},
      onclick: (e) => {
        e.stopPropagation();
        if (disabled) return;
        if (!keepOpen) closePopover();
        onClick?.(e);
      },
    },
      iconName ? icon(iconName, 'icon') : h('span', { style: { width: '16px', flexShrink: '0' } }),
      h('span', { class: 'menu-item-label' }, label),
      badge ? h('span', { class: 'menu-item-badge' }, badge) : null,
      hint ? h('span', { class: 'menu-item-hint' }, hint) : null,
    );
  }

  function menuSep() {
    return h('div', { class: 'menu-sep', role: 'separator' });
  }

  function menuGroupLabel(text) {
    return h('div', { class: 'menu-group-label' }, text);
  }

  /* ==========================================================================
     Context menu — right-click
     ========================================================================== */

  function attachContextMenu(el, buildItems) {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const items = buildItems(e);
      if (!items || !items.length) return;

      /* Anchor to the pointer position with a zero-size virtual element */
      const virtual = {
        getBoundingClientRect: () => ({
          top: e.clientY, bottom: e.clientY,
          left: e.clientX, right: e.clientX,
          width: 0, height: 0,
        }),
        contains: () => false,
      };

      showPopover(virtual, items, { placement: 'bottom-start', offset: 2 });
    });
  }

  /* ==========================================================================
     Tooltip
     ========================================================================== */

  let tooltipEl = null;
  let tooltipTimer = null;

  function attachTooltip(el, content, opts = {}) {
    const { delay = 400, placement = 'top' } = opts;

    el.addEventListener('pointerenter', () => {
      tooltipTimer = setTimeout(() => {
        showTooltip(el, typeof content === 'function' ? content() : content, placement);
      }, delay);
    });

    el.addEventListener('pointerleave', () => {
      clearTimeout(tooltipTimer);
      hideTooltip();
    });

    el.addEventListener('pointerdown', () => {
      clearTimeout(tooltipTimer);
      hideTooltip();
    });
  }

  function showTooltip(anchor, content, placement) {
    hideTooltip();

    tooltipEl = h('div', { class: 'tooltip', role: 'tooltip' },
      typeof content === 'string' ? content : content);
    document.body.appendChild(tooltipEl);

    const a = anchor.getBoundingClientRect();
    const t = tooltipEl.getBoundingClientRect();
    const vw = window.innerWidth;

    let top = placement === 'top' ? a.top - t.height - 6 : a.bottom + 6;
    let left = a.left + a.width / 2 - t.width / 2;

    if (left + t.width > vw - 8) left = vw - t.width - 8;
    if (left < 8) left = 8;
    if (top < 8) top = a.bottom + 6;

    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.left = `${left}px`;
  }

  function hideTooltip() {
    tooltipEl?.remove();
    tooltipEl = null;
  }

  /* ==========================================================================
     Resizer
     Drag is 1:1 with the pointer and never animated. Programmatic layout
     changes (collapse / preset switch) animate via the data-animating flag.
     ========================================================================== */

  function makeResizer(el, opts) {
    const {
      axis = 'x',           // 'x' → width, 'y' → height
      onStart = null,
      onMove,
      onEnd = null,
      invert = false,
    } = opts;

    let startPos = 0;
    let dragging = false;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();

      dragging = true;
      startPos = axis === 'x' ? e.clientX : e.clientY;

      el.setAttribute('data-dragging', 'true');
      document.body.setAttribute('data-resizing', 'true');
      document.body.style.setProperty('--resize-cursor', axis === 'x' ? 'col-resize' : 'row-resize');

      el.setPointerCapture(e.pointerId);
      onStart?.();
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const pos = axis === 'x' ? e.clientX : e.clientY;
      const delta = (pos - startPos) * (invert ? -1 : 1);
      onMove(delta, pos);
    });

    const finish = (e) => {
      if (!dragging) return;
      dragging = false;
      el.removeAttribute('data-dragging');
      document.body.removeAttribute('data-resizing');
      try { el.releasePointerCapture(e.pointerId); } catch {}
      onEnd?.();
    };

    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);

    return { destroy: () => el.replaceWith(el.cloneNode(true)) };
  }

  /* Run a layout change with the animation flag set, so clicking a control
     animates while dragging stays instant. */
  function animateLayout(fn) {
    const app = document.querySelector('.app');
    app?.setAttribute('data-animating', 'true');
    fn();
    setTimeout(() => app?.removeAttribute('data-animating'), 220);
  }

  /* ==========================================================================
     Dialog
     ========================================================================== */

  let openDialogEl = null;

  function showDialog({ title, iconName, desc, body, footer, wide = false }) {
    closeDialog();

    const dialog = h('div', {
      class: `dialog${wide ? ' dialog-lg' : ''}`,
      role: 'dialog',
      'aria-modal': 'true',
    },
      h('div', { class: 'dialog-header' },
        h('div', { class: 'dialog-title' },
          iconName ? icon(iconName, 'icon-lg') : null,
          title,
        ),
        desc ? h('div', { class: 'dialog-desc' }, desc) : null,
      ),
      body ? h('div', { class: 'dialog-body' }, body) : null,
      footer ? h('div', { class: 'dialog-footer' }, footer) : null,
    );

    const backdrop = h('div', {
      class: 'dialog-backdrop',
      onclick: (e) => { if (e.target === backdrop) closeDialog(); },
    }, dialog);

    document.body.appendChild(backdrop);
    openDialogEl = backdrop;

    /* Focus trap — first focusable element in the dialog */
    requestAnimationFrame(() => {
      const focusable = dialog.querySelector('button, input, select, textarea, [tabindex]');
      focusable?.focus();
    });

    document.addEventListener('keydown', onDialogKeyDown, true);

    return { close: closeDialog, el: dialog };
  }

  function onDialogKeyDown(e) {
    if (e.key === 'Escape' && openDialogEl) {
      e.stopPropagation();
      closeDialog();
    }
  }

  function closeDialog() {
    if (!openDialogEl) return;
    openDialogEl.remove();
    openDialogEl = null;
    document.removeEventListener('keydown', onDialogKeyDown, true);
  }

  /* ==========================================================================
     Toast stack
     ========================================================================== */

  function mountToasts(parent) {
    const stack = h('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    parent.appendChild(stack);

    const render = () => {
      clear(stack);
      store.get('toasts').forEach(t => {
        const iconName = t.kind === 'ok' ? 'checkCircle'
          : t.kind === 'warn' ? 'alertTriangle'
          : t.kind === 'danger' ? 'alertCircle'
          : 'info';

        stack.appendChild(
          h('div', { class: `toast toast-${t.kind}` },
            icon(iconName, 'icon'),
            h('div', { class: 'toast-message' },
              t.message,
              t.actions ? h('div', { class: 'toast-actions' },
                t.actions.map(a =>
                  h('button', {
                    class: 'btn btn-sm btn-outline',
                    onclick: () => { a.onClick?.(); store.dismissToast(t.id); },
                  }, a.label)
                )
              ) : null,
            ),
            h('button', {
              class: 'btn btn-icon btn-sm',
              'aria-label': '关闭',
              onclick: () => store.dismissToast(t.id),
            }, icon('close', 'icon-sm')),
          )
        );
      });
    };

    store.subscribe('toasts', render);
    render();
  }

  /* ==========================================================================
     Small helpers
     ========================================================================== */

  /* Path display: split a path into directory + filename so the filename
     never gets truncated away. */
  function splitPath(path) {
    const idx = path.lastIndexOf('/');
    if (idx === -1) return { dir: '', name: path };
    return { dir: path.slice(0, idx), name: path.slice(idx + 1) };
  }

  /* Middle-elide a long path — keeps the start and the end, which is what
     identifies a path. End-truncation makes every deep path look identical. */
  function elidePath(path, max = 40) {
    if (path.length <= max) return path;
    const keep = Math.floor((max - 1) / 2);
    return `${path.slice(0, keep)}…${path.slice(-keep)}`;
  }

  function iconBtn(iconName, label, onClick, opts = {}) {
    const btn = h('button', {
      class: `btn btn-icon${opts.small ? ' btn-sm' : ''}${opts.className ? ' ' + opts.className : ''}`,
      'aria-label': label,
      data: opts.active ? { active: 'true' } : {},
      onclick: (e) => { e.stopPropagation(); onClick?.(e); },
    }, icon(iconName, opts.small ? 'icon-sm' : 'icon'));

    if (label) attachTooltip(btn, opts.kbd ? h('span', {}, label, h('span', { class: 'tooltip-kbd' }, opts.kbd)) : label);
    return btn;
  }

  function pill(text, tone = 'muted', iconName = null) {
    return h('span', { class: `pill pill-${tone}` },
      iconName ? icon(iconName, 'icon-sm') : null,
      text,
    );
  }

  function dot(tone = 'muted', animated = false) {
    return h('span', { class: `dot dot-${tone}${animated ? ' animate-breathe' : ''}` });
  }

  /* Circular percentage ring used by telemetry */
  function ring(ratio, tone = 'muted', size = 16) {
    const r = (size - 2) / 2;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - Math.min(1, Math.max(0, ratio)));

    const ns = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(ns, 'svg');
    svgEl.setAttribute('viewBox', `0 0 ${size} ${size}`);

    const track = document.createElementNS(ns, 'circle');
    track.setAttribute('class', 'ring-track');
    track.setAttribute('cx', size / 2);
    track.setAttribute('cy', size / 2);
    track.setAttribute('r', r);

    const fill = document.createElementNS(ns, 'circle');
    fill.setAttribute('class', 'ring-fill');
    fill.setAttribute('cx', size / 2);
    fill.setAttribute('cy', size / 2);
    fill.setAttribute('r', r);
    fill.setAttribute('stroke-dasharray', c);
    fill.setAttribute('stroke-dashoffset', offset);

    svgEl.appendChild(track);
    svgEl.appendChild(fill);

    return h('span', { class: 'ring', data: { tone } }, svgEl);
  }

  /* Empty state block */
  function emptyState(iconName, title, desc, action = null) {
    return h('div', { class: 'empty-state' },
      icon(iconName, 'icon-lg'),
      h('div', { class: 'empty-state-title' }, title),
      desc ? h('div', { class: 'empty-state-desc' }, desc) : null,
      action,
    );
  }

  /* Section label */
  function sectionLabel(text) {
    return h('div', { class: 'section-label' }, text);
  }


  OMP.mod['js/ui'] = { showPopover, closePopover, isPopoverOpen, menuItem, menuSep, menuGroupLabel, attachContextMenu, attachTooltip, makeResizer, animateLayout, showDialog, closeDialog, mountToasts, splitPath, elidePath, iconBtn, pill, dot, ring, emptyState, sectionLabel };
})(window.OMP = window.OMP || { mod: {} });
