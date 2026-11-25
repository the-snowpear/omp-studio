// Download buttons, the installer list, and the copyable commands.
import { i, icon } from "../shared/icons";
import { MAC_QUARANTINE_COMMAND, SOURCE_COMMANDS, detectPlatform, formatDate, formatSize, knownRelease, loadRelease, type Asset, type Platform, type Release } from "../shared/release";

const osIcon = (os: Asset["os"]) => (os === "macOS" ? icon.apple : os === "Linux" ? icon.linux : icon.windows);

function codeBlock(el: HTMLElement, lines: string[], toast: (text: string) => void) {
  el.innerHTML = `<pre>${lines.map((l) => `<span>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`).join("")}</pre><button type="button" aria-label="复制命令">${i("copy")}</button>`;
  el.querySelector("button")!.addEventListener("click", async (e) => {
    const button = e.currentTarget as HTMLElement;
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      button.innerHTML = i("check");
      button.dataset.done = "";
      toast("已复制");
      setTimeout(() => {
        button.innerHTML = i("copy");
        delete button.dataset.done;
      }, 1600);
    } catch {
      toast("复制失败，请手动选择文本");
    }
  });
}

export function mountDownload(toast: (text: string) => void) {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  codeBlock($("#src-cmd"), SOURCE_COMMANDS, toast);
  codeBlock($("#mac-cmd"), [MAC_QUARANTINE_COMMAND], toast);

  let shown: Release | undefined;
  const paint = (release: Release, platform: Platform | null) => {
    shown = release;
    const mine = release.assets.find((a) => a.platform === platform);
    $("#dl-ver").textContent = `版本 ${release.version}，发布于 ${formatDate(release.published)}`;
    $("#dl-req").textContent = mine ? `${mine.requires}，${mine.variant}，${formatSize(mine.bytes)}` : "在右侧选择你的系统，或者从源码运行。";

    $("#dl-list").innerHTML = (["Windows", "macOS", "Linux"] as const)
      .map((os) => {
        const packages = release.assets.filter((a) => a.os === os);
        if (!packages.length) return "";
        return `<section class="dl-os"><h3><span class="i" aria-hidden="true">${osIcon(os)}</span>${os}</h3><ul>${packages
          .map((a) => `<li${a === mine ? " data-mine" : ""}><a href="${a.url}" aria-label="下载 ${a.label}，${formatSize(a.bytes)}"><b>${a.variant}</b><span>${a.requires}</span><em>${formatSize(a.bytes)}</em>${i("download")}</a></li>`)
          .join("")}</ul></section>`;
      })
      .join("");

    const label = mine ? `下载 ${mine.label} 版` : "查看全部安装包";
    for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-dl-primary]")) {
      const top = a.classList.contains("top-dl");
      if (mine && !top) a.href = mine.url;
      else if (!mine && a.id === "dl-main") a.href = release.page;
      const text = a.querySelector("[data-dl-label]");
      if (text) text.textContent = top ? "下载" : label;
      const mark = a.querySelector("[data-dl-icon]");
      if (mark) mark.innerHTML = mine ? osIcon(mine.os) : icon.download;
    }

    // Under the hero button: one line saying what this download is. The other installers are a link away.
    const fact = (text: string, cls = "") => Object.assign(document.createElement("span"), { textContent: text, className: cls });
    $("#cta-meta").replaceChildren(
      fact(`v${release.version}`),
      ...(mine ? [fact(formatSize(mine.bytes), "wide"), fact(mine.requires)] : [fact([...new Set(release.assets.map((a) => a.os))].join(" / "))]),
    );
  };

  document.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (a && shown?.assets.some((asset) => asset.url === a.href)) toast("下载已开始");
  });

  // Show what is already known straight away, then swap in GitHub's answer if it differs.
  detectPlatform().then(async (platform) => {
    paint(knownRelease(), platform);
    const latest = await loadRelease();
    if (latest && JSON.stringify(latest) !== JSON.stringify(shown)) paint(latest, platform);
  });
}
