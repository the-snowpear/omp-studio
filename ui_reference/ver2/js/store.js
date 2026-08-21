/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — store.js
     Single state tree + subscriptions + localStorage persistence.

     Persistence rule: the system never silently changes a layout value the
     user set by hand. Anything the user drags, collapses or resizes is
     written here and restored verbatim on reload.
     ========================================================================== */

  const LS_KEY = 'omp-studio:v2';

  /* Which slices of state survive a reload. Everything else is ephemeral. */
  const PERSISTED = [
    'theme',
    'density',
    'sidebarWidth',
    'sidebarCollapsed',
    'layoutByProject',   // { [projectId]: { splitRatio, threadsCollapsed, filesCollapsed, expandedDirs, expandedProjects } }
    'mainLayout',        // 'single' | 'split-h' | 'split-v'
    'mainPrimary',       // 'conversation' | 'diff' | 'preview'
    'mainSecondary',
    'splitRatio',
    'rightPanelOpen',
    'rightPanelWidth',
    'rightPanelTab',
    'bottomPanelOpen',
    'bottomPanelHeight',
    'bottomPanelTab',
    'minimapFilters',
    'minimapPinned',
    'drafts',            // { [threadId]: string } — switching threads must never lose a draft
    'lastScenario',
  ];

  const DEFAULTS = {
    /* ---- Appearance ---- */
    theme: 'dark',
    density: 'compact',

    /* ---- Sidebar ---- */
    sidebarWidth: 272,
    sidebarCollapsed: false,
    layoutByProject: {},

    /* ---- Main work area ---- */
    mainLayout: 'single',
    mainPrimary: 'conversation',
    mainSecondary: 'diff',
    splitRatio: 0.6,

    /* ---- Sub-screen tabs ---- */
    capTab: 'skills',
    settingsTab: 'general',
    _diagTick: 0,

    /* ---- Right panel ---- */
    rightPanelOpen: false,
    rightPanelWidth: 380,
    rightPanelTab: 'changes',

    /* ---- Bottom panel ---- */
    bottomPanelOpen: false,
    bottomPanelHeight: 260,
    bottomPanelTab: 'terminal',

    /* ---- Minimap ---- */
    minimapFilters: null,   // null = all event types visible
    minimapPinned: false,

    /* ---- Composer ---- */
    drafts: {},

    /* ---- Session ---- */
    activeProjectId: 'ws-omp-web',
    activeThreadId: 'th-sync-upstream',
    activeAgentId: null,
    activeFile: null,
    activeDiffFile: null,

    /* ---- Runtime (never persisted) ---- */
    screen: 'workbench',      // workbench | project-home | env-check | history | capabilities | settings | diagnostics
    scenario: 'wb:streaming',
    lastScenario: 'wb:streaming',

    ompStatus: 'ready',       // ready | running | reconnecting | disconnected | error | update-available | starting
    ompVersion: '0.8.4',
    ompError: null,

    runState: 'idle',         // idle | running | aborting | compacting | awaiting-approval | awaiting-user
    currentTurn: 3,

    model: 'omp-opus-5',
    thinkingLevel: 'high',
    fastMode: false,
    permissionMode: 'workspace',   // review | workspace | full
    serviceTier: 'standard',

    followUpQueue: [],
    contextUsed: 0.22,
    compacting: false,

    /* ---- Overlays ---- */
    openMenu: null,           // 'app' | 'omp' | 'model' | 'permission' | 'new' | null
    openDialog: null,
    paletteOpen: false,
    scenarioSwitcherOpen: false,
    toasts: [],

    /* ---- Preview ---- */
    previewState: 'running',  // see preview.js for the 12 states
    previewUrl: 'http://localhost:5173/',
    previewViewport: 'desktop',
    previewPicking: false,

    /* ---- Changes ---- */
    changesScope: 'turn',     // turn | thread | pre-existing
    changesGroupBy: 'turn',   // turn | folder | agent
    diffMode: 'split',        // inline | split
    reviewedFiles: [],
  };

  class Store {
    constructor() {
      this.state = { ...DEFAULTS, ...this._load() };
      this._subs = new Map();
      this._nextId = 1;
      this._applyDocumentAttrs();
    }

    /* ---- Read ---- */
    get(key) {
      return key ? this.state[key] : this.state;
    }

    /* ---- Write ---- */
    set(patch) {
      const changed = [];
      Object.keys(patch).forEach(key => {
        if (this.state[key] !== patch[key]) {
          this.state[key] = patch[key];
          changed.push(key);
        }
      });

      if (!changed.length) return;

      this._save();
      this._applyDocumentAttrs();
      this._notify(changed);
    }

    /* Update a nested value without clobbering siblings */
    setIn(key, subKey, value) {
      this.set({ [key]: { ...this.state[key], [subKey]: value } });
    }

    /* ---- Per-project layout -------------------------------------------
       Each project remembers its own sidebar geometry. Switching projects
       restores that project's layout rather than carrying the last one over.
       -------------------------------------------------------------------- */
    getProjectLayout(projectId = this.state.activeProjectId) {
      return {
        splitRatio: 0.5,
        threadsCollapsed: false,
        filesCollapsed: false,
        expandedDirs: [],
        expandedProjects: [projectId],
        ...(this.state.layoutByProject[projectId] || {}),
      };
    }

    setProjectLayout(patch, projectId = this.state.activeProjectId) {
      const next = { ...this.getProjectLayout(projectId), ...patch };
      this.set({
        layoutByProject: { ...this.state.layoutByProject, [projectId]: next },
      });
    }

    /* ---- Drafts --------------------------------------------------------
       Switching threads must never lose what the user typed.
       -------------------------------------------------------------------- */
    getDraft(threadId = this.state.activeThreadId) {
      return this.state.drafts[threadId] || '';
    }

    setDraft(text, threadId = this.state.activeThreadId) {
      this.setIn('drafts', threadId, text);
    }

    /* ---- Subscriptions ------------------------------------------------- */
    subscribe(keys, fn) {
      const id = this._nextId++;
      this._subs.set(id, { keys: Array.isArray(keys) ? keys : [keys], fn });
      return () => this._subs.delete(id);
    }

    _notify(changed) {
      this._subs.forEach(({ keys, fn }) => {
        if (keys.includes('*') || keys.some(k => changed.includes(k))) {
          fn(this.state, changed);
        }
      });
    }

    /* ---- Persistence --------------------------------------------------- */
    _load() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        const clean = {};
        PERSISTED.forEach(k => {
          if (parsed[k] !== undefined) clean[k] = parsed[k];
        });
        return clean;
      } catch {
        return {};
      }
    }

    _save() {
      try {
        const out = {};
        PERSISTED.forEach(k => { out[k] = this.state[k]; });
        localStorage.setItem(LS_KEY, JSON.stringify(out));
      } catch {
        /* quota or private mode — the prototype still works, it just forgets */
      }
    }

    resetLayout() {
      this.set({
        sidebarWidth: DEFAULTS.sidebarWidth,
        sidebarCollapsed: false,
        layoutByProject: {},
        mainLayout: DEFAULTS.mainLayout,
        rightPanelOpen: false,
        rightPanelWidth: DEFAULTS.rightPanelWidth,
        bottomPanelOpen: false,
        bottomPanelHeight: DEFAULTS.bottomPanelHeight,
      });
    }

    _applyDocumentAttrs() {
      document.documentElement.dataset.theme = this.state.theme;
      document.documentElement.dataset.density = this.state.density;
    }

    /* ---- Toasts -------------------------------------------------------- */
    toast(message, kind = 'info', actions = null) {
      const t = { id: Date.now() + Math.floor(performance.now() % 1000), message, kind, actions };
      this.set({ toasts: [...this.state.toasts, t] });
      if (kind !== 'danger') {
        setTimeout(() => this.dismissToast(t.id), 4200);
      }
      return t.id;
    }

    dismissToast(id) {
      this.set({ toasts: this.state.toasts.filter(t => t.id !== id) });
    }
  }

  const store = new Store();


  OMP.mod['js/store'] = { store, DEFAULTS };
})(window.OMP = window.OMP || { mod: {} });
