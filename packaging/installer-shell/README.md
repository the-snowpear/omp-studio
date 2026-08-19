# OMP Studio installer shell

本地预览设计向导：Electron 开一个固定无边框 `720 × 480` 窗口，加载
`../ui/index.html?host=installer`。目录浏览、磁盘统计走本机 API；点
「安装」只模拟进度（约 4 秒），不会写 Program Files。

真实 Setup 不打包这个 Electron 壳。安装包用 WebView2 宿主
（`packaging/installer-host`）显示同一套 HTML，NSIS 在后台拷文件。

```bash
npm --prefix packaging/installer-shell run dev
```

宿主 API（`window.installerShell`）：

- `minimize` / `close` / `drag`
- `getState` / `statDir` / `browse`
- `startInstall` / `poll` / `finish` / `killApp`（预览里 kill 是空操作）
