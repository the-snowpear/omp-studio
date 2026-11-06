export const BROWSER_PICKER_WORLD_ID = 97531;
export interface PickedBrowserElement {
  url: string; title: string; selector: string; frameUrl: string; text: string; tagName: string;
  rect: { x: number; y: number; width: number; height: number };
}
export interface BrowserPickerPoll { active: boolean; selections: PickedBrowserElement[]; }

export const BROWSER_PICKER_START = String.raw`(() => {
  if (globalThis.__ompStudioPicker?.active) return true;
  const state = { active: true, queue: [], stop: () => {} };
  globalThis.__ompStudioPicker = state;
  const documents = new Map();
  const frames = new Map();
  const shields = new WeakMap();
  const owned = new Set();
  const rootAbort = new AbortController();
  const highlight = document.createElement('div');
  highlight.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #7c61ff;background:#7c61ff18;box-sizing:border-box;display:none';
  document.documentElement.append(highlight); owned.add(highlight);
  function selector(element) {
    const root = element.getRootNode();
    const segments = [];
    let current = element;
    for (let depth = 0; current && depth < 10; depth++) {
      const candidates = current.id ? ['#' + CSS.escape(current.id)] : [];
      for (const attribute of ['data-testid', 'data-test']) {
        const value = current.getAttribute(attribute);
        if (value !== null) candidates.push('[' + attribute + '="' + CSS.escape(value) + '"]');
      }
      const unique = candidates.find(candidate => root.querySelectorAll(candidate).length === 1);
      if (unique) { segments.unshift(unique); break; }
      const parent = current.parentElement;
      let segment = CSS.escape(current.localName);
      const siblings = Array.from((parent || root).children).filter(sibling => sibling.localName === current.localName);
      if (siblings.length > 1) segment += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      segments.unshift(segment);
      if (root.querySelectorAll(segments.join(' > ')).length === 1) break;
      current = parent;
    }
    const local = segments.join(' > ');
    return root.host ? selector(root.host) + ' >>> ' + local : local;
  }
  function geometry(element) {
    const bounds = element.getBoundingClientRect();
    let rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    let entry = documents.get(element.ownerDocument);
    const prefixes = [];
    while (entry) {
      const view = entry.doc.defaultView;
      const right = Math.min(view.innerWidth, rect.x + rect.width), bottom = Math.min(view.innerHeight, rect.y + rect.height);
      rect.x = Math.max(0, rect.x); rect.y = Math.max(0, rect.y);
      rect.width = Math.max(0, right - rect.x); rect.height = Math.max(0, bottom - rect.y);
      if (!entry.frame) break;
      const frame = entry.frame, box = frame.getBoundingClientRect();
      const scaleX = box.width / (frame.offsetWidth || 1), scaleY = box.height / (frame.offsetHeight || 1);
      rect = { x: box.x + (frame.clientLeft + rect.x) * scaleX, y: box.y + (frame.clientTop + rect.y) * scaleY, width: rect.width * scaleX, height: rect.height * scaleY };
      prefixes.unshift(selector(frame)); entry = documents.get(frame.ownerDocument);
    }
    return { rect, locator: [...prefixes, selector(element)].join(' ::frame:: ') };
  }
  function target(event) {
    const element = event.composedPath().find(node => node.nodeType === 1);
    return shields.get(element) || (owned.has(element) ? null : element);
  }
  function hover(event) {
    const element = target(event); if (!element) return;
    const { rect } = geometry(element);
    Object.assign(highlight.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }
  function intercept(event) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type !== 'click' || event.button !== 0) return;
    const element = target(event); if (!element) return;
    const { rect, locator } = geometry(element);
    if (!rect.width || !rect.height) return;
    state.queue.push({ url: document.URL, title: document.title, frameUrl: element.ownerDocument.URL, selector: locator, text: (element.innerText || element.textContent || '').trim().slice(0, 4000), tagName: element.localName, rect });
  }
  function removeDocument(entry) {
    entry.abort.abort(); entry.observer.disconnect(); documents.delete(entry.doc);
    for (const [frame, value] of frames) if (frame.ownerDocument === entry.doc) {
      value.abort.abort(); value.shield?.remove(); frames.delete(frame);
      if (value.child) removeDocument(value.child);
    }
  }
  function attach(doc, frame = null) {
    if (documents.has(doc)) return documents.get(doc);
    const entry = { doc, frame, abort: new AbortController(), observer: null };
    documents.set(doc, entry);
    const options = { capture: true, passive: false, signal: entry.abort.signal };
    doc.addEventListener('pointermove', hover, options);
    for (const kind of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'dragstart', 'submit']) doc.addEventListener(kind, intercept, options);
    doc.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); state.stop(); } }, options);
    doc.defaultView.addEventListener('pagehide', () => { if (doc === document) state.stop(); else removeDocument(entry); }, { signal: entry.abort.signal });
    function discover(root) {
      if (owned.has(root)) return;
      if (root.nodeType === 1) {
        if (root.localName === 'iframe' && !frames.has(root)) {
          const record = { frame: root, abort: new AbortController(), child: null, shield: null };
          frames.set(root, record);
          const refresh = () => {
            if (record.child) removeDocument(record.child);
            record.child = null; record.shield?.remove(); record.shield = null;
            const child = root.contentDocument;
            if (child) record.child = attach(child, root);
            else {
              const shield = doc.createElement('div'); owned.add(shield); shields.set(shield, root); record.shield = shield;
              shield.style.cssText = 'position:fixed;z-index:2147483646;background:transparent;cursor:crosshair';
              const place = () => { const rect = root.getBoundingClientRect(); Object.assign(shield.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' }); };
              place(); doc.documentElement.append(shield);
              doc.addEventListener('scroll', place, { capture: true, passive: true, signal: record.abort.signal });
              doc.defaultView.addEventListener('resize', place, { signal: record.abort.signal });
            }
          };
          root.addEventListener('load', refresh, { signal: record.abort.signal }); refresh();
        }
        if (root.shadowRoot) { entry.observer.observe(root.shadowRoot, { childList: true, subtree: true }); discover(root.shadowRoot); }
      }
      for (const child of root.children || []) discover(child);
    }
    entry.observer = new MutationObserver(changes => {
      for (const [frame, record] of frames) if (frame === record.frame && !frame.isConnected) { record.abort.abort(); record.shield?.remove(); if (record.child) removeDocument(record.child); frames.delete(frame); }
      for (const change of changes) for (const node of change.addedNodes) discover(node);
    });
    entry.observer.observe(doc, { childList: true, subtree: true }); discover(doc);
    return entry;
  }
  state.stop = () => {
    if (!state.active) return; state.active = false; rootAbort.abort();
    for (const entry of [...documents.values()]) removeDocument(entry);
    for (const node of owned) node.remove(); owned.clear(); frames.clear();
  };
  attach(document);
  document.activeElement?.blur();
  return true;
})()`;
export const BROWSER_PICKER_POLL = "({active: globalThis.__ompStudioPicker?.active === true, selections: globalThis.__ompStudioPicker?.queue.splice(0) ?? []})";
export const BROWSER_PICKER_STOP = "globalThis.__ompStudioPicker?.stop(); true";
