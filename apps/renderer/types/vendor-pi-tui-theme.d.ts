// Type stub for the vendored terminal theme contract as consumed by the
// browser-side SVG figures. Only the members the renderer actually reads are
// named; the bundle resolves the real implementation through the vite alias,
// and CI typechecks without pulling the whole tui runtime (and its wire
// dependency) into the renderer program.

export interface Theme {
  dark?: boolean;
  has(key: string): boolean;
  hex(key: string): string;
}
