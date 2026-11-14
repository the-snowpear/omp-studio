// 下载: fills the download section from the latest GitHub release.
import { i } from "../shared/icons";
import {
  detectPlatform, formatSize, loadRelease, MAC_QUARANTINE_COMMAND, predatesWorkbench,
  RELEASES_URL, SOURCE_COMMANDS, WORKBENCH_VERSION, type Asset,
} from "../shared/release";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function command(text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "b-cmd";
  const code = document.createElement("code");
  code.textContent = text;
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", `复制命令：${text}`);
  button.innerHTML = i("copy");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // Clipboard blocked: the command is still selectable.
    }
    button.innerHTML = i("check");
    button.dataset.done = "";
    button.setAttribute("aria-label", "已复制");
    setTimeout(() => {
      button.innerHTML = i("copy");
      delete button.dataset.done;
      button.setAttribute("aria-label", `复制命令：${text}`);
    }, 1600);
  });
  row.append(code, button);
  return row;
}

const osIcon = (asset: Asset) => i(asset.platform === "mac-arm64" ? "apple" : "windows");

export async function initDownload(): Promise<void> {
  $("[data-source]").append(...SOURCE_COMMANDS.map(command));
  $("[data-mac-cmd]").replaceWith(command(MAC_QUARANTINE_COMMAND));

  const [release, platform] = await Promise.all([loadRelease(), detectPlatform()]);
  const old = predatesWorkbench(release);
  $("[data-version]").textContent = `最新安装包 ${release.version}，发布于 ${release.date}`;

  if (old) {
    const notice = $("[data-notice]");
    notice.hidden = false;
    notice.innerHTML = `本页介绍的窗口化工作台随 <b>${WORKBENCH_VERSION}</b> 发布。目前能下载到的最新安装包还是 ${release.version}，没有这套窗口。${WORKBENCH_VERSION} 的安装包发布后会出现在 <a class="b-link" href="${RELEASES_URL}" rel="noopener">GitHub Releases</a>；想现在就用，可以<a class="b-link" href="#source">从源码运行</a>。`;
  }

  const mine = release.assets.find((a) => a.platform === platform);
  const primary = $<HTMLAnchorElement>(".b-get [data-primary]");
  if (mine) {
    primary.href = mine.url;
    primary.innerHTML = `${osIcon(mine)}下载 ${mine.label} 版 ${release.version}`;
    $("[data-primary-req]").textContent = `${mine.requires}，${formatSize(mine.bytes)}`;
  } else {
    primary.href = release.page;
    primary.innerHTML = `${i("github")}在 GitHub Releases 查看 ${release.version}`;
    $("[data-primary-req]").textContent = "没有认出你的系统。安装包有 Windows x64、Windows ARM64 和 macOS Apple Silicon 三种。";
  }

  $("[data-others]").innerHTML = release.assets
    .filter((a) => a !== mine)
    .map((a) => `<li><a href="${a.url}">${osIcon(a)}<b>${a.label}</b><span>${a.requires}</span><span>${formatSize(a.bytes)}</span>${i("download")}</a></li>`)
    .join("");
}
