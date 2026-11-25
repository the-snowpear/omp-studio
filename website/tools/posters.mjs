// Re-records shared/shots/*.webp from the live embed, so the posters match the page that
// replaces them. Needs the dev server running and Python with Pillow:
//   npm run live && npm run dev
//   node tools/posters.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const cache = path.join(os.homedir(), "AppData/Local/ms-playwright");
const revision = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))[0];
const out = path.join(import.meta.dirname, "../shared/shots");
const tmp = path.join(import.meta.dirname, "../.shots/posters");
mkdirSync(tmp, { recursive: true });

const browser = await chromium.launch({ executablePath: path.join(cache, revision ?? "", "chrome-win64/chrome.exe") });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.25 });
for (const theme of ["light", "dark"]) {
  for (const route of ["home", "history", "agent-hub", "model-config", "capabilities", "settings"]) {
    await page.goto(`http://localhost:5190/live/website-embed.html?preview=1&marks=off&embed=1&theme=${theme}&lang=zh&route=${route}`);
    await page.waitForTimeout(3500);
    const png = path.join(tmp, `${route}-${theme}.png`);
    await page.screenshot({ path: png });
    execFileSync("python", ["-c", "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2],quality=84,method=6)", png, path.join(out, `${route}-${theme}.webp`)]);
    console.log(route, theme);
  }
}
await browser.close();
rmSync(tmp, { recursive: true });
