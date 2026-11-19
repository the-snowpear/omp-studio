# WSL 工作区实机验证

## 2026-11-20 · 第 0 阶段

Windows 11 x64（10.0.26300.9974），WSL 2.7.10.0，内核 6.18.33.2-2。当前用户仅注册了 Docker Desktop 的内部发行版 `docker-desktop`，它是默认发行版，版本为 2，状态为 `Stopped`。按计划过滤后可选发行版为零。后续实测需要安装或导入一个普通 WSL 2 发行版。

### 发行版发现

一次性 Node 脚本直接调用系统的 `wsl.exe`，按原始字节读取 stdout 和 stderr。下列四次调用的退出码均为 0，stderr 均为空。

| 命令 | 未设置 `WSL_UTF8` | 设置 `WSL_UTF8=1` |
|---|---|---|
| `wsl.exe -l -v` | 168 字节，UTF-16LE，无 BOM | 84 字节，与左侧解码后的 ASCII 文本一致 |
| `wsl.exe -l --running -q` | stdout 为 0 字节 | stdout 为 0 字节 |

两次详细列表的表头均为英文 `NAME / STATE / VERSION`，默认发行版前有 `*`。这台机器上 WSL 已安装且有注册项，因此尚未取得 WSL 未安装和完全没有注册项时的退出码与诊断文本。

### 待验项目

普通发行版就绪后，从计划第 1 项 argv 逐字比对开始，再验证 50 MB 二进制上传、Host 生命周期、关停与重连、ConPTY、Electron UNC 和 VS Code 远程窗口。产品实现和端到端验收尚未开始。
