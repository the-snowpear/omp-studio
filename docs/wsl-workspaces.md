# WSL 工作区

在 Windows 11 桌面版打开「工作位置」，在 WSL 分组选择发行版。需要一个已安装并完成首次用户设置的 WSL 2 发行版。可在 Windows 终端用 `wsl -l -v` 核对名称和版本。WSL 1 会显示为禁用，Docker Desktop 和 Rancher Desktop 的内部发行版会隐藏。

首次连接时，Studio 会显示安装位置和同步范围。确认后，Studio 将私有 Node、Headless Host 和签名 Runtime 安装到发行版中，默认数据根为 `~/.local/share/omp-studio/remote`。使用发行版默认用户。选择 Linux 项目目录后，文件、Git、Agent、底部终端和 tmux 均在该发行版运行。建议将项目放在 Linux 主目录，访问 `/mnt/c` 等 Windows 磁盘时，Git 和大量小文件操作通常较慢。

模型配置与 API Key 从 Windows Studio 同步，OAuth 刷新令牌由本机保管。网络先尝试从发行版访问，连接失败时可通过 Windows 转发。Host 启动前会读取默认登录 Shell 的工具链环境，供 nvm、pyenv 等工具使用。若登录 Shell 超时或失败，Host 使用发行版原有环境启动，Windows Host 日志记录此次回退。

项目菜单可以打开资源管理器或外部编辑器。VS Code 使用 WSL 远程窗口，需要安装其 WSL 扩展。其他编辑器通过 `\\\\wsl.localhost\\发行版` 访问文件。工作区文件的右键菜单支持系统应用、打开方式、资源管理器定位和复制路径。复制的绝对路径可直接粘贴到 Linux 终端。系统文件浏览器、IDA、本机听写和 Windows 拖放路径映射仍受远程工作区限制。

断开后，发行版空闲时可能停止，未完成的任务可能中断。运行中的 Host 可以被下次连接复用，此时不会重新加载修改过的 Shell 配置。需要新环境时应等待旧 Host 退出，或在保存工作后执行 `wsl --shutdown`（会停止所有运行中的 WSL 发行版）。连接期间若发行版重启，Studio 会尝试恢复并报告 Host 实例变化；请核对原任务状态。
