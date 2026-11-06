/**
 * Fresh full-window stills of the current renderer, from the live embed (public/live)
 * on the demo fixtures. Needs the dev server on :5190.
 * Usage: node tools/capture-live.mjs <path-to-a-playwright-install>
 */
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.argv[2], "package.json"));
const { chromium } = require("playwright");
const out = path.resolve(import.meta.dirname, "../public/media/still");
const CACHE = "C:/Users/123/AppData/Local/ms-playwright";
const browser = await chromium.launch({ headless: true, executablePath: `${CACHE}/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe`, args: ["--font-render-hinting=none", "--force-color-profile=srgb", "--hide-scrollbars"] });
const ROUTES = ["workbench", "home", "history", "agent-hub", "capabilities", "model-config", "settings", "diagnostics"];
for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme });
  for (const route of ROUTES) {
    const page = await ctx.newPage();
    await page.goto(`http://localhost:5190/live/preview-app-harness.html?preview=1&marks=off&theme=${theme}&lang=zh&route=${route}`);
    await page.waitForSelector("html[data-qa-ready=true]", { timeout: 30000 }).catch(() => console.log("not ready", route));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, `${route}-${theme}.png`) });
    console.log(route, theme);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
