/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — dom.js
     Minimal h() rendering utility. Like Preact/Vue's h(), but vanilla.
     Each component exports create*() → {el, update, destroy}.
     ========================================================================== */

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);

    Object.keys(props).forEach(key => {
      if (key === 'class' || key === 'className') {
        el.className = props[key];
      } else if (key === 'style' && typeof props[key] === 'object') {
        Object.assign(el.style, props[key]);
      } else if (key.startsWith('on') && typeof props[key] === 'function') {
        const event = key.slice(2).toLowerCase();
        el.addEventListener(event, props[key]);
      } else if (key === 'data' && typeof props[key] === 'object') {
        Object.keys(props[key]).forEach(dataKey => {
          el.dataset[dataKey] = props[key][dataKey];
        });
      } else if (props[key] != null && props[key] !== false) {
        el.setAttribute(key, props[key]);
      }
    });

    children.flat(Infinity).forEach(child => {
      if (child == null || child === false) return;
      if (typeof child === 'string' || typeof child === 'number') {
        el.appendChild(document.createTextNode(child));
      } else {
        el.appendChild(child);
      }
    });

    return el;
  }

  function svg(tag, props = {}, ...children) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);

    Object.keys(props).forEach(key => {
      if (key === 'class' || key === 'className') {
        el.setAttribute('class', props[key]);
      } else if (key.startsWith('on') && typeof props[key] === 'function') {
        const event = key.slice(2).toLowerCase();
        el.addEventListener(event, props[key]);
      } else if (props[key] != null && props[key] !== false) {
        el.setAttribute(key, props[key]);
      }
    });

    children.flat(Infinity).forEach(child => {
      if (child == null || child === false) return;
      if (typeof child === 'string' || typeof child === 'number') {
        el.textContent = child;
      } else {
        el.appendChild(child);
      }
    });

    return el;
  }

  function mount(parent, child) {
    if (typeof parent === 'string') {
      parent = document.querySelector(parent);
    }
    parent.appendChild(child);
    return child;
  }

  function unmount(el) {
    el?.remove();
  }

  function clear(parent) {
    if (typeof parent === 'string') {
      parent = document.querySelector(parent);
    }
    while (parent.firstChild) {
      parent.firstChild.remove();
    }
  }

  /* Fragment helper — returns an array that h() will flatten */
  function fragment(...children) {
    return children.flat(Infinity).filter(c => c != null && c !== false);
  }

  /* Conditional rendering */
  function when(condition, trueBranch, falseBranch = null) {
    return condition ? trueBranch : (falseBranch || fragment());
  }

  /* List rendering */
  function each(items, fn) {
    return items.map(fn);
  }

  /* Class name builder */
  function cn(...classes) {
    return classes
      .flat(Infinity)
      .filter(c => c && typeof c === 'string')
      .join(' ');
  }


  OMP.mod['js/dom'] = { h, svg, mount, unmount, clear, fragment, when, each, cn };
})(window.OMP = window.OMP || { mod: {} });
