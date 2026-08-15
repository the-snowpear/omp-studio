/**
 * ver1 16×16 stroke icon set, ported from ui_reference/ver1/assets/js/icons.js.
 * CSS (.icon / .icon.sm / .icon.lg) owns size and stroke.
 */
const PATHS: Record<string, string> = {
  menu: '<path d="M2 4h12M2 8h12M2 12h12"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h5A1.5 1.5 0 0 1 14.5 6.5v6a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12.5v-8z"/>',
  "folder-open": '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5V7H4l-2.5 5.5v-8z"/><path d="M1.5 12.5 4 7h10.5l-2 5.7a1.5 1.5 0 0 1-1.4.8H3a1.5 1.5 0 0 1-1.5-1z" fill="none"/>',
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
  fork: '<circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="12.5" r="1.8"/><path d="M4 5.3v5.4M4 8.5c4 0 8-1 8 4"/>',
  message: '<path d="M2.5 3.5h11v8h-7l-4 3v-11z"/>',
  settings: '<circle cx="8" cy="8" r="4.2"/><path d="M12.2 8h1.8M11 11l1.2 1.2M8 12.2v1.8M5 11l-1.2 1.2M3.8 8H2M5 5L3.8 3.8M8 3.8V2M11 5l1.2-1.2"/><circle cx="8" cy="8" r="1.4"/>',
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
  columns: '<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M8 2.5v11"/>',
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
  pulse: '<path d="M1.5 8h3l1.5-4 3 8 1.5-4h4"/>',
  box: '<rect x="2" y="2" width="12" height="12" rx="1.5"/>',
  layers: '<path d="M8 2 14 5.5 8 9 2 5.5z"/><path d="M2.5 8.5 8 11.8l5.5-3.3M2.5 11.5 8 14.8l5.5-3.3"/>',
  minimize: '<path d="M3 8h10"/>',
  maximize: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  restore: '<path d="M6 2.5v3.5H2.5M13.5 6V2.5H10M10 13.5v-3.5h3.5M2.5 10v3.5H6"/>',
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
  rewind: '<path d="M13 3.5 7.5 8 13 12.5zM8.5 3.5 3 8l5.5 4.5z"/>',
  queue: '<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/><circle cx="12.5" cy="12" r="1.5"/>',
  steering: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.6"/><path d="M8 2.5v3.9M8 9.6v3.9M2.5 8h3.9M9.6 8h3.9"/>',
  keyboard: '<rect x="1.5" y="4" width="13" height="8.5" rx="1.2"/><path d="M4 6.5h.2M7 6.5h.2M10 6.5h.2M12 6.5h.2M4 9.5h.2M12 9.5h.2M6 9.5h4"/>',
  logo: '<circle cx="8" cy="8" r="6.5"/><path d="M5.5 11.5c1.5-1 3.5-1 5 0M5.5 6.5c1.5 1 3.5 1 5 0" stroke-width="1.4"/>',
};

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

export function Icon({ name, extra }: { name: string; extra?: string }) {
  return (
    <svg
      className={extra ? `icon ${extra}` : "icon"}
      viewBox="0 0 16 16"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? PATHS.box ?? "" }}
    />
  );
}
