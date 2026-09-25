export const PREVIEW_RECORDING = [
  JSON.stringify({ studiocast: 1, cols: 80, rows: 12, title: "Shell recording · 演示", createdAt: "2026-09-25T00:00:00Z" }),
  JSON.stringify([0, { t: "output", data: "> npm run build\r\n" }]),
  JSON.stringify([600, { t: "output", data: "Building workspace…\r\n" }]),
  JSON.stringify([1600, { t: "output", data: "\u001b[32mBuild complete.\u001b[0m\r\n" }]),
].join("\n") + "\n";
