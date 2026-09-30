// Renders the macOS menu-bar icon: the app's π glyph as a black silhouette
// with anti-aliased alpha, at 16 px and 32 px (@2x). The "Template" suffix
// makes Electron mark the image as a template, so macOS tints it for light and
// dark menu bars. Output: apps/desktop/resources-darwin/trayTemplate{,@2x}.png
//
//   node scripts/generate-tray-template.mjs

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";

/** Glyph on a 32-unit canvas: a top bar and two legs, the right one longer. */
const SHAPES = [
  { x0: 5, y0: 7, x1: 27, y1: 11.5, r: 2 },
  { x0: 10, y0: 9, x1: 14, y1: 24, r: 2 },
  { x0: 19, y0: 9, x1: 23, y1: 27, r: 2 },
];
const SAMPLES = 8;

function insideRoundRect(x, y, { x0, y0, x1, y1, r }) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

export function renderGlyph(size) {
  const scale = 32 / size;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          if (SHAPES.some((shape) => insideRoundRect(x, y, shape))) hits++;
        }
      }
      rgba[(py * size + px) * 4 + 3] = Math.round((255 * hits) / (SAMPLES * SAMPLES));
    }
  }
  return rgba;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = join(import.meta.dirname, "..", "apps", "desktop", "resources-darwin");
  await mkdir(directory, { recursive: true });
  for (const [size, name] of [[16, "trayTemplate.png"], [32, "trayTemplate@2x.png"]]) {
    await writeFile(join(directory, name), encodePng(size, renderGlyph(size)));
    console.log(`wrote ${join(directory, name)}`);
  }
}
