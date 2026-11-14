// 图签: the drawing's title block doubles as the download section.
import { i, type IconName } from "../shared/icons";
import iconUrl from "../shared/media/icon-256.webp";
import {
  detectPlatform, formatSize, loadRelease, predatesWorkbench,
  MAC_QUARANTINE_COMMAND, RELEASES_URL, REPO_URL, SOURCE_COMMANDS, WORKBENCH_VERSION,
  type Platform,
} from "../shared/release";

const PLATFORM_ICON: Record<Platform, IconName> = { "win-x64": "windows", "win-arm64": "windows", "mac-arm64": "apple" };

const cmd = (text: string) =>
  `<li class="cmd"><code>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code><button class="copy" type="button" data-copy="${text.replace(/"/g, "&quot;")}">复制</button></li>`;

export async function initDownload(): Promise<void> {
  const host = document.querySelector<HTMLElement>("[data-tb]")!;
  const heroBtn = document.querySelector<HTMLAnchorElement>("[data-hero-dl]")!;
  const heroMeta = document.querySelector<HTMLElement>("[data-hero-meta]")!;
  document.querySelector<HTMLAnchorElement>("[data-gh]")!.href = REPO_URL;

  const [release, mine] = await Promise.all([loadRelease(), detectPlatform()]);
  const old = predatesWorkbench(release);
  const yours = release.assets.find((a) => a.platform === mine);

  const plats = release.assets
    .map(
      (a) =>
        `<div class="tb-plat"${a.platform === mine ? " data-yours" : ""}><b>${i(PLATFORM_ICON[a.platform])}${a.label}</b><span>${a.requires}</span><span class="tb-size">${formatSize(a.bytes)}</span>` +
        `<a class="btn ${a.platform === mine ? "btn-solid" : "btn-ghost"}" href="${a.url}" aria-label="下载 ${a.label} 安装包，版本 ${release.version}">${i("download")}下载</a></div>`,
    )
    .join("");

  const notice = old
    ? `<p class="tb-notice"><b>本页介绍的窗口化工作台属于 ${WORKBENCH_VERSION}，安装包还没有发布。</b>现在能下载的最新安装包是 ${release.version}，里面还没有这套窗口。想马上用上，可以按下面的步骤从源码运行；${WORKBENCH_VERSION} 发布后会出现在 <a class="link" href="${RELEASES_URL}" rel="noopener">Releases 页面</a>。</p>`
    : "";

  host.innerHTML = `
<div class="tb-cell tb-name"><span class="tb-key">名称</span><img src="${iconUrl}" alt="" width="84" height="84"><div><strong>OMP Studio</strong><p>oh-my-pi 的桌面工作台</p></div></div>
<dl class="tb-meta">
<div class="tb-cell"><dt>最新安装包</dt><dd>${release.version}</dd></div>
<div class="tb-cell"><dt>发布日期</dt><dd>${release.date}</dd></div>
<div class="tb-cell"><dt>许可</dt><dd>MIT</dd></div>
<div class="tb-cell"><dt>源码</dt><dd><a class="link" href="${REPO_URL}" rel="noopener">GitHub</a></dd></div>
</dl>
<div class="tb-plats">${plats}</div>
${notice}
<div class="tb-source" id="source">
<div><span class="tb-key">从源码运行</span><h3>五条命令，跑起来。</h3><p>需要 Node.js 22 或更新、Git 和 Bun。macOS 还要先装 Xcode Command Line Tools。</p><ol class="cmds">${SOURCE_COMMANDS.map(cmd).join("")}</ol></div>
<div><span class="tb-key">备注</span>
<p>模型和登录沿用 OMP 的 models.yml 与 omp login，安装包里不带任何供应商密钥。</p>
<p>Runtime 和更新目录用 Ed25519 签名校验。Windows 安装包没有 Authenticode 签名，系统可能会多问一句。</p>
<details><summary>macOS 第一次打开被拦住了</summary><div><p>当前的 dmg 是 ad hoc 签名，还没有公证。到「系统设置 › 隐私与安全性」里点「仍要打开」，或者在终端执行：</p><ul class="cmds">${cmd(MAC_QUARANTINE_COMMAND)}</ul></div></details>
<p><a class="link" href="${release.page}" rel="noopener">查看 ${release.version} 的发布说明</a></p></div>
</div>`;

  host.addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy!);
      b.textContent = "已复制";
      b.dataset.done = "";
    } catch {
      b.textContent = "复制失败";
    }
    setTimeout(() => {
      b.textContent = "复制";
      delete b.dataset.done;
    }, 1600);
  });

  // Hero: name the installer that fits this machine. While the newest installer
  // predates the workbench, the button leads to the title block, where that is explained.
  if (yours) {
    heroBtn.textContent = `下载 ${yours.label} 版`;
    if (!old) heroBtn.href = yours.url;
  }
  heroMeta.textContent = old
    ? `最新安装包 ${release.version}；窗口化工作台随 ${WORKBENCH_VERSION} 发布，现在可从源码运行`
    : `版本 ${release.version}，支持 Windows x64、Windows ARM64 和 macOS Apple Silicon`;
}
