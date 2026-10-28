if (new URLSearchParams(window.location.search).get("host") === "installer") { document.documentElement.setAttribute("data-host", "installer"); }

(function () {
  "use strict";
  var stage = document.getElementById("stage");
  var hostMode = document.documentElement.getAttribute("data-host") === "installer";
  var installerShell = window.installerShell;
  var liveState = null;
  function isLive() { return !!(installerShell && installerShell.isLive); }
  var DURATION = 8600, step = -1, prevStep = null, simTimers = [], raf = 0, pollTimer = 0;
  var PRODUCT_DIR = "OMP Studio";
  var CONTAINER_NAMES = {
    "program files": 1,
    "program files (x86)": 1,
    desktop: 1,
    documents: 1,
    downloads: 1,
    windows: 1,
    users: 1,
    programdata: 1,
    public: 1
  };
  var PACKAGE_VERSION = "0.1.14";
  var RUNTIME_VERSION = "18.12.6-studio.9";
  var ARCH = "x64";
  var DEFAULT_PATH = "C:\\Users\\Demo\\AppData\\Local\\Programs\\OMP Studio";
  var scenario = "fresh";
  var repairAccepted = false;
  var occupyKind = null;
  var installPath = "";
  var setupError = false;
  var dialogFocus = null;

  /* ---------- 主题 ---------- */
  var saved = "system";
  try { saved = localStorage.getItem("omp-setup-theme") || "system"; } catch (e) {}
  setTheme(saved);
  function setTheme(t) {
    stage.setAttribute("data-theme", t);
    try { localStorage.setItem("omp-setup-theme", t); } catch (e) {}
    Array.prototype.forEach.call(document.querySelectorAll(".theme-switch button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-t") === t);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll(".theme-switch button"), function (b) {
    b.addEventListener("click", function () { setTheme(b.getAttribute("data-t")); });
  });
  document.getElementById("themeBtn").addEventListener("click", function () {
    var themes = ["system", "light", "dark"];
    setTheme(themes[(themes.indexOf(stage.getAttribute("data-theme")) + 1) % themes.length]);
  });

  var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  function motionText() { document.getElementById("motionText").textContent = mq.matches ? "已按系统设置减弱" : "标准"; }
  mq.addEventListener ? mq.addEventListener("change", motionText) : mq.addListener(motionText);
  motionText();

  /* ---------- 缩放适配 ---------- */
  function fit() {
    if (hostMode) {
      document.getElementById("scaleWrap").style.transform = "none";
      return;
    }
    var s = Math.min(1, (innerWidth - 36) / 760, (innerHeight - 160) / 520);
    document.getElementById("scaleWrap").style.transform = "scale(" + s + ")";
  }
  addEventListener("resize", fit); fit();

  /* ---------- 安装情景 / 路径策略 ---------- */
  var SCENARIOS = {
    fresh: { occupancy: null, existingVersion: null, existingPath: null, running: false },
    upgrade: { occupancy: "upgrade", existingVersion: "0.1.13", existingPath: DEFAULT_PATH, running: false },
    same: { occupancy: "same", existingVersion: PACKAGE_VERSION, existingPath: DEFAULT_PATH, running: false },
    downgrade: { occupancy: "downgrade", existingVersion: "0.1.15", existingPath: DEFAULT_PATH, running: false },
    running: { occupancy: "upgrade", existingVersion: "0.1.13", existingPath: DEFAULT_PATH, running: true },
    uninstall: { occupancy: "uninstall", existingVersion: PACKAGE_VERSION, existingPath: DEFAULT_PATH, running: false }
  };

  function normalizePath(p) {
    return String(p || "").trim().replace(/\//g, "\\").replace(/\\+$/g, "");
  }
  function lastSegment(p) {
    var n = normalizePath(p);
    var i = n.lastIndexOf("\\");
    return i < 0 ? n : n.slice(i + 1);
  }
  function looksLikeProductDir(p) {
    return lastSegment(p).toLowerCase() === PRODUCT_DIR.toLowerCase();
  }
  function isContainerName(name) {
    return !!CONTAINER_NAMES[String(name || "").toLowerCase()];
  }
  function parentPath(p) {
    var n = normalizePath(p);
    var i = n.lastIndexOf("\\");
    if (i <= 0) return "";
    if (i === 2 && n.charAt(1) === ":") return n.slice(0, 3);
    return n.slice(0, i);
  }
  function collapseProductSuffix(p) {
    var current = normalizePath(p);
    while (looksLikeProductDir(current) && looksLikeProductDir(parentPath(current))) {
      current = normalizePath(parentPath(current));
    }
    return current;
  }
  function fixtureNode(path) {
    var n = normalizePath(path).toLowerCase();
    var found = null;
    Array.prototype.forEach.call(NODES, function (node) {
      if (node.path && normalizePath(node.path).toLowerCase() === n) found = node;
    });
    return found;
  }
  function specialFolders() {
    return (liveState && liveState.specialFolders) || [];
  }
  function isSpecialFolder(path) {
    var n = normalizePath(path).toLowerCase();
    var folders = specialFolders();
    for (var i = 0; i < folders.length; i++) {
      if (normalizePath(folders[i]).toLowerCase() === n) return true;
    }
    return false;
  }
  function resolveInstallDir(selected, stat) {
    var path = normalizePath(selected);
    if (!path) return "";
    path = collapseProductSuffix(path);
    if (looksLikeProductDir(path)) return path;
    if (isLockedDir()) return path;
    if (stat && stat.hasProductFiles) return path;
    if (/^[A-Za-z]:\\?$/i.test(path)) return path.replace(/\\+$/g, "") + "\\" + PRODUCT_DIR;
    if (isSpecialFolder(path) || isContainerName(lastSegment(path))) return path + "\\" + PRODUCT_DIR;
    if (stat && stat.exists === true && stat.empty === false) return path + "\\" + PRODUCT_DIR;
    if (stat && (stat.exists === false || stat.empty === true)) return path;
    var node = fixtureNode(path);
    if (node && node.empty) return path;
    if (node && node.empty === false) return path + "\\" + PRODUCT_DIR;
    return path;
  }
  function describeResolve(selected, stat) {
    var raw = normalizePath(selected);
    var resolved = resolveInstallDir(raw, stat);
    if (!raw) return { kind: "empty", text: "请选择安装位置。" };
    if (raw.toLowerCase() === resolved.toLowerCase()) {
      if (looksLikeProductDir(raw)) {
        return { kind: "as-is", text: "将安装到所选文件夹（已是 OMP Studio 目录）。" };
      }
      return { kind: "as-is", text: "将安装到所选文件夹（空目录或不存在的路径，不再套一层）。" };
    }
    return { kind: "append", text: "所选位置是系统目录或非空文件夹，将新建  " };
  }

  function current() {
    if (liveState) {
      return {
        occupancy: liveState.occupancy || null,
        existingVersion: liveState.existingVersion || null,
        existingPath: liveState.existingPath || liveState.defaultPath || DEFAULT_PATH,
        running: !!liveState.running
      };
    }
    return SCENARIOS[scenario] || SCENARIOS.fresh;
  }
  function isUninstall() { return current().occupancy === "uninstall"; }
  function isLockedDir() { return !!current().occupancy && !isUninstall(); }

  function liveStat(path) {
    if (!isLive() || !installerShell.statDir) return null;
    try { return installerShell.statDir(path); }
    catch (e) { return null; }
  }
  function refreshPathHint() {
    var input = document.getElementById("pathInput");
    var hint = document.getElementById("pathHint");
    var text = document.getElementById("pathHintText");
    var extra = hint.querySelector("span.mono");
    if (extra) extra.parentNode.removeChild(extra);
    if (isLockedDir()) {
      hint.className = "path-hint";
      text.textContent = "已安装版本将原地更新，安装位置沿用上次目录。";
      return;
    }
    var stat = liveStat(input.value);
    var info = describeResolve(input.value, stat);
    document.getElementById("installBtn").disabled = !normalizePath(input.value);
    text.textContent = info.text;
    hint.className = "path-hint" + (info.kind === "append" ? " append" : info.kind === "empty" ? " warn" : "");
    if (info.kind === "append") {
      var code = document.createElement("span");
      code.className = "mono";
      code.textContent = resolveInstallDir(input.value, stat);
      hint.appendChild(code);
    }
    if (stat) updateSpaceMeter(stat);
  }

  function applyScenario(id) {
    if (!SCENARIOS[id]) id = "fresh";
    scenario = id;
    repairAccepted = false;
    occupyKind = null;
    var sc = current();
    Array.prototype.forEach.call(document.querySelectorAll(".scenario-switch button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-sc") === id);
    });

    var locked = isLockedDir();
    var pathInput = document.getElementById("pathInput");
    var browseBtn = document.getElementById("browseBtn");
    pathInput.value = sc.existingPath || DEFAULT_PATH;
    pathInput.readOnly = locked;
    browseBtn.disabled = locked;

    document.getElementById("optStartMenu").checked = true;
    document.getElementById("optStartMenu").disabled = true;
    document.getElementById("startMenuRow").classList.add("is-locked");
    document.getElementById("optDesktop").checked = liveState ? liveState.desktopShortcut : id === "fresh";
    document.getElementById("tbAction").textContent = isUninstall() ? "OMP Studio 卸载" : "OMP Studio 安装";
    document.title = (isUninstall() ? "OMP Studio 卸载向导" : "OMP Studio 安装向导") + (hostMode && !(installerShell && installerShell.isPreview) ? "" : " · 演示");
    document.getElementById("runCheckRow").hidden = isUninstall();
    document.getElementById("finishLink").hidden = isUninstall();
    document.getElementById("finishActions").hidden = isUninstall();
    document.getElementById("f1Title").textContent = "内置 OMP 运行时";
    document.getElementById("f1Desc").textContent = "首次启动自动校验，无需额外部署。";
    document.getElementById("f2Title").textContent = "原生 PTY 终端";
    document.getElementById("f2Desc").textContent = "直接使用当前电脑的 Shell。";
    document.getElementById("f3Title").textContent = "Agent 与 MCP 扩展";
    document.getElementById("f3Desc").textContent = "在工作台中配置模型、Agent 与 MCP。";
    var runtimeLabel = document.createElement("b");
    runtimeLabel.textContent = RUNTIME_VERSION;
    document.getElementById("welcomeRuntime").replaceChildren("内置 OMP Runtime", document.createElement("br"), runtimeLabel);
    document.getElementById("finishRuntime").textContent = "首次启动将校验并启用 Runtime";
    document.getElementById("progressTitle").textContent = "正在安装 OMP Studio";
    document.getElementById("progressLede").textContent = "请稍候，正在将 OMP Studio 安装到你的计算机。";
    document.getElementById("sumK0").textContent = "安装位置";
    document.getElementById("sumK1").textContent = "产品版本";
    document.getElementById("sumV1").textContent = "OMP Studio " + PACKAGE_VERSION + " (" + ARCH + ")";
    document.getElementById("sumK2").textContent = "内置运行时";
    document.getElementById("sumV2").textContent = "OMP Runtime " + RUNTIME_VERSION;
    var welcomeChip = document.getElementById("welcomeChip");
    var finishChip = document.getElementById("finishChip");
    if (welcomeChip) welcomeChip.textContent = "v" + PACKAGE_VERSION + " · " + ARCH;
    if (finishChip) finishChip.textContent = "v" + PACKAGE_VERSION + " · " + ARCH;
    document.getElementById("tbVersion").textContent = "v" + PACKAGE_VERSION;
    document.getElementById("finishLink").href = "https://github.com/the-snowpear/omp-studio/releases/tag/v" + PACKAGE_VERSION;

    var notice = document.getElementById("occupancyNotice");
    var occText = document.getElementById("occupancyText");
    var noticeIcon = notice.querySelector("use");
    if (sc.occupancy === "upgrade") {
      notice.hidden = false;
      notice.className = "notice info";
      if (noticeIcon) noticeIcon.setAttribute("href", "#i-info");
      occText.textContent = "检测到 OMP Studio " + sc.existingVersion + "。将原地更新到 " + PACKAGE_VERSION + "。程序文件将更新，会话与设置保留。";
    } else if (sc.occupancy === "same") {
      notice.hidden = false;
      notice.className = "notice info";
      if (noticeIcon) noticeIcon.setAttribute("href", "#i-info");
      occText.textContent = "已安装相同版本 " + PACKAGE_VERSION + "。继续将修复/覆盖程序文件；头像与会话仍在 AppData。";
    } else if (sc.occupancy === "downgrade") {
      notice.hidden = false;
      notice.className = "notice warn";
      if (noticeIcon) noticeIcon.setAttribute("href", "#i-warn");
      occText.textContent = "已安装更高版本 " + sc.existingVersion + "。继续会降级到 " + PACKAGE_VERSION + "，可能不兼容现有数据。";
    } else {
      notice.hidden = true;
    }

    var welcomeTitle = document.getElementById("welcomeTitle");
    var welcomeLede = document.getElementById("welcomeLede");
    var welcomeNext = document.getElementById("welcomeNext");
    var welcomeFoot = document.getElementById("welcomeFoot");
    var installBtn = document.getElementById("installBtn");
    var dirTitle = document.getElementById("dirTitle");
    var dirLede = document.getElementById("dirLede");
    var dirFoot = document.getElementById("dirFootText");
    var finishTitle = document.getElementById("finishTitle");
    var finishLede = document.getElementById("finishLede");

    if (sc.occupancy === "uninstall") {
      welcomeTitle.textContent = "卸载 OMP Studio";
      welcomeLede.textContent = "将删除本机程序文件、开始菜单与桌面快捷方式，以及头像目录。会话与日志会留在 AppData。";
      welcomeNext.textContent = "卸载";
      installBtn.textContent = "卸载";
      document.getElementById("f1Title").textContent = "删除程序文件";
      document.getElementById("f1Desc").textContent = sc.existingPath + " 整目录删除（含旧版 userdata）。";
      document.getElementById("f2Title").textContent = "删除快捷方式";
      document.getElementById("f2Desc").textContent = "开始菜单与桌面的 OMP Studio 快捷方式一并移除。";
      document.getElementById("f3Title").textContent = "删除头像，保留会话";
      document.getElementById("f3Desc").textContent = "只清 %APPDATA%\\omp-studio\\profile；日志与会话不动。安装目录里的 omp.exe 随程序一起删除。";
      document.getElementById("welcomeRuntime").innerHTML = "&gt;_ 将删除本机安装";
      document.getElementById("finishRuntime").innerHTML = "&gt;_ 会话与日志仍在 AppData";
      document.getElementById("progressTitle").textContent = "正在卸载 OMP Studio";
      document.getElementById("progressLede").textContent = "请稍候，正在从这台计算机移除 OMP Studio。";
      document.getElementById("sumK0").textContent = "已删除";
      document.getElementById("sumK1").textContent = "已删除";
      document.getElementById("sumV1").textContent = "头像 %APPDATA%\\omp-studio\\profile";
      document.getElementById("sumK2").textContent = "已保留";
      document.getElementById("sumV2").textContent = "会话 / 日志";
      finishTitle.textContent = "卸载完成";
      finishLede.textContent = "OMP Studio 已从本机移除。会话与日志仍在 AppData，再次安装即可继续使用。";
    } else if (sc.occupancy === "upgrade") {
      welcomeTitle.textContent = "更新 OMP Studio";
      welcomeLede.textContent = "检测到本机已安装 " + sc.existingVersion + "。本向导将原地更新到 " + PACKAGE_VERSION + "。会话与设置保留。";
      welcomeNext.innerHTML = '下一步 <svg viewBox="0 0 24 24"><use href="#i-arrow-r"/></svg>';
      installBtn.textContent = "更新";
      dirTitle.textContent = "确认安装位置";
      dirLede.textContent = "更新将写入上次的安装目录，不会另建文件夹。";
      dirFoot.textContent = "快捷方式沿用现有选择，也可在下方调整。";
      finishTitle.textContent = "更新完成";
      finishLede.textContent = "OMP Studio 已更新到 " + PACKAGE_VERSION + "，首次启动将校验并启用 Runtime。";
    } else if (sc.occupancy === "same") {
      welcomeTitle.textContent = "已安装此版本";
      welcomeLede.textContent = "本机已安装 OMP Studio " + PACKAGE_VERSION + "。可以选择修复当前安装，或退出向导。";
      welcomeNext.textContent = "修复";
      installBtn.textContent = "修复";
      dirTitle.textContent = "确认安装位置";
      dirLede.textContent = "修复会覆盖程序文件，安装位置与用户数据保持不变。";
      dirFoot.textContent = "修复不会删除 AppData 中的会话。安装目录里的运行时随程序文件覆盖。";
      finishTitle.textContent = "修复完成";
      finishLede.textContent = "OMP Studio " + PACKAGE_VERSION + " 已重新写入，用户数据未改动。";
    } else if (sc.occupancy === "downgrade") {
      welcomeTitle.textContent = "将安装较旧版本";
      welcomeLede.textContent = "本机已安装 " + sc.existingVersion + "，当前安装包是 " + PACKAGE_VERSION + "。继续会降级；用户数据会保留，但不建议在日常使用中降级。";
      welcomeNext.innerHTML = '下一步 <svg viewBox="0 0 24 24"><use href="#i-arrow-r"/></svg>';
      installBtn.textContent = "降级";
      dirTitle.textContent = "确认安装位置";
      dirLede.textContent = "降级写入上次的安装目录。开始安装前请从托盘退出应用。";
      dirFoot.textContent = "降级可能让新版本写入的配置无法被旧版本读取。";
      finishTitle.textContent = "已降级安装";
      finishLede.textContent = "OMP Studio " + PACKAGE_VERSION + " 已写入原目录。若工作台异常，请再装回更新的版本。";
    } else {
      welcomeTitle.textContent = "安装 OMP Studio";
      welcomeLede.textContent = "安装桌面工作台与内置 Runtime，仅对当前 Windows 账户生效。";
      welcomeNext.innerHTML = '下一步 <svg viewBox="0 0 24 24"><use href="#i-arrow-r"/></svg>';
      installBtn.textContent = "安装";
      dirTitle.textContent = "选择安装位置";
      dirLede.textContent = "选择要安装 OMP Studio 的文件夹。系统目录或非空文件夹会自动新建 OMP Studio 子目录；空目录或已是产品目录则原样使用。";
      dirFoot.textContent = "仅为当前用户安装，请选择当前用户可写的目录。旧全机版本迁移时会请求一次管理员授权。";
      finishTitle.textContent = "安装完成";
      finishLede.textContent = "OMP Studio 已成功安装，首次启动将校验并启用 Runtime。";
    }
    if (sc.occupancy === "uninstall") {
      welcomeFoot.textContent = "单击「卸载」将先确认删除范围。";
    } else if (sc.running) {
      welcomeLede.textContent = "检测到 OMP Studio 正在运行。更新前需要先结束该进程，未保存的对话请先在应用内处理。";
      welcomeFoot.textContent = "安装前会先确认结束占用进程。";
    } else if (sc.occupancy === "same") {
      welcomeFoot.textContent = "单击「修复」继续，或取消退出。";
    } else if (sc.occupancy === "downgrade") {
      welcomeFoot.textContent = "不建议降级。若仍要继续，单击「下一步」。";
    } else if (sc.occupancy === "upgrade") {
      welcomeFoot.textContent = "单击「下一步」确认更新位置。";
    } else {
      welcomeFoot.textContent = "单击「下一步」继续。";
    }
    refreshPathHint();
    renderHints();
  }

  /* ---------- 步骤机 ---------- */
  var steps = Array.prototype.slice.call(document.querySelectorAll(".step"));
  function hintForStep() {
    if (setupError) return "安装未完成 · 关闭向导后可重新运行安装包";
    if (isUninstall()) {
      if (step === 0) return "第 1 步，共 3 步 · 将卸载本机安装";
      if (step === 2) return "第 2 步，共 3 步 · 正在删除程序文件，请勿关闭窗口";
      return "卸载已完成 · 会话与日志仍在 AppData";
    }
    if (step === 0) {
      var sc = current();
      if (sc.occupancy === "upgrade") return "第 1 步，共 4 步 · 将更新已安装的 " + sc.existingVersion;
      if (sc.occupancy === "same") return "第 1 步，共 4 步 · 已安装相同版本，可修复";
      if (sc.occupancy === "downgrade") return "第 1 步，共 4 步 · 将从 " + sc.existingVersion + " 降级";
      return "第 1 步，共 4 步 · 当前用户安装";
    }
    if (step === 1) return isLockedDir() ? "第 2 步，共 4 步 · 安装位置已锁定为现有目录" : "第 2 步，共 4 步 · 预计占用 " + spaceRequiredLabel();
    if (step === 2) return "第 3 步，共 4 步 · 正在写入文件，请勿关闭窗口";
    return current().occupancy === "upgrade" ? "更新已完成 · 感谢使用 OMP Studio" : "安装已完成 · 感谢使用 OMP Studio";
  }
  function renderHints() {
    if (step < 0) return;
    var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-info");
    icon.appendChild(use);
    document.getElementById("footHint").replaceChildren(icon, document.createTextNode(hintForStep()));
    Array.prototype.forEach.call(document.querySelectorAll(".f-group"), function (g) {
      g.classList.toggle("on", +g.getAttribute("data-for") === step);
    });
    document.getElementById("tbClose").disabled = step === 2 && isLive() && !setupError;
    document.getElementById("errorClose").hidden = !setupError;
    document.querySelector(".install-wait").hidden = setupError;
  }
  function go(target, dirOverride) {
    if (target === step) return;
    var dir = dirOverride !== undefined ? dirOverride : (target > step ? 1 : -1);
    var cur = step; step = target; prevStep = cur;
    steps.forEach(function (el) {
      var i = +el.getAttribute("data-step");
      el.className = "step" +
        (i === step ? " enter" + (dir < 0 ? " back" : "") : i === prevStep ? " exit" + (dir < 0 ? " back" : "") : "");
      el.setAttribute("aria-hidden", i === step ? "false" : "true");
      el.inert = i !== step;
    });
    renderHints();
    setTimeout(function () { prevStep = null; steps.forEach(function (el) {
      var i = +el.getAttribute("data-step");
      if (i !== step) el.className = "step";
    }); }, 420);
    if (step === 1) {
      refreshPathHint();
      requestAnimationFrame(function () { setTimeout(armMeter, 90); });
    }
    if (step === 2) {
      if (isLive()) startLiveInstall();
      else startSim();
    }
    if (step === 3) {
      document.getElementById("sumPath").textContent = isUninstall()
        ? "程序文件与快捷方式"
        : installPath;
    }
    var heading = steps[step].querySelector("h1");
    heading.tabIndex = -1;
    heading.focus();
  }

  /* ---------- 磁盘指示 ---------- */
  function spaceRequiredMB() {
    var n = liveState && liveState.spaceRequiredMB;
    return n > 0 ? n : 328;
  }
  function spaceRequiredLabel() {
    return spaceRequiredMB() + " MB";
  }
  function formatBytes(n) {
    n = Number(n) || 0;
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
    if (n >= 1024 * 1024) return Math.round(n / (1024 * 1024)) + " MB";
    return Math.round(n / 1024) + " KB";
  }
  function updateSpaceMeter(stat) {
    document.getElementById("spaceReq").textContent = spaceRequiredLabel();
    if (!stat || !stat.totalBytes) {
      document.getElementById("spaceUsed").textContent = "—";
      document.getElementById("spaceDrive").textContent = "无法读取目标磁盘空间";
      document.getElementById("meterUsed").style.width = "0%";
      document.getElementById("meterReq").style.width = "0%";
      return;
    }
    var used = Math.max(0, stat.totalBytes - stat.freeBytes);
    var usedPct = Math.min(99, (used / stat.totalBytes) * 100);
    var reqBytes = spaceRequiredMB() * 1024 * 1024;
    var reqPct = Math.max(0.8, (reqBytes / stat.totalBytes) * 100);
    document.getElementById("spaceReq").textContent = spaceRequiredLabel();
    document.getElementById("spaceUsed").textContent = formatBytes(used);
    document.getElementById("spaceDrive").textContent =
      "磁盘 " + (stat.drive || "") + " · 可用 " + formatBytes(stat.freeBytes) + " / 共 " + formatBytes(stat.totalBytes);
    var u = document.getElementById("meterUsed"), r = document.getElementById("meterReq");
    u.style.width = "0%"; r.style.width = "0%"; r.style.left = "0%";
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      u.style.width = usedPct + "%"; r.style.left = usedPct + "%"; r.style.width = reqPct + "%";
    }); });
  }
  function armMeter() {
    if (isLive()) {
      updateSpaceMeter(liveStat(document.getElementById("pathInput").value) || liveStat(DEFAULT_PATH));
      return;
    }
    var used = 76.4, req = Math.max(1.7, 328 / (237 * 1024) * 100);
    var u = document.getElementById("meterUsed"), r = document.getElementById("meterReq");
    u.style.width = "0%"; r.style.width = "0%"; r.style.left = "0%";
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      u.style.width = used + "%"; r.style.left = used + "%"; r.style.width = req + "%";
    }); });
  }

  /* ---------- 安装模拟 ---------- */
  var PCT_KEYS = [[0,0],[0.07,7],[0.13,12],[0.28,34],[0.52,68],[0.66,80],[0.74,86],[0.8,91],[0.87,95],[0.95,98],[1,100]];
  function buildPlan() {
    if (isUninstall()) return [
      { t: .05, time: '10:24:01', msg: '准备移除程序文件与快捷方式', phase: '正在准备卸载…', kind: 'ok' },
      { t: .35, time: '10:24:03', msg: '移除安装目录与快捷方式', phase: '正在卸载…', kind: 'ok' },
      { t: .7, time: '10:24:05', msg: '移除头像，保留会话与日志', kind: 'ok' },
      { t: 1, time: '10:24:08', msg: '卸载完成', kind: 'done' }
    ];
    var path = resolveInstallDir(document.getElementById('pathInput').value);
    return [
      { t: .05, time: '10:24:01', msg: '准备安装到 ' + path, phase: '正在准备安装…', kind: 'ok' },
      { t: .25, time: '10:24:03', msg: '写入桌面程序与界面资源', phase: '正在写入程序文件…', file: 'resources/app.asar', kind: 'ok' },
      { t: .6, time: '10:24:05', msg: '写入 OMP Runtime ' + RUNTIME_VERSION, file: 'runtime/versions/' + RUNTIME_VERSION + '/omp.exe', kind: 'hl' },
      { t: .85, time: '10:24:07', msg: '应用快捷方式选择并写入卸载信息', phase: '正在完成安装…', file: '', kind: 'ok' },
      { t: 1, time: '10:24:08', msg: '安装完成', kind: 'done' }
    ];
  }
  function easeInOut(u) { return u < .5 ? 4*u*u*u : 1 - Math.pow(-2*u+2, 3)/2; }
  function smoothPct(t) {
    for (var i = 1; i < PCT_KEYS.length; i++) if (t <= PCT_KEYS[i][0]) {
      var a = PCT_KEYS[i-1], b = PCT_KEYS[i];
      return a[1] + (b[1]-a[1]) * easeInOut((t-a[0])/(b[0]-a[0]));
    }
    return 100;
  }
  function quantPct(t) { var p = 0; PCT_KEYS.forEach(function (k) { if (t >= k[0]) p = k[1]; }); return p; }

  function startLiveInstall() {
    stopSim();
    setupError = false;
    var logview = document.getElementById("logview"); logview.innerHTML = "";
    document.getElementById("phase").textContent = "正在准备…";
    document.getElementById("fileRow").textContent = installPath;
    setBar(null);
    function addLine(kind, msg, phase, file) {
      var div = document.createElement("div");
      div.className = "line " + kind;
      var now = new Date();
      var stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map(function (n) {
        return (n < 10 ? "0" : "") + n;
      }).join(":");
      div.innerHTML = '<span class="t">[' + stamp + ']</span><span class="m"></span>';
      div.querySelector(".m").textContent = msg;
      logview.appendChild(div);
      logview.scrollTop = logview.scrollHeight;
      if (phase) document.getElementById("phase").textContent = phase;
      if (file !== undefined) document.getElementById("fileRow").textContent = file ? "正在处理: " + file : "\u00a0";
    }
    addLine("ok", "安装位置：" + installPath, "正在准备安装…");
    var finished = false;
    var lastPhase = "";
    var phases = { preparing: "正在准备安装…", files: "正在写入程序文件…", migrating: "正在迁移旧版安装…", finishing: "正在创建快捷方式并完成安装…" };
    function complete() {
      if (finished) return;
      finished = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
      addLine("done", "安装完成", "安装完成", "");
      setBar(100);
      simTimers.push(setTimeout(function () { go(3); }, 700));
    }
    pollTimer = setInterval(function () {
      try {
        var st = installerShell.poll();
        if (st.error) {
          finished = true;
          stopSim();
          setupError = true;
          document.getElementById("progressTitle").textContent = "安装未完成";
          document.getElementById("progressLede").textContent = "请关闭向导，处理问题后重新运行安装包。";
          document.getElementById("phase").textContent = "安装失败";
          document.getElementById("fileRow").textContent = st.error;
          addLine("error", st.error);
          var progress = document.querySelector(".progress");
          progress.classList.remove("indeterminate");
          progress.classList.add("failed");
          progress.removeAttribute("aria-valuenow");
          document.getElementById("pct").textContent = "未完成";
          renderHints();
          document.getElementById("errorClose").focus();
          return;
        }
        if (st.done) {
          if (st.path) installPath = st.path;
          complete();
          return;
        }
        var phase = phases[st.phase] || phases.preparing;
        if (phase !== lastPhase) { lastPhase = phase; addLine("ok", phase, phase); }
        setBar(typeof st.percent === "number" ? st.percent : null);
      } catch (e) {
        document.getElementById("phase").textContent = "等待安装程序响应…";
        setBar(null);
      }
    }, 300);
  }
  function startSim() {
    stopSim();
    var logview = document.getElementById("logview"); logview.innerHTML = "";
    document.getElementById("phase").textContent = "正在准备…";
    document.getElementById("fileRow").innerHTML = "&nbsp;";
    setBar(0);
    var plan = buildPlan();
    var t0 = performance.now();
    plan.forEach(function (item) {
      simTimers.push(setTimeout(function () {
        var div = document.createElement("div");
        div.className = "line " + item.kind;
        div.innerHTML = '<span class="t">[' + item.time + ']</span><span class="m"></span>';
        div.querySelector(".m").textContent = item.msg;
        logview.appendChild(div);
        logview.scrollTop = logview.scrollHeight;
        if (item.phase) document.getElementById("phase").textContent = item.phase;
        if (item.file !== undefined) document.getElementById("fileRow").textContent = item.file ? "正在处理: " + item.file : " ";
      }, item.t * DURATION));
    });
    var tick = function (now) {
      var t = Math.min(1, (now - t0) / DURATION);
      setBar(mq.matches ? quantPct(t) : smoothPct(t));
      if (t < 1) raf = requestAnimationFrame(tick);
      else {
        document.getElementById("phase").textContent = isUninstall() ? "卸载完成" : "安装完成";
        simTimers.push(setTimeout(function () { go(3); }, 1000));
      }
    };
    raf = requestAnimationFrame(tick);
  }
  function setBar(p) {
    var progress = document.querySelector(".progress");
    progress.classList.toggle("indeterminate", p === null);
    progress.setAttribute("aria-valuetext", document.getElementById("phase").textContent);
    if (p === null) {
      progress.removeAttribute("aria-valuenow");
      document.getElementById("bar").style.width = "30%";
      document.getElementById("pct").textContent = "处理中";
      return;
    }
    progress.setAttribute("aria-valuenow", Math.round(p));
    document.getElementById("bar").style.width = p + "%";
    document.getElementById("pct").textContent = Math.round(p) + " %";
  }
  function stopSim() {
    cancelAnimationFrame(raf);
    if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
    simTimers.forEach(clearTimeout); simTimers = [];
  }

  /* ---------- 取消 / 浏览 / 占用确认 / 完成 ---------- */
  var confirmOv = document.getElementById("confirmOv");
  var browseOv = document.getElementById("browseOv");
  var occupyOv = document.getElementById("occupyOv");
  function openDialog(overlay, focusId) {
    dialogFocus = document.activeElement;
    steps.forEach(function (el) { el.inert = true; });
    document.querySelector(".titlebar").inert = true;
    document.querySelector(".footer").inert = true;
    overlay.hidden = false;
    document.getElementById(focusId).focus();
  }
  function openConfirm() {
    if (step === 2 && isLive() && !setupError) return;
    var uninstall = isUninstall();
    document.getElementById("confirmTitle").textContent = uninstall ? "取消卸载" : "取消安装";
    document.getElementById("confirmQuit").textContent = uninstall ? "退出卸载" : "退出安装";
    document.getElementById("confirmStay").textContent = uninstall ? "继续卸载" : "继续安装";
    document.getElementById("confirmMsg").textContent = uninstall
      ? "确定要退出 OMP Studio 卸载向导吗？卸载尚未完成。"
      : "确定要退出 OMP Studio 安装向导吗？";
    openDialog(confirmOv, "confirmStay");
  }
  function closeDialogs() {
    confirmOv.hidden = true; browseOv.hidden = true; occupyOv.hidden = true; occupyKind = null;
    steps.forEach(function (el, i) { el.inert = i !== step; });
    document.querySelector(".titlebar").inert = false;
    document.querySelector(".footer").inert = false;
    if (dialogFocus) dialogFocus.focus();
  }
  function closeInstallerShell() {
    if (installerShell && typeof installerShell.close === "function") {
      installerShell.close();
      return;
    }
    go(0);
  }
  function openOccupy(kind) {
    occupyKind = kind;
    var sc = current();
    var title = document.getElementById("occupyTitle");
    var msg = document.getElementById("occupyMsg");
    var ok = document.getElementById("occupyOk");
    var alt = document.getElementById("occupyAlt");
    if (kind === "same") {
      title.textContent = "已安装相同版本";
      msg.textContent = "本机已安装 OMP Studio " + PACKAGE_VERSION + "。修复会覆盖程序文件；会话与设置保留。";
      ok.textContent = "修复安装";
      alt.textContent = "退出";
    } else if (kind === "downgrade") {
      title.textContent = "确认降级？";
      msg.textContent = "已安装 " + sc.existingVersion + "，继续将覆盖为 " + PACKAGE_VERSION + "。用户数据会保留，但新版本写入的配置可能无法被旧版本读取。";
      ok.textContent = "仍然降级";
      alt.textContent = "取消";
    } else if (kind === "uninstall") {
      title.textContent = "确认卸载 OMP Studio？";
      msg.textContent = "将删除程序文件（含安装目录里的 omp.exe）、开始菜单与桌面快捷方式，以及 %APPDATA%\\omp-studio\\profile（头像）。会话与日志会留在 AppData。";
      ok.textContent = "卸载";
      alt.textContent = "取消";
    } else {
      title.textContent = "OMP Studio 正在运行";
      msg.textContent = "请先保存任务，在系统托盘中右键 OMP Studio，选择「退出」。关闭主窗口会隐藏到托盘，退出后可直接重试。";
      ok.textContent = "已退出，重试";
      alt.textContent = "取消";
    }
    openDialog(occupyOv, kind === "downgrade" ? "occupyAlt" : "occupyOk");
  }
  function beginInstall() {
    var sc = current();
    if (isUninstall()) {
      if (sc.running && !repairAccepted) { openOccupy("running"); return; }
      go(2);
      return;
    }
    var input = document.getElementById("pathInput");
    if (!isLockedDir()) input.value = resolveInstallDir(input.value, liveStat(input.value));
    if (!normalizePath(input.value)) return;
    if (sc.occupancy === "same" && !repairAccepted) { openOccupy("same"); return; }
    if (sc.occupancy === "downgrade" && !repairAccepted) { openOccupy("downgrade"); return; }
    if (!isLive() && sc.running) { openOccupy("running"); return; }
    installPath = input.value;
    if (isLive()) {
      var result = installerShell.startInstall({ path: installPath, desktopShortcut: document.getElementById("optDesktop").checked });
      if (!result.ok) {
        if (result.reason === "running") openOccupy("running");
        else {
          document.getElementById("dirError").textContent = result.message;
          document.getElementById("dirError").hidden = false;
          input.focus();
        }
        return;
      }
      if (result.path) installPath = result.path;
    }
    document.getElementById("dirError").hidden = true;
    go(2);
  }
  function onWelcomeNext() {
    if (document.getElementById("welcomeNext").disabled) return;
    var sc = current();
    if (isUninstall()) {
      openOccupy("uninstall");
      return;
    }
    if (sc.occupancy === "same" && !repairAccepted) { openOccupy("same"); return; }
    go(1);
  }
  document.querySelectorAll(".js-cancel").forEach(function (b) { b.addEventListener("click", openConfirm); });
  document.getElementById("tbClose").addEventListener("click", function () {
    if (step < 3) openConfirm();
    else document.getElementById("finishBtn").click();
  });
  window.addEventListener("installer-close-request", function () { document.getElementById("tbClose").click(); });
  document.getElementById("errorClose").addEventListener("click", closeInstallerShell);
  document.getElementById("finishLink").addEventListener("click", function (event) {
    if (installerShell && installerShell.openReleaseNotes) { event.preventDefault(); installerShell.openReleaseNotes(); }
  });
  var minimizeBtn = document.getElementById("minimizeBtn");
  if (minimizeBtn) minimizeBtn.addEventListener("click", function () {
    if (installerShell && typeof installerShell.minimize === "function") installerShell.minimize();
  });
  var titlebar = document.querySelector(".titlebar");
  if (titlebar) {
    titlebar.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest(".tb-btn")) return;
      if (installerShell && typeof installerShell.drag === "function") installerShell.drag();
    });
  }
  document.getElementById("confirmStay").addEventListener("click", closeDialogs);
  confirmOv.addEventListener("mousedown", function (e) { if (e.target === confirmOv) closeDialogs(); });
  occupyOv.addEventListener("mousedown", function (e) { if (e.target === occupyOv) closeDialogs(); });
  document.getElementById("confirmQuit").addEventListener("click", function () {
    closeDialogs(); stopSim(); closeInstallerShell();
  });
  document.getElementById("occupyAlt").addEventListener("click", function () {
    var kind = occupyKind;
    closeDialogs();
    if (kind === "same") { stopSim(); closeInstallerShell(); }
  });
  document.getElementById("occupyOk").addEventListener("click", function () {
    var kind = occupyKind;
    var sc = current();
    closeDialogs();
    if (kind === "uninstall") {
      if (sc.running) { openOccupy("running"); return; }
      go(2);
      return;
    }
    if (kind === "running" && !isLive()) SCENARIOS[scenario].running = false;
    if (kind === "same" || kind === "downgrade") repairAccepted = true;
    if (kind === "same" && step === 0) go(1);
    else beginInstall();
  });

  var NODES = [
    { id: "desktop", label: "桌面", depth: 0, icon: "#i-monitor", path: "C:\\Users\\Public\\Desktop", empty: false },
    { id: "pc", label: "此电脑", depth: 0, icon: "#i-drive" },
    { id: "c", label: "本地磁盘 (C:)", depth: 1, icon: "#i-drive", path: "C:\\", empty: false },
    { id: "pf", label: "Program Files", depth: 2, icon: "#i-folder", path: "C:\\Program Files", empty: false },
    { id: "omp", label: "OMP Studio", depth: 3, icon: "#i-folder", path: DEFAULT_PATH },
    { id: "docs", label: "文档", depth: 0, icon: "#i-folder", path: "C:\\Users\\Ada\\Documents", empty: false },
    { id: "dev", label: "Dev（空目录）", depth: 1, icon: "#i-folder", path: "D:\\Dev", empty: true }
  ];
  var browseSel = "omp";
  function renderTree() {
    var tree = document.getElementById("tree"); tree.innerHTML = "";
    NODES.forEach(function (n) {
      var d = document.createElement("div");
      d.className = "node" + (browseSel === n.id ? " sel" : "");
      d.style.paddingLeft = (8 + n.depth * 14) + "px";
      if (!n.path) d.style.opacity = ".75";
      d.innerHTML = '<svg viewBox="0 0 24 24"><use href="' + n.icon + '"/></svg> ' + n.label;
      if (n.path) d.addEventListener("click", function () { browseSel = n.id; renderTree(); });
      tree.appendChild(d);
    });
    var sel = NODES.filter(function (n) { return n.id === browseSel; })[0];
    var picked = (sel && sel.path) || DEFAULT_PATH;
    var resolved = resolveInstallDir(picked);
    document.getElementById("selPath").textContent =
      picked.toLowerCase() === resolved.toLowerCase()
        ? "安装到: " + resolved
        : "所选: " + picked + "  →  将安装到: " + resolved;
  }
  document.getElementById("browseBtn").addEventListener("click", function () {
    if (isLockedDir()) return;
    if (isLive() && installerShell.browse) {
      var picked = installerShell.browse(document.getElementById("pathInput").value);
      if (picked) {
        var stat = liveStat(picked);
        document.getElementById("pathInput").value = resolveInstallDir(picked, stat);
        refreshPathHint();
      }
      return;
    }
    renderTree();
    openDialog(browseOv, "browseOk");
  });
  document.getElementById("browseCancel").addEventListener("click", closeDialogs);
  browseOv.addEventListener("mousedown", function (e) { if (e.target === browseOv) closeDialogs(); });
  document.getElementById("browseOk").addEventListener("click", function () {
    var sel = NODES.filter(function (n) { return n.id === browseSel; })[0];
    if (sel && sel.path) document.getElementById("pathInput").value = resolveInstallDir(sel.path);
    refreshPathHint();
    closeDialogs();
  });
  document.getElementById("pathInput").addEventListener("input", refreshPathHint);
  document.getElementById("pathInput").addEventListener("blur", function () {
    if (isLockedDir()) return;
    var input = document.getElementById("pathInput");
    var resolved = resolveInstallDir(input.value, liveStat(input.value));
    if (resolved) input.value = resolved;
    refreshPathHint();
  });

  document.getElementById("finishBtn").addEventListener("click", function () {
    var run = !isUninstall() && document.getElementById("runCheck").checked;
    if (isLive() && installerShell.finish) {
      installerShell.finish({ run: run });
      return;
    }
    var toast = document.getElementById("toast");
    document.getElementById("toastMsg").textContent = isUninstall()
      ? "卸载向导已退出"
      : (run ? "正在启动 OMP Studio…" : "安装向导已退出");
    toast.hidden = false;
    setTimeout(function () { toast.hidden = true; stopSim(); closeInstallerShell(); }, 2000);
  });

  document.querySelectorAll(".js-next").forEach(function (b) {
    b.addEventListener("click", function () { onWelcomeNext(); });
  });
  document.querySelectorAll(".js-install").forEach(function (b) {
    b.addEventListener("click", beginInstall);
  });
  document.querySelectorAll(".js-back").forEach(function (b) { b.addEventListener("click", function () { go(step - 1); }); });
  Array.prototype.forEach.call(document.querySelectorAll(".scenario-switch button"), function (b) {
    b.addEventListener("click", function () {
      stopSim();
      closeDialogs();
      step = -1;
      applyScenario(b.getAttribute("data-sc"));
      go(0, 1);
    });
  });

  addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!browseOv.hidden || !confirmOv.hidden || !occupyOv.hidden) closeDialogs();
      else if (step < 3) openConfirm();
    }
    var dialog = [browseOv, confirmOv, occupyOv].filter(function (overlay) { return !overlay.hidden; })[0];
    if (e.key === "Tab" && dialog) {
      var controls = Array.prototype.slice.call(dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), a[href]"));
      var first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    // Focused buttons already handle Enter. Handling it again here can skip
    // a step or submit a confirmation twice through native keyboard activation.
    if (e.key === "Enter" && !e.target.closest("button, a, input[type=checkbox]") && !dialog && step !== 2) {
      e.preventDefault();
      if (step === 3) document.getElementById("finishBtn").click();
      else if (step === 1) beginInstall();
      else onWelcomeNext();
    }
  });

  function applyLiveState(state) {
    liveState = state || null;
    if (!liveState) return;
    PACKAGE_VERSION = liveState.version || PACKAGE_VERSION;
    RUNTIME_VERSION = liveState.runtimeVersion || RUNTIME_VERSION;
    ARCH = liveState.arch;
    DEFAULT_PATH = liveState.defaultPath || DEFAULT_PATH;
    var occupancy = liveState.occupancy || "fresh";
    if (occupancy === "same") scenario = "same";
    else if (occupancy === "downgrade") scenario = "downgrade";
    else if (occupancy === "upgrade") scenario = "upgrade";
    else scenario = "fresh";
  }

  var initial = new URLSearchParams(window.location.search).get("scenario") || "fresh";
  if (isLive()) {
    try { applyLiveState(installerShell.getState()); }
    catch (e) { liveState = null; }
    applyScenario(scenario);
  } else {
    applyScenario(initial);
  }
  go(0, 1);
  document.getElementById("previewBadge").hidden = hostMode && !(installerShell && installerShell.isPreview);
  if (hostMode && (!isLive() || !liveState)) {
    document.getElementById("welcomeTitle").textContent = "无法连接安装程序";
    document.getElementById("welcomeLede").textContent = "请关闭向导并重新运行安装包。";
    document.getElementById("welcomeNext").disabled = true;
    document.getElementById("tbVersion").textContent = "";
    document.getElementById("welcomeChip").textContent = "连接失败";
    document.getElementById("welcomeRuntime").textContent = "尚未读取安装包信息";
  }
})();
