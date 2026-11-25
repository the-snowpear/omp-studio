// Renders 1200x630 Open Graph / Twitter share cards for both zh-CN and en pages.
// Usage: node tools/og-image.mjs
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUB = path.join(ROOT, "public");
const SHOTS = path.join(ROOT, "shared", "shots");

const dataUrl = (file, mime) =>
  `data:${mime};base64,${readFileSync(file).toString("base64")}`;

const iconUrl = dataUrl(path.join(PUB, "icon-192.png"), "image/png");
const lightShot = dataUrl(path.join(SHOTS, "home-light.webp"), "image/webp");
const darkShot = dataUrl(path.join(SHOTS, "agent-hub-dark.webp"), "image/webp");

const cache = path.join(os.homedir(), "AppData/Local/ms-playwright");
const revision = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))[0];
const exe = path.join(cache, revision ?? "", "chrome-win64/chrome.exe");

const cards = [
  {
    out: path.join(PUB, "og-image.png"),
    lang: "zh-CN",
    eyebrow: "oh-my-pi (omp) · 开源跨平台桌面工作台",
    title: "把 Agent 装进一张<br><span>随你摆放</span>的工作台",
    sub: "对话、Git、终端、浏览器、Agent Hub 与电脑操作都是窗口。拖放分屏、五处停靠或钉成独立系统窗口。",
    pills: ["Windows · macOS · Linux", "Studio Bridge", "MCP · Skills · SSH"],
  },
  {
    out: path.join(PUB, "og-image-en.png"),
    lang: "en",
    eyebrow: "oh-my-pi (omp) · Open-Source Desktop Workbench",
    title: "Give your Agents<br>a desk <span>you arrange</span>",
    sub: "Conversations, Git, terminal, browser, Agent Hub, and computer use as snap-ready windows across Windows, macOS, and Linux.",
    pills: ["Windows · macOS · Linux", "Typed Studio Bridge", "MCP · Skills · SSH"],
  },
];

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });

for (const c of cards) {
  await page.setContent(`<!doctype html>
<html lang="${c.lang}">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    color: #15141a;
    background:
      radial-gradient(58% 68% at 14% 16%, #d9cffb 0%, transparent 72%),
      radial-gradient(52% 62% at 88% 20%, #f7cdee 0%, transparent 70%),
      radial-gradient(66% 70% at 72% 96%, #c6e2fd 0%, transparent 72%),
      #f4f4f7;
    display: grid;
    grid-template-columns: 540px 1fr;
    align-items: center;
    padding: 56px 56px 56px 64px;
    gap: 28px;
  }
  .copy { display: flex; flex-direction: column; gap: 20px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .brand img { width: 52px; height: 52px; border-radius: 14px; box-shadow: 0 10px 24px -8px rgba(45, 24, 110, 0.35); }
  .brand b { font-size: 26px; font-weight: 800; letter-spacing: -0.02em; }
  .eyebrow {
    display: inline-block; width: fit-content;
    padding: 5px 12px; border-radius: 999px;
    background: rgba(255, 255, 255, 0.72); border: 1px solid rgba(24, 20, 44, 0.1);
    font-size: 14px; font-weight: 600; color: #53515d;
  }
  h1 { font-size: ${c.lang === "en" ? "46px" : "44px"}; font-weight: 800; line-height: 1.15; letter-spacing: -0.03em; }
  h1 span {
    background: linear-gradient(96deg, #7c5cf0 8%, #2c8ee6 96%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .sub { font-size: 18px; line-height: 1.55; color: #474454; }
  .pills { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  .pills span {
    padding: 6px 13px; border-radius: 10px;
    background: rgba(255, 255, 255, 0.85);
    border: 1px solid rgba(24, 20, 44, 0.09);
    font-size: 13.5px; font-weight: 600; color: #2b2936;
  }
  .stage { position: relative; height: 490px; }
  .shot {
    position: absolute; border-radius: 16px; overflow: hidden;
    border: 1px solid rgba(24, 20, 44, 0.12);
    box-shadow: 0 28px 60px -22px rgba(32, 18, 86, 0.42);
    background: #fff;
  }
  .shot img { display: block; width: 100%; height: auto; }
  .shot-back { width: 500px; right: -16px; top: 18px; transform: rotate(2deg); }
  .shot-front { width: 500px; left: 8px; bottom: 18px; transform: rotate(-1.5deg); }
</style>
</head>
<body>
  <div class="copy">
    <div class="brand"><img src="${iconUrl}" alt=""><b>OMP Studio</b></div>
    <span class="eyebrow">${c.eyebrow}</span>
    <h1>${c.title}</h1>
    <p class="sub">${c.sub}</p>
    <div class="pills">${c.pills.map((p) => `<span>${p}</span>`).join("")}</div>
  </div>
  <div class="stage">
    <div class="shot shot-back"><img src="${darkShot}" alt=""></div>
    <div class="shot shot-front"><img src="${lightShot}" alt=""></div>
  </div>
</body>
</html>`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: c.out });
  console.log("wrote", c.out);
}
await browser.close();
