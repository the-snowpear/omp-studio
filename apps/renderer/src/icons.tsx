/**
 * ver1 16×16 stroke icon set, ported from ui_reference/ver1/assets/js/icons.js.
 * CSS (.icon / .icon.sm / .icon.lg) owns size and stroke.
 *
 * `satisfies` (not `: Record<string, string>`) is load-bearing: it keeps
 * `keyof typeof PATHS` a literal union, so `<Icon name={…}>` rejects typos and
 * any dynamic source has to prove it publishes a real icon name.
 */
const PATHS = {
  // Primer Octicons mark-github-16 (MIT), github.com/primer/octicons.
  github: '<path fill="currentColor" stroke="none" d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/>',
  menu: '<path d="M2 4h12M2 8h12M2 12h12"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h5A1.5 1.5 0 0 1 14.5 6.5v6a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12.5v-8z"/>',
  "folder-open": '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5V7H4l-2.5 5.5v-8z"/><path d="M1.5 12.5 4 7h10.5l-2 5.7a1.5 1.5 0 0 1-1.4.8H3a1.5 1.5 0 0 1-1.5-1z" fill="none"/>',
  "file-tree": '<path d="M2.5 3H7M2.5 3v9H7M2.5 7.5H7"/><rect x="7" y="1.5" width="6.5" height="3" rx=".6"/><rect x="7" y="6" width="6.5" height="3" rx=".6"/><rect x="7" y="10.5" width="6.5" height="3" rx=".6"/>',
  file: '<path d="M4 1.5h5l3.5 3.5v9.5H4z"/><path d="M9 1.5V5h3.5"/>',
  "file-plus": '<path d="M4 1.5h5l3.5 3.5v9.5H4z"/><path d="M9 1.5V5h3.5"/><path d="M8 7.8v3.8M6.1 9.7h3.8"/>',
  "file-code": '<path d="M4 1.5h5l3.5 3.5v9.5H4z"/><path d="M9 1.5V5h3.5"/><path d="M6.8 8.5 5.2 10l1.6 1.5M9.2 8.5 10.8 10l-1.6 1.5"/>',
  "chevron-r": '<path d="M6 3.5 10.5 8 6 12.5"/>',
  "chevron-d": '<path d="M3.5 6 8 10.5 12.5 6"/>',
  "chevron-l": '<path d="M10 3.5 5.5 8 10 12.5"/>',
  "chevron-u": '<path d="M3.5 10 8 5.5 12.5 10"/>',
  "chevron-ud": '<path d="M5 6l3-3 3 3M5 10l3 3 3-3"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.8"/><circle cx="4.5" cy="12.5" r="1.8"/><circle cx="11.5" cy="5.5" r="1.8"/><path d="M4.5 5.3v5.4M11.5 7.3c0 2.5-3.5 2-5 3.4"/>',
  commit: '<circle cx="8" cy="8" r="2.4"/><path d="M1.5 8h4.1M10.4 8h4.1"/>',
  issue: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/>',
  "pull-request": '<circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="13" r="1.5"/><path d="M4 4.5v7M12 11.5V6a3 3 0 0 0-3-3H8M10 1 8 3l2 2"/>',
  fork: '<circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="12.5" r="1.8"/><path d="M4 5.3v5.4M4 8.5c4 0 8-1 8 4"/>',
  message: '<path d="M2.5 3.5h11v8h-7l-4 3v-11z"/>',
  settings: '<path d="M6.9 1.9h2.2l.3 1.6a4.713 4.713 0 0 1 1.797 1.038l1.536-.541 1.1 1.906-1.236 1.059a4.713 4.713 0 0 1 0 2.076l1.236 1.059-1.1 1.906-1.536-.541A4.713 4.713 0 0 1 9.4 12.5l-.3 1.6H6.9l-.3-1.6a4.713 4.713 0 0 1-1.797-1.038l-1.536.541-1.1-1.906 1.236-1.059a4.713 4.713 0 0 1 0-2.076L2.167 5.903l1.1-1.906 1.536.541A4.713 4.713 0 0 1 6.6 3.5z"/><circle cx="8" cy="8" r="2.2"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2.5 2-2.5 2M8 10.5h3.5"/>',
  alert: '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.5M8 11.8v.2"/>',
  "alert-c": '<circle cx="8" cy="8" r="6.5"/><path d="M8 5v4M8 11v.2"/>',
  check: '<path d="M3 8.5 6.5 12 13 4.5"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  play: '<path d="M5 3.5v9l7.5-4.5z"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/>',
  send: '<path d="M14 2 7.5 8.5M14 2l-4.5 12-2-5.5L2 6.5z"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.2"/>',
  at: '<circle cx="8" cy="8" r="3"/><path d="M11 8v1.2a1.8 1.8 0 0 0 3.6 0V8a6.5 6.5 0 1 0-2.6 5.2"/>',
  slash: '<path d="M10.5 2 5.5 14"/>',
  attach: '<path d="M11 7.5 6.6 11.9a2.3 2.3 0 0 1-3.2-3.2l5.6-5.6a3.5 3.5 0 0 1 5 5l-5.7 5.6"/>',
  image: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.3"/><path d="M14 10.5 10.5 7l-5 5.5"/>',
  eye: '<path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  "eye-off": '<path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z"/><path d="M3.5 3.5l9 9"/>',
  globe: '<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c-4.2 4-4.2 9 0 13 4.2-4 4.2-9 0-13z"/>',
  diff: '<path d="M4 2v12M4 8.5h6.5l2-2M4 12h8"/><circle cx="12.5" cy="3.5" r="1.5"/>',
  /* 变更：圆角方块里一加一减。13px 下只剩约 2.6 单位可用，加号与减号必须隔开
     3.2 单位才不会糊成一团，所以臂长压到 3、外框留到边。 */
  changes: '<rect x="1.5" y="1.5" width="13" height="13" rx="2.8"/><path d="M6.5 6.4h3M8 4.9v3M6.5 11.1h3"/>',
  bot: '<rect x="3" y="6" width="10" height="7" rx="1.5"/><path d="M8 3v3M8 3a1.2 1.2 0 1 0-.1 0zM5.5 9.5h.2M10.3 9.5h.2M3 9H1.8M14.2 9H13"/>',
  cpu: '<rect x="4" y="4" width="8" height="8" rx="1"/><rect x="6.5" y="6.5" width="3" height="3"/><path d="M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/>',
  zap: '<path d="M8.8 1.5 3.5 9h3.7l-.8 5.5L11.7 7H8z"/>',
  clock: '<circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/>',
  history: '<path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9M2.5 13v-3h3"/><path d="M8 5v3l2 1.2"/>',
  pin: '<path d="M9.5 2 14 6.5l-1.8.6L9 10.3l-.5 3-2.8-2.8L2.5 13.7 5.5 10 2.7 7.2l3-.5L8.9 3.5z"/>',
  archive: '<rect x="2" y="2.5" width="12" height="3" rx=".8"/><path d="M3 5.5v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-7M6.5 8.5h3"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4"/>',
  pencil: '<path d="M10.5 2.5 13.5 5.5 5.5 13.5l-3.5.5.5-3.5z"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 3.5v-1h-8v8h1"/>',
  external: '<path d="M6.5 3.5H3v9.5h9.5V9.5M9 2.5h4.5V7M13.2 2.8 7.5 8.5"/>',
  more: '<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
  filter: '<path d="M2 3.5h12l-4.5 5v4l-3 1.5v-5.5z"/>',
  layout: '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M6 2.5v11"/>',
  /* 工作台：一块竖长面板 + 右侧两块叠放。`layout` / `panel` / `columns` 全是
     「矩形 + 一条分割线」，表示「切换某一栏」；工作台是目的地，必须一眼分开，
     所以改用彼此分离的块面拼贴（无外框），剪影与那三个都不同。三块留 1.4 的缝、
     1.3 圆角，18px 下最窄的孔仍有 3px，不糊。 */
  workbench: '<rect x="2.2" y="2.6" width="5.2" height="10.8" rx="1.3"/><rect x="8.8" y="2.6" width="5" height="4.7" rx="1.3"/><rect x="8.8" y="8.7" width="5" height="4.7" rx="1.3"/>',
  columns: '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M8 2.5v11"/>',
  /* 对话工具区：两行「圆钮 + 条目」，读作一列可展开的工具卡片，而不是
     「切换某一栏」的矩形+分割线（panel / columns 那族），避免和右侧栏开关撞脸。 */
  "tool-list": '<circle cx="4.4" cy="4.9" r="1.55"/><circle cx="4.4" cy="11.1" r="1.55"/><path d="M7.6 4.9h5.2M7.6 11.1h5.2"/>',
  rows: '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M2 8h12"/>',
  split: '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M8 2.5v11M5 6H3.5M12.5 6H11"/>',
  camera: '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2L7 2.5h2L10.5 4h2A1.5 1.5 0 0 1 14 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5z"/><circle cx="8" cy="9" r="2.5"/>',
  cursor: '<path d="M4 2.5 12.5 8l-4 .8L6.5 13z"/>',
  network: '<circle cx="8" cy="3.5" r="1.8"/><circle cx="3.5" cy="12" r="1.8"/><circle cx="12.5" cy="12" r="1.8"/><path d="M7 4.8 4.3 10.5M9 4.8l2.7 5.7M5.3 12h5.4"/>',
  console: '<path d="M3 4.5 6.5 8 3 11.5M8 11.5h5"/>',
  bug: '<circle cx="8" cy="9" r="4"/><path d="M8 5V3M5 3l1.5 2M11 3 9.5 5M4 8H2M4.8 11l-2 1.5M12 8h2M11.2 11l2 1.5"/>',
  shield: '<path d="M8 1.5 13 3.8v4c0 3.4-2.3 5.5-5 6.7-2.7-1.2-5-3.3-5-6.7v-4z"/><path d="M5.8 8l1.6 1.6 2.8-3"/>',
  sparkles: '<path d="M8 2l1.2 3.3L12.5 6.5 9.2 7.7 8 11 6.8 7.7 3.5 6.5l3.3-1.2z"/><path d="M12.5 10.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>',
  brain: '<path d="M6 2.5A2 2 0 0 0 4 4.5c-1.2.5-1.7 2-.8 3-1 1-.5 2.8.8 3.2A2 2 0 0 0 6 13.5c1.2 0 2-.8 2-2v-7c0-1.2-.8-2-2-2z"/><path d="M10 2.5a2 2 0 0 1 2 2c1.2.5 1.7 2 .8 3 1 1 .5 2.8-.8 3.2a2 2 0 0 1-2 2.8"/>',
  package: '<path d="M8 1.5 14 4.8v6.5L8 14.5 2 11.3V4.8z"/><path d="M2.2 4.9 8 8l5.8-3.1M8 8v6.3"/>',
  plug: '<path d="M6 1.5V5M10 1.5V5M4 5h8v3a4 4 0 0 1-8 0zM8 12v2.5"/>',
  puzzle: '<path d="M3 2.5h3.5v1.6a1.5 1.5 0 0 0 3 0V2.5H13v3.5h-1.6a1.5 1.5 0 0 0 0 3H13v3.5H9.5v-1.6a1.5 1.5 0 0 0-3 0V12.5H3V9h1.6a1.5 1.5 0 0 0 0-3H3z"/>',
  command: '<path d="M5 5h6v6H5zM5 5H3.5a1.8 1.8 0 1 1 1.8-1.8zM11 5h1.5a1.8 1.8 0 1 0-1.8-1.8zM5 11H3.5a1.8 1.8 0 1 0 1.8 1.8zM11 11h1.5a1.8 1.8 0 1 1-1.8 1.8z"/>',
  book: '<path d="M3 2.5h8A1.5 1.5 0 0 1 12.5 4v9.5H4.5A1.5 1.5 0 0 1 3 12z"/><path d="M3 12a1.5 1.5 0 0 1 1.5-1.5h8"/>',
  user: '<circle cx="8" cy="5" r="3"/><path d="M2.5 14c.8-2.8 2.9-4 5.5-4s4.7 1.2 5.5 4"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.5V11M8 5v.2"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  "arrow-u": '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
  "arrow-d": '<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/>',
  "arrow-l": '<path d="M13 8H3M7.5 3.5 3 8l4.5 4.5"/>',
  "arrow-r": '<path d="M3 8h10M8.5 3.5 13 8l-4.5 4.5"/>',
  home: '<path d="M2.5 7 8 2l5.5 5M4 6v7.5h8V6"/>',
  mic: '<rect x="5.4" y="1.5" width="5.2" height="8.2" rx="2.6"/><path d="M3.3 7.1v.5a4.7 4.7 0 0 0 9.4 0v-.5M8 12.3v2.2M5.7 14.5h4.6"/>',
  pulse: '<path d="M1.5 8h3l1.5-4 3 8 1.5-4h4"/>',
  // 用量条形图：L 形坐标轴 + 三根不同高度的竖柱。顶栏压缩时顶替
  // 「↑ 3.5M ↓ 73k | 36.6M cache」整串数字（见 App.css 的 chrome-size 规则）。
  chart: '<path d="M2.5 2.4v11h11.2"/><path d="M5.7 13.4V10.2"/><path d="M8.9 13.4V4.6"/><path d="M12.1 13.4V7.4"/>',
  box: '<rect x="2" y="2" width="12" height="12" rx="1.5"/>',
  // 停靠区「新标签页」：带页签的窗口轮廓 + 中央十字。
  "new-tab": '<path d="M2 5.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V5.5M2 5.5V4a1.5 1.5 0 0 1 1.5-1.5H7l1.2 3H14"/><path d="M8 7.6v3.8M6.1 9.5h3.8"/>',
  layers: '<path d="M8 2 14 5.5 8 9 2 5.5z"/><path d="M2.5 8.5 8 11.8l5.5-3.3M2.5 11.5 8 14.8l5.5-3.3"/>',
  minimize: '<path d="M3 8h10"/>',
  maximize: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  expand: '<path d="M9.2 2.5h4.3V6.8M13.5 2.5 9 7M6.8 13.5H2.5V9.2M2.5 13.5 7 9"/>',
  restore: '<path d="M6 2.5v3.5H2.5M13.5 6V2.5H10M10 13.5v-3.5h3.5M2.5 10v3.5H6"/>',
  // expand 的反向：两支斜向箭头朝中心收拢（停靠区退出全屏）。
  contract: '<path d="M13.5 2.5 9.3 6.7M9.3 3v3.7H13M2.5 13.5l4.2-4.2M6.7 13V9.3H3"/>',
  database: '<ellipse cx="8" cy="3.5" rx="6" ry="2"/><path d="M2 3.5v9c0 1.1 2.7 2 6 2s6-.9 6-2v-9M2 8c0 1.1 2.7 2 6 2s6-.9 6-2"/>',
  key: '<circle cx="5" cy="10.5" r="3"/><path d="M7.2 8.3 13 2.5M11 4.5l2 2M9 6.5l1.5 1.5"/>',
  link: '<path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1"/>',
  export: '<path d="M8 9.5v-8M4.5 5 8 1.5 11.5 5M3 10v3.5h10V10"/>',
  handoff: '<path d="M13.5 8.5a5.5 5.5 0 0 0-10-3.1M2.5 7.5a5.5 5.5 0 0 0 10 3.1"/><path d="M3.5 2.5v3h3M12.5 13.5v-3h-3"/>',
  worktree: '<path d="M8 2v12M8 5l4-2.5M8 9 4 6.5"/><circle cx="8" cy="2" r="1.3"/><circle cx="12" cy="2.5" r="1.3"/><circle cx="4" cy="6.5" r="1.3"/><circle cx="8" cy="14" r="1.3"/>',
  clone: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M8 5v4.5M5.9 7.4 8 9.5l2.1-2.1"/>',
  temp: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M9.2 4.8 6.3 8.6h2.1l-1.2 2.6 3-3.4H8.1z"/>',
  flask: '<path d="M6 2v4L2.8 12a1 1 0 0 0 .87 1.5h8.66A1 1 0 0 0 13.2 12L10 6V2M5 2h6M4.6 9.5h6.8"/>',
  panel: '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M10.5 2.5v11"/>',
  "panel-bottom": '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M2 10.5h12"/>',
  grip: '<path d="M5 7h6M5 9.5h6" stroke-width="2"/>',
  light: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>',
  moon: '<path d="M13.5 9.5A6 6 0 1 1 6.5 2.5a4.8 4.8 0 0 0 7 7z"/>',
  monitor: '<rect x="2" y="2.5" width="12" height="9" rx="1.2"/><path d="M6 14h4M8 11.5V14"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.2"/><path d="M7 12.5h2"/>',
  tablet: '<rect x="3" y="1.5" width="10" height="13" rx="1.2"/><path d="M7 12.5h2"/>',
  test: '<path d="M6.5 1.5h3M7.5 1.5v5l-4 7a1.5 1.5 0 0 0 1.3 2h6.4a1.5 1.5 0 0 0 1.3-2l-4-7v-5z"/><path d="M5.5 10h5"/>',
  save: '<path d="M3 2.5h8l2.5 2.5v8.5H3z"/><path d="M5.5 2.5V6h5V2.5M5.5 13.5V9.5h5v4"/>',
  unlock: '<rect x="3" y="7" width="10" height="6.5" rx="1.2"/><path d="M5.5 7V4.8a2.5 2.5 0 0 1 5-.6"/>',
  lock: '<rect x="3" y="7" width="10" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  server: '<rect x="2" y="2.5" width="12" height="4.5" rx="1"/><rect x="2" y="9" width="12" height="4.5" rx="1"/><path d="M4.5 4.7h.2M4.5 11.2h.2"/>',
  wrench: '<path d="M13.6 2.8a2.8 2.8 0 0 0-3.9 3.8L4 12.3a1.5 1.5 0 0 0 2.1 2.1l5.7-5.7a2.8 2.8 0 0 0 3.8-3.9L13 6.5 11.5 5z"/>',
  update: '<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 12.5h10"/>',
  download: '<path d="M8 2.5v7M5 6.8 8 9.8l3-3M3 10.5v2.5h10v-2.5"/>',
  rewind: '<path d="M13 3.5 7.5 8 13 12.5zM8.5 3.5 3 8l5.5 4.5z"/>',
  /* 撤销：逆时针回流箭头，圆环与箭头连成一笔。弧的起止角定在 193°/97°（缺口 96°、
     落在左下），让环的左上端正好落在横臂 (y6.83) 上，看起来是箭头从环里长出来；
     L 的竖臂与环顶齐平落到横臂，横臂再向右伸进环内到 x6，角点 (1.5 6.83) 即指向
     左下的箭头尖。旧版把 L 单独摆在环外，两者之间留着一段空档，读起来是两块零件。 */
  undo: '<path d="M2.93 6.83A5.2 5.2 0 1 1 7.37 13.16M6 6.83L1.5 6.83L1.5 2.8"/>',
  queue: '<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/><circle cx="12.5" cy="12" r="1.5"/>',
  steering: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.6"/><path d="M8 2.5v3.9M8 9.6v3.9M2.5 8h3.9M9.6 8h3.9"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8.5" rx="1.2"/><path d="M4 6.5h.2M7 6.5h.2M10 6.5h.2M12 6.5h.2M4 9.5h.2M12 9.5h.2M6 9.5h4"/>',
  logo: '<circle cx="8" cy="8" r="6.5"/><path d="M5.5 11.5c1.5-1 3.5-1 5 0M5.5 6.5c1.5 1 3.5 1 5 0" stroke-width="1.4"/>',
  asterisk: '<path d="M8 1.8v12.4M2.6 4.9l10.8 6.2M13.4 4.9 2.6 11.1"/>',
  palette: '<circle cx="6.3" cy="9" r="2.7"/><circle cx="9.7" cy="9" r="2.7"/><circle cx="8" cy="6.1" r="2.7"/>',
  brush: '<path d="M9.6 2.4 13.6 6.4 7.2 12.8c-.9.9-2.2 1-3.8.7.2-1.5.5-2.8 1.4-3.7z"/><path d="M8.4 3.6 12.4 7.6"/>',
  type: '<path d="M3.4 12.6 7.4 3.3h1.7l4 9.3"/><path d="M5.1 9.1h6.8"/>',
  diamond: '<path d="M8 2 14 8 8 14 2 8z"/><path d="M2 8h12"/>',
  wand: '<path d="M2.8 13.2 10.6 5.4"/><path d="M9.3 3.9 12.1 6.7"/><path d="M12.5 2.1v2.3M11.35 3.25h2.3"/><path d="M4.6 6.1l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7z"/>',
  swatch: '<rect x="2.1" y="2.2" width="7.3" height="7.3" rx="1.6"/><rect x="6.6" y="6.5" width="7.3" height="7.3" rx="1.6"/>',
  slides: '<rect x="2.4" y="3.1" width="11.2" height="7.6" rx="1.2"/><path d="M5.2 13h5.6M8 10.7v2.3"/><path d="M5.2 5.7h5.6M5.2 8h3.5"/>',
  banner: '<path d="M3.2 2.3v11.4"/><path d="M3.2 2.5h9.5l-2.1 2.9 2.1 2.9H3.2"/>',
  hexagon: '<path d="M8 1.6 13.7 4.9v6.2L8 14.4 2.3 11.1V4.9z"/>',
  "pen-nib": '<path d="M8 14.1 3.7 9.4 10.8 2.3a2 2 0 0 1 2.8 2.8L6.5 12.2z"/><path d="M9.2 4.6 11.4 6.8"/><path d="M8 14.1 6.7 10.8h2.6z"/>',
  /* ---- Explorer 文件类型（spec §1.1「剪影自证」6 条 + 敏感文件的 shield-key） ----
     全部 16 viewBox / 纯 stroke，不写 stroke-width（由 .icon 统一给 1.6 round）；
     实心圆钮与锁孔是唯一的 fill：r1.9 / r1.3 的环在 14px 下内径只剩 1.6px，
     描边版会糊成脏点。ink 外包一律落在 8.5–13 × 11–13，与 file / folder 同级。
     `braces` 已裁定砍除（14px 下读作一对圆括号、ink 仅 14%）—— tsconfig 退回 sliders。 */
  // 一对尖括号，2 笔。无斜杠：斜杠端点距括号仅 1.7 单位，14px 下会粘连。
  code: '<path d="M6.2 2.8 2.6 8l3.6 5.2M9.8 2.8 13.4 8l-3.6 5.2"/>',
  wrap: '<path d="M2 3.5h12M2 7.5h9.3a2.2 2.2 0 0 1 0 4.4H8"/><path d="M9.6 10.3 8 11.9l1.6 1.6M2 11.9h3.4"/>',
  rotate: '<rect x="2.5" y="6.5" width="7" height="7" rx="1"/><path d="M7.5 2.5h1.8a4 4 0 0 1 4 4v1.6"/><path d="m11.6 6.6 1.7 1.6 1.6-1.6"/>',
  // 斜置标签牌，单笔闭合，无孔（孔在 14px 下会闭合）。
  tag: '<path d="M9 2.4h4.4v4.4L7.8 12.6 3.2 8z"/>',
  // 单笔闭合水滴。
  droplet: '<path d="M8 2.2c2.4 3 4.1 5.2 4.1 7.1a4.1 4.1 0 0 1-8.2 0c0-1.9 1.7-4.1 4.1-7.1z"/>',
  // 开放式行线（左脊 + 4 条横线，**不闭合右缘**）。spec §1.1 选定 V3：
  // 闭合框版本与 package 立方体的剪影距离只有 0.240（全套最差），且两者同色。
  table: '<path d="M3 2.8v10.4M3 2.8h10.2M3 6.2h10.2M3 9.6h10.2M3 13.2h10.2"/>',
  // 页面 + 2 条正文线。唯一与风格 A 收敛的类别（"朴素文档就该朴素"）。
  // 硬约束：`file` 永久只做 fallback，不许再指定给任何已识别类型。
  doc: '<path d="M4 1.5h5l3.5 3.5v9.5H4z"/><path d="M9 1.5V5h3.5"/><path d="M6.4 9.4h3.2M6.4 11.6h2.2"/>',
  // 双滑杆：2 条轨 + 2 个实心圆钮。
  sliders: '<path d="M2.4 4.6h11.2M2.4 11.4h11.2"/><circle cx="5.6" cy="4.6" r="1.9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="11.4" r="1.9" fill="currentColor" stroke="none"/>',
  // 盾牌 + 实心锁孔。密钥类中 `.pem`/`.key`/`id_rsa` 用它；`.env` 走 key（见 PINNED_ICON）。
  "shield-key": '<path d="M8 1.8 13 4v3.6c0 3.3-2.2 5.3-5 6.5-2.8-1.2-5-3.2-5-6.5V4z"/><circle cx="8" cy="7.3" r="1.3" fill="currentColor" stroke="none"/><path d="M8 8.6v2.2"/>',
} satisfies Record<string, string>;

/** Every key of `PATHS`. The only accepted `Icon` name — no `string` escape hatch. */
export type IconName = keyof typeof PATHS;

/** App / project mark served from `apps/renderer/public/icon.png`. */
export const APP_ICON_SRC = `${import.meta.env.BASE_URL}icon.png`;

export function AppIcon({ className, size }: { className?: string; size?: number }) {
  return (
    <img
      className={className}
      src={APP_ICON_SRC}
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  );
}

/** Type guard for sources that only have a runtime string (tables, tool payloads). */
export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(PATHS, name);
}

export function iconSvg(name: IconName, extra?: string): string {
  const className = extra ? `icon ${extra}` : "icon";
  return `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true">${PATHS[name] ?? PATHS.box ?? ""}</svg>`;
}

/**
 * `dangerouslySetInnerHTML` 的值对象必须按内容缓存。
 *
 * React 19 的 `setProp` 对该属性按**对象引用**比较：每次渲染内联新建
 * `{{ __html }}` 会让所有 `Icon` 在每次提交时整段重写 innerHTML（实测整棵应用
 * ~550 个图标 × 每次提交 = 每秒上万次 SVG 子树重建，且喂给 composer 碰撞测量
 * 的 MutationObserver 形成自持循环）。按 name（或 box 兜底）缓存后引用稳定，
 * React 直接跳过。
 */
const INNER_HTML = new Map<string, { __html: string }>();
function iconInnerHtml(name: IconName): { __html: string } {
  const key = PATHS[name] !== undefined ? name : "box";
  let cached = INNER_HTML.get(key);
  if (cached === undefined) {
    cached = { __html: PATHS[name] ?? PATHS.box ?? "" };
    INNER_HTML.set(key, cached);
  }
  return cached;
}

export function Icon({ name, extra }: { name: IconName; extra?: string }) {
  return (
    <svg
      className={extra ? `icon ${extra}` : "icon"}
      viewBox="0 0 16 16"
      aria-hidden="true"
      dangerouslySetInnerHTML={iconInnerHtml(name)}
    />
  );
}
