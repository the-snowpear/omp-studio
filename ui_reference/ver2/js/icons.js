/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — icons.js
     Single linear icon set. 16px grid, 1.5px stroke, currentColor.
     No emoji, no multicolor icons — they break the quiet visual register
     and can't inherit semantic state color.
     ========================================================================== */

  const P = {
    /* ---- Brand ---- */
    pi: 'M4 5h9M6.5 5v7.5M11 5v5.5c0 1 .4 1.5 1.2 1.5',

    /* ---- App / navigation ---- */
    menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
    search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM10.6 10.6L14 14',
    plus: 'M8 3.5v9M3.5 8h9',
    minus: 'M3.5 8h9',
    close: 'M4 4l8 8M12 4l-8 8',
    check: 'M3.5 8.5l3 3 6-6.5',
    chevronRight: 'M6 3.5l4.5 4.5L6 12.5',
    chevronLeft: 'M10 3.5L5.5 8l4.5 4.5',
    chevronDown: 'M3.5 6L8 10.5 12.5 6',
    chevronUp: 'M3.5 10L8 5.5 12.5 10',
    chevronsUpDown: 'M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3',
    arrowRight: 'M3 8h10M9.5 4.5L13 8l-3.5 3.5',
    arrowLeft: 'M13 8H3M6.5 4.5L3 8l3.5 3.5',
    arrowUp: 'M8 13V3M4.5 6.5L8 3l3.5 3.5',
    arrowDown: 'M8 3v10M4.5 9.5L8 13l3.5-3.5',
    externalLink: 'M9 3h4v4M13 3L7.5 8.5M11 9.5V12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1h2.5',
    moreHorizontal: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
    moreVertical: 'M8 3.5v.01M8 8v.01M8 12.5v.01',
    refresh: 'M13 8a5 5 0 11-1.5-3.5M13 2v3h-3',
    rotateCcw: 'M3 8a5 5 0 101.5-3.5M3 2v3h3',
    history: 'M8 4.5V8l2.5 1.5M2.6 6.5A5.5 5.5 0 118 13.5a5.5 5.5 0 01-4.4-2.2M2.5 3v3.5H6',

    /* ---- Files / tree ---- */
    file: 'M9 2H4.5a1 1 0 00-1 1v10a1 1 0 001 1h7a1 1 0 001-1V5.5L9 2zM9 2v3.5h3.5',
    fileCode: 'M9 2H4.5a1 1 0 00-1 1v10a1 1 0 001 1h7a1 1 0 001-1V5.5L9 2zM9 2v3.5h3.5M6.5 9L5 10.5 6.5 12M9.5 9l1.5 1.5L9.5 12',
    folder: 'M2.5 4.5a1 1 0 011-1h2.7l1.3 1.5h5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1v-7.5z',
    folderOpen: 'M2.5 5.5a1 1 0 011-1h2.7l1.3 1.5h4.5a1 1 0 011 1M2.5 5.5v6a1 1 0 001 1h9a1 1 0 00.97-.76L14.5 7H4.2a1 1 0 00-.97.76L2.5 11.5',
    folderPlus: 'M2.5 4.5a1 1 0 011-1h2.7l1.3 1.5h5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1v-7.5zM8 7.5v4M6 9.5h4',
    filePlus: 'M9 2H4.5a1 1 0 00-1 1v10a1 1 0 001 1h7a1 1 0 001-1V5.5L9 2zM9 2v3.5h3.5M8 8v4M6 10h4',
    copy: 'M6 6V3.5a1 1 0 011-1h5.5a1 1 0 011 1V9a1 1 0 01-1 1H10M3.5 6h5.5a1 1 0 011 1v5.5a1 1 0 01-1 1H3.5a1 1 0 01-1-1V7a1 1 0 011-1z',
    trash: 'M3 5h10M6 5V3.5h4V5M4.5 5l.5 8.5h6l.5-8.5M6.5 7.5v4M9.5 7.5v4',
    edit: 'M8 13H3M11 2.5l2.5 2.5L7 11.5l-3 .5.5-3L11 2.5z',
    save: 'M12.5 13.5h-9a1 1 0 01-1-1v-9a1 1 0 011-1H10l3.5 3.5v6.5a1 1 0 01-1 1zM5 2.5v4h5v-4M5 13.5v-4h6v4',

    /* ---- Git ---- */
    gitBranch: 'M4.5 3v6.5M4.5 12.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM4.5 4.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM11.5 6.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM11.5 6.5V8a2 2 0 01-2 2H4.5',
    gitCommit: 'M2 8h3.5M10.5 8H14M8 11a3 3 0 100-6 3 3 0 000 6z',
    gitMerge: 'M4.5 5.5v7M4.5 4.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM4.5 14a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM11.5 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM10 8H8a3.5 3.5 0 01-3.5-3.5',
    gitFork: 'M8 6.5v3M4.5 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM11.5 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM8 13.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM4.5 5.5v1A2 2 0 006.5 8.5h3a2 2 0 002-2v-1',
    gitPullRequest: 'M4.5 5.5v7M4.5 4.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM4.5 14a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM11.5 14a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM11.5 11V6.5L9 4',

    /* ---- Tools (13 types) ---- */
    toolRead: 'M2.5 4.5v7.8c1.8-1 3.7-1 5.5 0 1.8-1 3.7-1 5.5 0V4.5c-1.8-1-3.7-1-5.5 0-1.8-1-3.7-1-5.5 0zM8 4.5v7.8',
    toolWrite: 'M11 2.5l2.5 2.5L6 12.5l-3 .5.5-3L11 2.5zM2.5 14.5h11',
    toolEdit: 'M11 2.5l2.5 2.5L7 11.5l-3 .5.5-3L11 2.5zM3 6.5H2M3 9.5H2M3 12.5H2',
    toolBash: 'M2.5 3.5h11a1 1 0 011 1v7a1 1 0 01-1 1h-11a1 1 0 01-1-1v-7a1 1 0 011-1zM4.5 7l1.5 1.5L4.5 10M7.5 10.5h4',
    toolSearch: 'M7 12A5 5 0 107 2a5 5 0 000 10zM10.6 10.6L14 14',
    toolGrep: 'M2.5 4h11M2.5 8h6M2.5 12h8M11 6.5l3 3M14 6.5l-3 3',
    toolGit: 'M4.5 3v6.5M4.5 12.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM4.5 4.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM11.5 6.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM11.5 6.5V8a2 2 0 01-2 2H4.5',
    toolBrowser: 'M8 14A6 6 0 108 2a6 6 0 000 12zM2.2 6.5h11.6M2.2 9.5h11.6M8 2c-1.5 1.8-2.2 3.8-2.2 6s.7 4.2 2.2 6c1.5-1.8 2.2-3.8 2.2-6S9.5 3.8 8 2z',
    toolPreview: 'M2 4a1 1 0 011-1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4zM2 6h12M4 4.5h.01M5.8 4.5h.01',
    toolMcp: 'M8 2l5 3v6l-5 3-5-3V5l5-3zM8 2v4.5M8 6.5L3 5M8 6.5L13 5M8 6.5V14',
    toolHost: 'M3 3.5h10a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5a1 1 0 011-1zM5.5 13.5h5M8 10.5v3',
    toolSubagent: 'M8 5.5a1.75 1.75 0 100-3.5 1.75 1.75 0 000 3.5zM4 14a1.75 1.75 0 100-3.5A1.75 1.75 0 004 14zM12 14a1.75 1.75 0 100-3.5A1.75 1.75 0 0012 14zM8 5.5v2.5M8 8H4v2.5M8 8h4v2.5',
    toolPlugin: 'M6 2.5v2.5H4a1 1 0 00-1 1v2h1.25a1.25 1.25 0 010 2.5H3v2a1 1 0 001 1h2v-1.25a1.25 1.25 0 012.5 0V13.5h2a1 1 0 001-1v-2h-1.25a1.25 1.25 0 010-2.5H12.5V6a1 1 0 00-1-1h-2V2.5H6z',

    /* ---- Agent status ---- */
    agent: 'M8 5.5a1.75 1.75 0 100-3.5 1.75 1.75 0 000 3.5zM4 14a1.75 1.75 0 100-3.5A1.75 1.75 0 004 14zM12 14a1.75 1.75 0 100-3.5A1.75 1.75 0 0012 14zM8 5.5v2.5M8 8H4v2.5M8 8h4v2.5',
    brain: 'M6 3a2.5 2.5 0 00-2.5 2.5c-.8.4-1.3 1.2-1.3 2.1 0 .8.4 1.5 1 1.9v.5a2 2 0 002 2h.3a2 2 0 002 2V3.5A1.5 1.5 0 006.5 3H6zM10 3a2.5 2.5 0 012.5 2.5c.8.4 1.3 1.2 1.3 2.1 0 .8-.4 1.5-1 1.9v.5a2 2 0 01-2 2h-.3a2 2 0 01-2 2',
    zap: 'M9.5 1.5L3 9.5h4l-.5 5L13 6.5H9l.5-5z',
    clock: 'M8 4.5V8l2.5 1.5M8 14A6 6 0 108 2a6 6 0 000 12z',
    pause: 'M6 3.5v9M10 3.5v9',
    play: 'M4.5 3l8 5-8 5V3z',
    stop: 'M4 4.5h8v7H4z',
    square: 'M3.5 3.5h9v9h-9z',

    /* ---- Status / feedback ---- */
    alertCircle: 'M8 5v3.5M8 11v.01M8 14A6 6 0 108 2a6 6 0 000 12z',
    alertTriangle: 'M8 3L1.8 13.5h12.4L8 3zM8 6.5V9.5M8 11.5v.01',
    checkCircle: 'M5.5 8.5l2 2 3.5-4M8 14A6 6 0 108 2a6 6 0 000 12z',
    xCircle: 'M6 6l4 4M10 6l-4 4M8 14A6 6 0 108 2a6 6 0 000 12z',
    info: 'M8 7.5v4M8 5v.01M8 14A6 6 0 108 2a6 6 0 000 12z',
    helpCircle: 'M6.3 6a1.8 1.8 0 113 1.4c-.7.5-1.3.8-1.3 1.6M8 11.5v.01M8 14A6 6 0 108 2a6 6 0 000 12z',
    shield: 'M8 2l5 2v4c0 3-2.2 5.3-5 6-2.8-.7-5-3-5-6V4l5-2z',
    shieldCheck: 'M8 2l5 2v4c0 3-2.2 5.3-5 6-2.8-.7-5-3-5-6V4l5-2zM5.8 7.8l1.6 1.6 3-3',
    lock: 'M4 7V5.5a4 4 0 018 0V7M3.5 7h9a.5.5 0 01.5.5v5a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5v-5a.5.5 0 01.5-.5z',
    unlock: 'M4 7V5.5a4 4 0 017.5-2M3.5 7h9a.5.5 0 01.5.5v5a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5v-5a.5.5 0 01.5-.5z',

    /* ---- Panels / layout ---- */
    panelLeft: 'M2.5 3h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V4a1 1 0 011-1zM6 3v10',
    panelRight: 'M2.5 3h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V4a1 1 0 011-1zM10 3v10',
    panelBottom: 'M2.5 3h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V4a1 1 0 011-1zM1.5 10h13',
    layoutSingle: 'M2.5 3h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V4a1 1 0 011-1z',
    layoutSplitH: 'M2.5 3h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V4a1 1 0 011-1zM8 3v10',
    layoutSplitV: 'M2.5 3h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V4a1 1 0 011-1zM1.5 8h13',
    sidebar: 'M2.5 3h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V4a1 1 0 011-1zM6 3v10M3.2 5.5h1.6M3.2 7.5h1.6',
    maximize: 'M6 2.5H3.5a1 1 0 00-1 1V6M10 2.5h2.5a1 1 0 011 1V6M10 13.5h2.5a1 1 0 001-1V10M6 13.5H3.5a1 1 0 01-1-1V10',
    minimize: 'M3.5 6H6V3.5M12.5 6H10V3.5M3.5 10H6v2.5M12.5 10H10v2.5',
    terminal: 'M2.5 3.5h11a1 1 0 011 1v7a1 1 0 01-1 1h-11a1 1 0 01-1-1v-7a1 1 0 011-1zM4.5 7l1.5 1.5L4.5 10M7.5 10.5h4',
    list: 'M5.5 4.5h9M5.5 8h9M5.5 11.5h9M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01',
    columns: 'M2.5 3h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V4a1 1 0 011-1zM6 3v10M10 3v10',
    filter: 'M2 3.5h12l-4.5 5v4.5l-3-1.5V8.5L2 3.5z',
    eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z',
    eyeOff: 'M6.5 4a5.7 5.7 0 011.5-.2c4 0 6.5 4.2 6.5 4.2s-.6 1-1.7 2M9.7 9.8a2 2 0 01-2.9-2.7M2 2l12 12M4.2 5.4A11 11 0 001.5 8S4 12.5 8 12.5c.7 0 1.3-.1 1.9-.3',

    /* ---- Preview ---- */
    monitor: 'M2 4a1 1 0 011-1h10a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V4zM5.5 13.5h5M8 11v2.5',
    tablet: 'M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1zM8 11.8h.01',
    smartphone: 'M5 2h6a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1zM8 11.8h.01',
    camera: 'M2.5 5.5h2L5.5 4h5l1 1.5h2a.5.5 0 01.5.5v6a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5V6a.5.5 0 01.5-.5zM8 11a2.25 2.25 0 100-4.5A2.25 2.25 0 008 11z',
    crosshair: 'M8 14A6 6 0 108 2a6 6 0 000 12zM8 1v3M8 12v3M1 8h3M12 8h3',
    mousePointer: 'M3 2.5l4 11 1.7-4.3L13 7.5 3 2.5z',
    globe: 'M8 14A6 6 0 108 2a6 6 0 000 12zM2.2 6.5h11.6M2.2 9.5h11.6M8 2c-1.5 1.8-2.2 3.8-2.2 6s.7 4.2 2.2 6c1.5-1.8 2.2-3.8 2.2-6S9.5 3.8 8 2z',
    server: 'M3 2.5h10a.5.5 0 01.5.5v2.5a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5zM3 9.5h10a.5.5 0 01.5.5v2.5a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V10a.5.5 0 01.5-.5zM4.5 4.5h.01M4.5 11.5h.01',
    wifi: 'M8 12.5h.01M5.2 10a4 4 0 015.6 0M2.9 7.5a7.5 7.5 0 0110.2 0',
    wifiOff: 'M8 12.5h.01M5.2 10a4 4 0 014.4-.8M2.9 7.5a7.5 7.5 0 015.6-2.2M13.1 7.5c-.5-.5-1-.9-1.6-1.2M2 2l12 12',

    /* ---- Misc ---- */
    settings: 'M8 10a2 2 0 100-4 2 2 0 000 4zM12.9 10a1.1 1.1 0 00.22 1.21l.04.04a1.33 1.33 0 11-1.88 1.88l-.04-.04a1.1 1.1 0 00-1.87.78v.11a1.33 1.33 0 11-2.67 0v-.06a1.1 1.1 0 00-.72-1 1.1 1.1 0 00-1.21.22l-.04.04a1.33 1.33 0 11-1.88-1.88l.04-.04a1.1 1.1 0 00-.78-1.87h-.11a1.33 1.33 0 110-2.67h.06a1.1 1.1 0 001-.72 1.1 1.1 0 00-.22-1.21l-.04-.04a1.33 1.33 0 111.88-1.88l.04.04a1.1 1.1 0 001.21.22H6a1.1 1.1 0 00.67-1v-.11a1.33 1.33 0 112.66 0v.06a1.1 1.1 0 00.67 1 1.1 1.1 0 001.21-.22l.04-.04a1.33 1.33 0 111.88 1.88l-.04.04a1.1 1.1 0 00-.22 1.21V6a1.1 1.1 0 001 .67h.11a1.33 1.33 0 110 2.66h-.06a1.1 1.1 0 00-1 .67z',
    sliders: 'M2.5 12.5h4M9.5 12.5h4M2.5 8h1.5M7 8h7M2.5 3.5h7M12.5 3.5h1M6.5 11v3M4 6.5v3M9.5 2v3',
    command: 'M4.5 2A2 2 0 116 4v8a2 2 0 11-1.5-2h7A2 2 0 1110 12V4a2 2 0 111.5 2h-7z',
    keyboard: 'M2.5 4h11a1 1 0 011 1v6a1 1 0 01-1 1h-11a1 1 0 01-1-1V5a1 1 0 011-1zM4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M11.5 6.5h.01M4.5 9.5h7',
    bell: 'M8 2a4 4 0 00-4 4c0 3-1.5 4-1.5 4h11S12 9 12 6a4 4 0 00-4-4zM6.5 12.5a1.6 1.6 0 003 0',
    pin: 'M6 10L2.5 13.5M9.5 2.5l4 4M11.5 4.5l-1 1a1 1 0 000 1.4l.6.6a1 1 0 010 1.4L9.7 10a1 1 0 01-1.4 0L6 7.7a1 1 0 010-1.4l1.1-1.1a1 1 0 011.4 0l.6.6a1 1 0 001.4 0l1-1',
    archive: 'M2 4.5h12M3.5 4.5v8a1 1 0 001 1h7a1 1 0 001-1v-8M2 2.5h12v2H2zM6.5 7.5h3',
    download: 'M8 2.5v7M4.5 6.5L8 10l3.5-3.5M2.5 13h11',
    upload: 'M8 10.5v-7M4.5 6.5L8 3l3.5 3.5M2.5 13h11',
    layers: 'M8 2L1.5 5.5 8 9l6.5-3.5L8 2zM1.5 10.5L8 14l6.5-3.5M1.5 8L8 11.5 14.5 8',
    box: 'M8 2l5.5 3v6L8 14l-5.5-3V5L8 2zM2.5 5L8 8l5.5-3M8 8v6',
    cpu: 'M4.5 4.5h7v7h-7zM2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14M6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14',
    database: 'M8 5.5c3 0 5.5-.8 5.5-1.75S11 2 8 2 2.5 2.8 2.5 3.75 5 5.5 8 5.5zM2.5 3.75v8.5C2.5 13.2 5 14 8 14s5.5-.8 5.5-1.75v-8.5M2.5 8C2.5 8.95 5 9.75 8 9.75s5.5-.8 5.5-1.75',
    activity: 'M14 8h-2.7l-2 6-4-12-2 6H1',
    gauge: 'M8 12.5V9.5M9.5 6.5L8 9.5M3 12.5a6 6 0 1110 0',
    bug: 'M8 4.5a3 3 0 013 3v3a3 3 0 01-6 0v-3a3 3 0 013-3zM8 4.5V3M5.5 5L4 3.5M10.5 5L12 3.5M5 8H2.5M11 8h2.5M5 11l-2 1.5M11 11l2 1.5',
    flask: 'M6 2v4L2.8 12a1 1 0 00.87 1.5h8.66A1 1 0 0013.2 12L10 6V2M5 2h6M4.6 9.5h6.8',
    testTube: 'M9.5 2l4 4M11.5 4L5 10.5a2.5 2.5 0 01-3.5-3.5L8 .5M6 7l3 3',
    package: 'M13.5 5.5L8 2.5 2.5 5.5v5L8 13.5l5.5-3v-5zM2.5 5.5L8 8.5l5.5-3M8 8.5v5M5.2 4l5.6 3',
    puzzle: 'M6 2.5v2.5H4a1 1 0 00-1 1v2h1.25a1.25 1.25 0 010 2.5H3v2a1 1 0 001 1h2v-1.25a1.25 1.25 0 012.5 0V13.5h2a1 1 0 001-1v-2h-1.25a1.25 1.25 0 010-2.5H12.5V6a1 1 0 00-1-1h-2V2.5H6z',
    sparkles: 'M6 2l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3zM12 8.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7z',
    bookmark: 'M4 2.5h8a.5.5 0 01.5.5v10.5L8 11l-4.5 2.5V3a.5.5 0 01.5-.5z',
    flag: 'M3.5 14V2.5h7l-.7 2.5 3.2 0v5h-9.5M3.5 2.5v7',
    user: 'M13 14v-1.5a3 3 0 00-3-3H6a3 3 0 00-3 3V14M8 7a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
    users: 'M11 14v-1.5a3 3 0 00-3-3H4.5a3 3 0 00-3 3V14M6.25 7a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM14.5 14v-1.5a3 3 0 00-2.25-2.9M10.5 2.15a3 3 0 010 5.8',
    sun: 'M8 11a3 3 0 100-6 3 3 0 000 6zM8 1.5v1.5M8 13v1.5M3.4 3.4l1.05 1.05M11.55 11.55l1.05 1.05M1.5 8h1.5M13 8h1.5M3.4 12.6l1.05-1.05M11.55 4.45l1.05-1.05',
    moon: 'M13.5 9.3A5.75 5.75 0 016.7 2.5a5.75 5.75 0 106.8 6.8z',
    type: 'M3 3.5h10M8 3.5v9M6 12.5h4',
    hash: 'M6 2l-1 12M11 2l-1 12M2.5 5.5h11M2 10.5h11',
    quote: 'M4.5 5.5c-1.1 0-2 .9-2 2s.9 2 2 2c1.1 0 2-.9 2-2 0-2 1-3 2.5-3.5M11 5.5c-1.1 0-2 .9-2 2s.9 2 2 2c1.1 0 2-.9 2-2 0-2 1-3 2.5-3.5',
    link: 'M6.5 8.5a2.5 2.5 0 003.5 0l2-2a2.5 2.5 0 00-3.5-3.5l-.5.5M9.5 7.5a2.5 2.5 0 00-3.5 0l-2 2a2.5 2.5 0 003.5 3.5l.5-.5',
    paperclip: 'M13 7.5l-5.6 5.6a3 3 0 01-4.2-4.2l6-6a2 2 0 012.8 2.8l-6 6a1 1 0 01-1.4-1.4l5.3-5.3',
    image: 'M3 2.5h10a.5.5 0 01.5.5v10a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5zM6 7a1.25 1.25 0 100-2.5A1.25 1.25 0 006 7zM13.5 10.5L10 7l-7.5 6.5',
    send: 'M14 2L7 9M14 2l-4.5 12-2.5-5L2 6.5 14 2z',
    cornerDownLeft: 'M12 3v4.5a2 2 0 01-2 2H4M6.5 7L4 9.5 6.5 12',
    cornerUpRight: 'M4 13V8.5a2 2 0 012-2h6M9.5 4L12 6.5 9.5 9',
    volume: 'M7.5 3.5L4 6.5H1.5v3H4l3.5 3v-9zM10.5 6a3 3 0 010 4M12.5 4a6 6 0 010 8',
    volumeOff: 'M7.5 3.5L4 6.5H1.5v3H4l3.5 3v-9zM10 6.5l3 3M13 6.5l-3 3',
  };

  /* Icons that need a fill rather than a stroke */
  const FILLED = new Set([]);

  /* Icons whose geometry needs round joins to read correctly at 16px */
  const ROUND = new Set(['pi', 'toolMcp', 'sparkles']);

  function icon(name, className = 'icon') {
    const path = P[name];
    if (!path) {
      console.warn(`[icons] unknown icon: ${name}`);
      return icon('helpCircle', className);
    }

    const ns = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(ns, 'svg');
    el.setAttribute('viewBox', '0 0 16 16');
    el.setAttribute('fill', 'none');
    el.setAttribute('class', className);
    el.setAttribute('aria-hidden', 'true');

    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);

    if (FILLED.has(name)) {
      p.setAttribute('fill', 'currentColor');
    } else {
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.5');
      p.setAttribute('stroke-linecap', ROUND.has(name) ? 'round' : 'round');
      p.setAttribute('stroke-linejoin', 'round');
    }

    el.appendChild(p);
    return el;
  }

  /* Map a tool type → icon name. Single source of truth so tool cards,
     minimap and telemetry can never disagree about a tool's identity. */
  const TOOL_ICONS = {
    Read: 'toolRead',
    Write: 'toolWrite',
    Edit: 'toolEdit',
    Bash: 'toolBash',
    Search: 'toolSearch',
    Grep: 'toolGrep',
    Git: 'toolGit',
    Browser: 'toolBrowser',
    Preview: 'toolPreview',
    MCP: 'toolMcp',
    HostTool: 'toolHost',
    Subagent: 'toolSubagent',
    Plugin: 'toolPlugin',
  };

  /* Map a file extension → icon name. */
  function fileIcon(name) {
    if (name.endsWith('/')) return 'folder';
    const ext = name.split('.').pop().toLowerCase();
    const code = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'go',
                  'java', 'c', 'cpp', 'h', 'css', 'scss', 'html', 'vue', 'svelte',
                  'sh', 'bash', 'ps1', 'rb', 'php', 'swift', 'kt'];
    if (code.includes(ext)) return 'fileCode';
    return 'file';
  }

  const ICON_NAMES = Object.keys(P);


  OMP.mod['js/icons'] = { icon, fileIcon, TOOL_ICONS, ICON_NAMES };
})(window.OMP = window.OMP || { mod: {} });
