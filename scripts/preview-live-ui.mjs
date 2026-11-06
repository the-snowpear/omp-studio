#!/usr/bin/env node
/**
 * 生产预览的 UI 实时预览：监听 renderer 源码 → 重建 bundle → 让渲染层重载。
 *
 * 生产预览刻意加载 `file://` 的构建产物（改名后的 exe 报告
 * app.isPackaged === true，桌面端会忽略 OMP_RENDERER_DEV_URL）。这份产物
 * 在应用启动时加载一次就固定了，所以改 UI 源码原本必须「改 → 重建 →
 * 关闭应用 → 重开」。这里把后两步自动化：监听源码变化，重建 renderer，
 * 再通过 CDP 让窗口重载，无需重启应用。
 *
 * 重建用 vite build（不是 dev server）：生产预览要的就是产物形态，
 * 走 dev server 就等于换了被测对象。
 *
 * 重载用 CDP 而非新增 IPC 通道：桌面端的 IPC 面是固定的 Studio Bridge
 * 契约，为一个开发期便利新增通道会污染契约；CDP 只在预览进程与渲染层
 * 之间说话，不进产品代码。
 */
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join, sep } from "node:path";
import process from "node:process";

/** 源码变化后多久开始重建，避免连续保存触发多次重建。 */
const DEBOUNCE_MS = 400;

/** 只关心会进入 renderer bundle 的源码；测试与产物目录不参与。 */
const WATCHED_EXTENSIONS = new Set([".ts", ".tsx", ".css", ".html", ".js", ".jsx"]);

/**
 * 判断一个被改动的文件是否值得重建。
 *
 * 导出让这段规则可测：重建一次 renderer 要跑完整 vite build，误判一次就
 * 是白等好几秒。
 */
export function shouldRebuildFor(filePath) {
  if (filePath.includes(`${sep}node_modules${sep}`)) return false;
  if (filePath.includes(`${sep}dist${sep}`)) return false;
  if (filePath.includes(".test.")) return false;
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return WATCHED_EXTENSIONS.has(filePath.slice(dot));
}

/**
 * 让渲染层重载。
 *
 * 通过 CDP 的 Page.reload：先等 devtools target 出现，再连上它的
 * WebSocket 发一条 Page.reload。Node 22 自带 WebSocket，不需要额外依赖。
 */
async function reloadRenderer(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page) {
          await sendPageReload(page.webSocketDebuggerUrl);
          return true;
        }
      }
    } catch {
      // devtools 端口还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function sendPageReload(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const close = (error) => {
      try {
        socket.close();
      } catch {
        // 已经关闭。
      }
      if (error) reject(error);
      else resolve();
    };
    socket.onopen = () => {
      socket.send(JSON.stringify({ id: 1, method: "Page.reload", params: { ignoreCache: true } }));
      // 不等 reload 的执行结果：确认命令送达即可，窗口会自行重载。
      setTimeout(() => close(undefined), 300);
    };
    socket.onerror = () => close(new Error("Failed to reach the renderer devtools target."));
    socket.onclose = () => resolve();
  });
}

/**
 * 启动 renderer 源码监听 + 重建循环。
 *
 * @param {object} options
 * @param {string} options.rendererRoot renderer 源码根目录
 * @param {string} options.devServerPort CDP 端口（应用启动时开启的）
 * @param {string} options.repoRoot 仓库根目录
 * @param {string} options.npmCli npm CLI 路径
 */
export async function startLiveUiPreview({ rendererRoot, devServerPort, repoRoot, npmCli }) {
  if (!existsSync(rendererRoot)) {
    throw new Error(`Renderer sources are missing: ${rendererRoot}`);
  }
  let stopped = false;
  let rebuilding = false;
  let pending = false;
  let timer = null;

  const rebuild = async () => {
    if (rebuilding) {
      // 正在重建：标记为「重建完再来一次」，避免丢改动。
      pending = true;
      return;
    }
    rebuilding = true;
    try {
      const started = Date.now();
      console.log("[preview] UI sources changed, rebuilding the renderer bundle...");
      const code = await runBuild(repoRoot, npmCli);
      if (stopped) return;
      if (code !== 0) {
        console.error("[preview] Renderer build failed; keeping the current bundle.");
        return;
      }
      const reloaded = await reloadRenderer(devServerPort);
      console.log(
        reloaded
          ? `[preview] Renderer rebuilt and reloaded in ${Date.now() - started}ms.`
          : "[preview] Renderer rebuilt, but no window was found to reload.",
      );
    } finally {
      rebuilding = false;
      if (pending && !stopped) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void rebuild();
    }, DEBOUNCE_MS);
  };

  const watcher = watch(rendererRoot, { recursive: true }, (_event, filename) => {
    if (filename == null || !shouldRebuildFor(join(rendererRoot, String(filename)))) return;
    schedule();
  });
  console.log("[preview] Watching renderer sources for live UI updates.");
  return { stop() { stopped = true; if (timer !== null) clearTimeout(timer); watcher.close(); } };
}

function runBuild(repoRoot, npmCli) {
  // ELECTRON_RUN_AS_NODE 会让 electron 退化成纯 node 运行时；重建走 npm
  // 与 vite，不能带着它。env 里写 undefined 会被拼成字符串 "undefined"，
  // 所以要显式删掉这个键。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [npmCli, "run", "build", "-w", "@omp-studio/renderer"],
      {
        cwd: repoRoot,
        env,
        stdio: "pipe",
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => {
      if (code !== 0) console.error(output.trim().split("\n").slice(-40).join("\n"));
      resolve(code ?? 1);
    });
  });
}
