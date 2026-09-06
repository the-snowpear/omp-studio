/** Bounded Kitty direct-transfer and Sixel decoder. No file/network references. */
export type TerminalGraphic = { source: "kitty" | "sixel"; width?: number; height?: number; data?: string; pixels?: Uint8ClampedArray };
export const GRAPHICS_MAX_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 1024;
const MAX_PIXELS = 512 * 1024;
function dimensions(w: number, h: number) { return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS; }
export function isRasterBase64(data: unknown, mime: unknown): data is string {
  return typeof data === "string" && data.length > 0 && data.length <= GRAPHICS_MAX_BYTES && data.length % 4 === 0 &&
    typeof mime === "string" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime) &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data);
}

export function decodeSixel(body: string): TerminalGraphic {
  // The raster stays bounded even if a hostile stream omits raster attributes.
  const pixels = new Uint8ClampedArray(MAX_SIDE * MAX_SIDE * 4);
  const palette = new Map<number, number[]>([[0, [0, 0, 0]], [1, [255, 255, 255]]]);
  let x = 0, y = 0, width = 0, height = 0, color = 1, i = 0;
  const number = () => { const start = i; while (i < body.length && /[0-9]/.test(body[i]!)) i++; return Number(body.slice(start, i)); };
  const paint = (bits: number, count: number) => {
    if (!Number.isInteger(count) || count < 1 || count > MAX_SIDE || x + count > MAX_SIDE || y + 6 > MAX_SIDE) throw new Error("Sixel dimensions exceed limit");
    const rgb = palette.get(color) ?? [255, 255, 255];
    for (let dx = 0; dx < count; dx++) for (let bit = 0; bit < 6; bit++) if (bits & (1 << bit)) {
      const at = ((y + bit) * MAX_SIDE + x + dx) * 4;
      pixels.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], at);
      height = Math.max(height, y + bit + 1);
    }
    x += count; width = Math.max(width, x);
  };
  while (i < body.length) {
    const c = body[i++]!;
    if (c >= "?" && c <= "~") paint(c.charCodeAt(0) - 63, 1);
    else if (c === "!") { const count = number(); const char = body[i++]; if (!char || char < "?" || char > "~") throw new Error("Invalid Sixel repeat"); paint(char.charCodeAt(0) - 63, count); }
    else if (c === "$") x = 0;
    else if (c === "-") { x = 0; y += 6; if (y >= MAX_SIDE) throw new Error("Sixel height exceeds limit"); }
    else if (c === "#" || c === '"') {
      const values = [number()]; while (body[i] === ";") { i++; values.push(number()); if (values.length > 5) throw new Error("Invalid Sixel attributes"); }
      if (c === '"') {
        const w = values[2] ?? 0, h = values[3] ?? 0;
        if (w || h) { if (!dimensions(w, h)) throw new Error("Sixel dimensions exceed limit"); width = Math.max(width, w); height = Math.max(height, h); }
      } else {
        color = values[0]!; if (color > 255) throw new Error("Sixel palette exceeds limit");
        if (values.length > 1) {
          if (values[1] !== 2 || values.length !== 5 || values.slice(2).some(v => v < 0 || v > 100)) throw new Error("Unsupported Sixel color definition");
          palette.set(color, values.slice(2).map(v => Math.round(v * 2.55)));
        }
      }
    }
  }
  if (!dimensions(width, height)) throw new Error("Sixel dimensions exceed limit");
  const cropped = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) cropped.set(pixels.subarray(row * MAX_SIDE * 4, (row * MAX_SIDE + width) * 4), row * width * 4);
  return { source: "sixel", width, height, pixels: cropped };
}

export class TerminalGraphicsDecoder {
  private pending = "";
  private kitty = "";
  private kittyOptions: Record<string, string> = {};
  push(chunk: string): { text: string; images: TerminalGraphic[]; errors: string[] } {
    const result = { text: "", images: [] as TerminalGraphic[], errors: [] as string[] };
    if (chunk.length + this.pending.length > GRAPHICS_MAX_BYTES) { this.pending = ""; this.kitty = ""; result.errors.push("Terminal graphics input exceeds limit"); return result; }
    this.pending += chunk;
    while (this.pending.length) {
      const start = this.pending.indexOf("\x1b");
      if (start < 0) { result.text += this.pending; this.pending = ""; break; }
      result.text += this.pending.slice(0, start); this.pending = this.pending.slice(start);
      if (this.pending.length === 1) break;
      if (this.pending[1] !== "_" && this.pending[1] !== "P") { result.text += "\x1b"; this.pending = this.pending.slice(1); continue; }
      const end = this.pending.indexOf("\x1b\\", 2); if (end < 0) break;
      const frame = this.pending.slice(0, end + 2); this.pending = this.pending.slice(end + 2);
      try {
        if (frame.startsWith("\x1b_G")) {
          const sep = frame.indexOf(";", 3); if (sep < 0) throw new Error("Invalid Kitty graphic");
          const opts = Object.fromEntries(frame.slice(3, sep).split(",").filter(Boolean).map(p => p.split("=")));
          if (!this.kitty) this.kittyOptions = opts;
          this.kitty += frame.slice(sep + 1, -2);
          if (this.kitty.length > GRAPHICS_MAX_BYTES) throw new Error("Kitty graphic exceeds limit");
          if (opts.m === "1") continue;
          const data = this.kitty; const o = this.kittyOptions; this.kitty = "";
          if ((o.t && o.t !== "d") || o.o || (o.a && !["T", "t"].includes(o.a))) throw new Error("Unsupported Kitty transfer or compression");
          if (!isRasterBase64(data, "image/png")) throw new Error("Invalid Kitty base64");
          if (o.f === "100") {
            if (!data.startsWith("iVBORw0KGgo")) throw new Error("Kitty PNG signature mismatch");
            result.images.push({ source: "kitty", data });
          } else {
            const width = Number(o.s), height = Number(o.v), channels = o.f === "32" ? 4 : o.f === "24" || !o.f ? 3 : 0;
            if (!channels || !dimensions(width, height)) throw new Error("Unsupported Kitty pixel format or dimensions");
            const binary = atob(data); if (binary.length !== width * height * channels) throw new Error("Kitty pixel length mismatch");
            const pixels = new Uint8ClampedArray(width * height * 4);
            for (let p = 0; p < width * height; p++) { for (let c = 0; c < 3; c++) pixels[p * 4 + c] = binary.charCodeAt(p * channels + c); pixels[p * 4 + 3] = channels === 4 ? binary.charCodeAt(p * 4 + 3) : 255; }
            result.images.push({ source: "kitty", width, height, pixels });
          }
        } else {
          const match = /^\x1bP[0-9;]*q([\s\S]*)\x1b\\$/.exec(frame);
          if (match) result.images.push(decodeSixel(match[1]!)); else result.text += frame;
        }
      } catch (e) { this.kitty = ""; result.errors.push(e instanceof Error ? e.message : String(e)); }
      if (result.images.length >= 8) { this.pending = ""; result.errors.push("Terminal graphic count exceeds limit"); break; }
    }
    return result;
  }
}
