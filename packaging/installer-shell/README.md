# OMP Studio installer shell

这是方案 2 的第一阶段宿主：Electron 只负责提供一个固定的无边框
`720 × 480` Windows 窗口，并安全加载 `../ui/index.html?host=installer`。
安装目录、文件复制、运行时部署、快捷方式、卸载和回滚均未接入；当前
页面里的安装过程仍是视觉演示。

## 本地运行

在仓库根目录执行：

```bash
npm --prefix packaging/installer-shell run dev
```

宿主 API 目前只暴露两个窗口操作：

- `window.installerShell.minimize()`
- `window.installerShell.close()`

没有安装相关 API。后续接入 NSIS 时，NSIS 负责启动/打包这个宿主，
再把安装协议通过受控 IPC 接入，而不是让页面直接访问文件系统。
