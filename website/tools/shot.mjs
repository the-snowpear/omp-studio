// Review screenshots with the local Chromium, without depending on the Browser pane.
//   node tools/shot.mjs a/ hero.png
//   node tools/shot.mjs a/ feat.png --scroll 1800 --w 1440 --h 900
//   node tools/shot.mjs b/ m.png --w 390 --h 844 --full
//   node tools/shot.mjs a/ x.png --eval "document.querySelector('.x').click()" --wait 800
// Options: --w --h --scroll <px|selector> --full --dark --reduce --wait <ms> --eval <js> --dpr <n> --seq <px,px,...>
//          --mouse "move 600 120; down; move 20 300; up; wait 500; click 30 40"  (real pointer input, runs before --eval)
// Page errors and console errors are printed. Output goes to .shots/.
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const [route = "/", out = "shot.png"] = args.filter((a, n) => !a.startsWith("--") && !(args[n - 1] ?? "").match(/^--(w|h|scroll|wait|eval|dpr|seq|mouse)$/));
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);

const exe = path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe");
const dir = path.join(import.meta.dirname, "..", ".shots");
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ["--force-color-profile=srgb", "--hide-scrollbars", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({
  viewport: { width: Number(opt("w", 1440)), height: Number(opt("h", 900)) },
  deviceScaleFactor: Number(opt("dpr", 1)),
  colorScheme: flag("dark") ? "dark" : "light",
  reducedMotion: flag("reduce") ? "reduce" : "no-preference",
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && console.log("[console.error]", m.text()));
page.on("requestfailed", (r) => !r.url().includes("api.github.com") && console.log("[requestfailed]", r.url()));

// Git Bash rewrites a leading "/" into its install path; write routes as "a/" or "kit.html".
await page.goto(`http://localhost:5190/${route.replace(/^.*Git\//, "").replace(/^\//, "")}`, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(Number(opt("wait", 900)));

const scrollTo = async (target) => {
  await page.evaluate(async (t) => {
    const y = /^\d+$/.test(t) ? Number(t) : (document.querySelector(t)?.getBoundingClientRect().top ?? 0) + scrollY;
    // Step there so scroll-linked animation sees intermediate positions, as a real wheel would.
    const from = scrollY;
    for (let k = 1; k <= 12; k++) {
      scrollTo(0, from + ((y - from) * k) / 12);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, String(target));
  await page.waitForTimeout(700);
};

const js = opt("eval");
const seq = opt("seq");
if (seq) {
  // One file per scroll position: name-0.png, name-1.png, ...
  const stops = seq.split(",");
  for (const [n, stop] of stops.entries()) {
    await scrollTo(stop);
    await page.screenshot({ path: path.join(dir, out.replace(/(\.\w+)$/, `-${n}$1`)) });
  }
} else {
  if (opt("scroll")) await scrollTo(opt("scroll"));
  for (const step of (opt("mouse") ?? "").split(";").map((t) => t.trim().split(/\s+/)).filter((t) => t[0])) {
    const [verb, a, b] = step;
    if (verb === "move") await page.mouse.move(Number(a), Number(b), { steps: 14 });
    else if (verb === "down") await page.mouse.down();
    else if (verb === "up") await page.mouse.up();
    else if (verb === "click") await page.mouse.click(Number(a), Number(b));
    else if (verb === "wait") await page.waitForTimeout(Number(a));
    else if (verb === "scroll") await scrollTo(a);
  }
  if (js) {
    const result = await page.evaluate(js);
    if (result !== undefined) console.log("[eval]", JSON.stringify(result));
    await page.waitForTimeout(Number(opt("wait", 900)));
  }
  await page.screenshot({ path: path.join(dir, out), fullPage: flag("full") });
}
console.log("ok", path.join(".shots", out));
await browser.close();
