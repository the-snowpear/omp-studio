/** Paste into the current OMP application's DevTools Console. No session content or commands. */
(() => {
  const perf = window.ompSessionPerf;
  if (!perf) throw new Error("采样 API 不存在。请从本仓库启动当前构建，不要使用旧安装包。");
  window.ompManualSessionCapture?.cancel();
  const startedAtUnixMs = Date.now();
  const schedule = [
    { seconds: 0, name: "prepare" },
    { seconds: 5, name: "idle-before" },
    { seconds: 15, name: "repeat" },
    { seconds: 30, name: "different" },
    { seconds: 45, name: "idle-after" },
  ];
  const phases = [], timers = [];
  let current, finished = false;
  function capture() {
    if (!current) return;
    phases.push({ name: current.name, startedAtUnixMs: current.startedAtUnixMs, endedAtUnixMs: Date.now(),
      visibility: document.visibilityState, focused: document.hasFocus(),
      viewport: { width: innerWidth, height: innerHeight }, recording: perf.snapshot(true) });
  }
  function cancel() {
    if (finished) return;
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    perf.stop();
    window.removeEventListener("pagehide", cancel);
    delete window.ompManualSessionCapture;
  }
  function finish() {
    if (finished) return;
    capture();
    const endedAtUnixMs = Date.now();
    cancel();
    const result = { version: 2, kind: "manual-session-switch", startedAtUnixMs, endedAtUnixMs,
      plannedDurationMs: 60_000, completed: endedAtUnixMs - startedAtUnixMs >= 60_000, phases,
      recording: perf.snapshot(true) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `omp-session-manual-${endedAtUnixMs}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.info("采样已停止并导出。请将 JSON 放进 outputs/perf/manual-session-switch，然后告诉助手已采完。");
  }
  function begin(stage) {
    if (finished) return;
    capture();
    current = { name: stage.name, startedAtUnixMs: Date.now() };
    perf.phase(schedule.indexOf(stage));
    console.info(`采样阶段：${stage.name}`);
  }
  perf.stop();
  perf.start();
  window.ompManualSessionCapture = { cancel, finish };
  window.addEventListener("pagehide", cancel, { once: true });
  begin(schedule[0]);
  for (const stage of schedule.slice(1)) timers.push(setTimeout(() => begin(stage), stage.seconds * 1000));
  timers.push(setTimeout(finish, 60_000));
  console.info("现在关闭开发者工具。前 15 秒静置；15–30 秒 A/B 往返切换；30–45 秒打开不同会话；45–60 秒静置。60 秒自动导出，勿刷新页面。");
})();
