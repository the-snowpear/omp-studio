/** Launched by render-work-bench after its Playwright process is closed. */
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error("native visibility smoke timed out"); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 900, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await window.loadFile(process.env.PERF_NATIVE_PAGE);
    const call = (action) => window.webContents.executeJavaScript(`window.ompPerf.renderWork.background(${JSON.stringify(action)})`);
    await call("start");
    await delay(100);
    window.minimize();
    await delay(150);
    const minimized = window.isMinimized();
    const fed = await call("feed");
    await delay(350);
    const hidden = await call("read");
    window.restore(); window.show(); window.focus();
    await delay(150);
    const visible = await call("stop");
    const report = { minimized, fed, hidden, visible,
      passed: minimized && fed.hidden && hidden.counters.published - fed.counters.published <= 1 && visible.length === 10000 && !visible.hidden };
    writeFileSync(process.env.PERF_NATIVE_REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(`native visibility smoke: ${report.passed}`);
    clearTimeout(timeout); window.destroy(); app.exit(report.passed ? 0 : 1);
  } catch (error) { console.error(error); clearTimeout(timeout); window.destroy(); app.exit(1); }
}).catch((error) => { console.error(error); app.exit(1); });
