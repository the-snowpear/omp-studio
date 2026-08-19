/**
 * Capture README screenshots from the renderer preview harness.
 * Usage: node scripts/capture-readme-shots.mjs
 * Expects Vite at http://127.0.0.1:5179/preview-app-harness.html?preview=1
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs", "images");
const base = process.env.SHOT_URL ?? "http://127.0.0.1:5179/preview-app-harness.html?preview=1";

async function hideMarketingNoise(page) {
  await page.addStyleTag({
    content: `
      .startup-notice, .tip-layer, .tip-host { display: none !important; }
      .mc-page-banner, .git-notice, .hub-ro-banner { display: none !important; }
    `,
  }).catch(() => undefined);
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
    for (const el of document.querySelectorAll(".chip, .tiny.muted, p.tiny.muted")) {
      const text = (el.textContent ?? "").trim();
      if (text === "演示" || text.startsWith("演示模式") || text === "演示 diff" || text.includes("当前是演示数据")) {
        el.style.display = "none";
      }
    }
    const sub = document.querySelector(".ce-sub");
    if (sub && (sub.textContent ?? "").includes("演示")) sub.style.visibility = "hidden";
  });
}

async function waitSettled(page) {
  await page.waitForTimeout(500);
}

async function shot(page, name) {
  await hideMarketingNoise(page);
  await waitSettled(page);
  const dest = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: dest, type: "png", animations: "disabled" });
  console.log("wrote", dest);
}

async function collapseChrome(page) {
  const side = page.locator(".tb-right > button[data-tip='右侧面板']");
  if (await side.count() && (await side.getAttribute("aria-expanded")) === "true") {
    await side.click();
    await waitSettled(page);
  }
  const bottom = page.locator("#bottomPanel [aria-controls='bottomPanel']");
  if (await bottom.count() && (await bottom.getAttribute("aria-expanded")) === "true") {
    await bottom.click();
    await waitSettled(page);
  }
}

async function pageNav(page, route) {
  await page.locator(`nav.page-nav > a[data-nav="${route}"]`).click();
}

async function gotoWorkbench(page) {
  const back = page.getByRole("button", { name: "返回工作台" });
  if (await back.count()) {
    await back.click();
  } else {
    const nav = page.locator('nav.page-nav > a[data-nav="workbench"]');
    if (await nav.count()) await nav.click();
  }
  await page.locator("#workbench").waitFor({ timeout: 20_000 });
  await collapseChrome(page);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
    colorScheme: "light",
  });
  page.setDefaultTimeout(20_000);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("#workbench").waitFor({ timeout: 30_000 });
  await page.locator(".composer-region").waitFor({ timeout: 20_000 });
  await waitSettled(page);
  await collapseChrome(page);

  const closePlan = page.getByRole("button", { name: "关闭计划" });
  if (await closePlan.count()) await closePlan.first().click().catch(() => undefined);

  await page.locator(".thread", { hasText: "新建对话（空白）" }).first().click();
  await page.locator(".convo-empty").waitFor();
  await page.waitForTimeout(400);
  await shot(page, "workbench");

  await page.locator(".thread", { hasText: "跟踪上游 pi-web" }).first().click();
  await page.locator(".composer-region").waitFor();
  await waitSettled(page);

  await page.getByRole("button", { name: "技能与插件" }).click();
  await page.locator("#skillsDrawer").waitFor();
  await waitSettled(page);
  await shot(page, "skills");
  await page.getByRole("button", { name: "关闭技能面板" }).click().catch(() => undefined);
  await waitSettled(page);

  await page.getByRole("button", { name: "Token 用量详情" }).click();
  await page.locator(".tok-pop, .telemetry-pop").first().waitFor();
  await shot(page, "telemetry");
  await page.keyboard.press("Escape");
  await waitSettled(page);

  const side = page.locator(".tb-right > button[data-tip='右侧面板']");
  if ((await side.getAttribute("aria-expanded")) !== "true") await side.click();
  await page.getByRole("tab", { name: "Git" }).click();
  await page.locator("#spGit").waitFor();
  const expandGraph = page.getByRole("button", { name: "展开提交历史" });
  if (await expandGraph.count()) await expandGraph.first().click().catch(() => undefined);
  await waitSettled(page);
  await shot(page, "git");
  await side.click();
  await waitSettled(page);

  await page.locator(".tb-right > button[data-tip='主页']").click();
  await page.locator(".home-hero").waitFor();
  const month = page.locator(".tk-views button[data-view='month'], .seg.tk-views button", { hasText: "月" });
  if (await month.count()) await month.first().click();
  await page.waitForTimeout(800);
  await shot(page, "home");

  await pageNav(page, "model-config");
  await page.locator("#mcRoot").waitFor();
  await waitSettled(page);
  await shot(page, "models");

  await page.locator("#mcTabRoles").click();
  await page.locator("#mcPanelRoles").waitFor();
  await waitSettled(page);
  await shot(page, "roles");

  await pageNav(page, "capabilities");
  await page.getByRole("heading", { name: "能力中心" }).waitFor();
  await waitSettled(page);
  await shot(page, "capabilities");

  await gotoWorkbench(page);
  await page.getByRole("button", { name: "Agent Hub" }).click();
  await page.locator("#hubRoot").waitFor();
  const hubItem = page.locator("#hubList [role='option']").first();
  if (await hubItem.count()) await hubItem.click();
  await waitSettled(page);
  await shot(page, "hub");

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
