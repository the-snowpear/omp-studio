# 文件查看器

文件树中单击文件、按 Enter，或点击对话中的文件链接，即可在工作台打开文件窗口。行内代码中的文件路径也可点击，例如 `src/main.ts:42`。网页链接沿用浏览器打开方式。

文件路径按来源对话的执行目标和工作区解释；SSH 路径不会回落到本机。支持工作区相对路径和位于该工作区内的绝对路径。

## 窗口与保存

每个文件默认打开为独立通用浮窗，可拖动、停靠、吸附、合并为标签组、最小化或通过 Pin 显示为独立系统窗口。重复打开同一归属范围内的文件会聚焦已有窗口。

默认归属于来源对话。在 **设置 → 工具与终端 → 文件查看器** 中可将后续文件窗口设为工作区共享；已有窗口通过 Pin 调整。工作区共享文件保留当前对话上下文，同一文件的不同视图共用文本缓冲。

文本使用 **Ctrl / Cmd + S** 手动保存，未保存时标题带圆点。关闭最后一个编辑视图或退出应用时可选择保存、放弃或取消。源文件被 Agent 或其他程序改动时，编辑器保留本地草稿，提供比较、重新加载及明确覆盖的选择。

SSH 断连时保留草稿。保存结果不明确时先读取核实，不自动重放写入。应用更新也会等待未保存的文件得到处理。

文本编辑支持 UTF-8，以及带 BOM 的 UTF-16 LE/BE，保留 BOM 和 LF/CRLF 换行格式。内置编辑范围为 8 MiB；其他编码或更大的文本可下载后用外部编辑器处理。

## 格式

| 格式 | 支持 |
| --- | --- |
| 文本、代码、JSON、YAML、HTML 源码 | 编辑、语法高亮、查找替换、行号跳转 |
| Markdown | 源码/预览切换，相对文件链接与本地图片 |
| PDF | 连续分页、目录、缩放、搜索、文字选择、密码输入 |
| PNG、JPEG、GIF、WebP、BMP、AVIF、SVG | 缩放、拖动、旋转、适应窗口 |
| 音频与视频 | 原生播放、进度、音量和全屏；以 Chromium 实际编解码能力为准 |
| XLS、XLSX | 只读表格、工作表切换、滚动、选择复制，显示已保存的公式结果 |
| CSV、TSV | 表格浏览与文本编辑切换 |
| DOC、DOCX、RTF、ODT、PPT、PPTX、ODP | 安装 Office 组件后离线转换为静态 PDF 页面 |

HTML 按源码打开，SVG 按图片打开。Office 预览不编辑原文件、不运行宏；排版仍可能因字体与转换兼容性产生差异，PPT 动画不保留。未提供 Excel 公式重算、Office 编辑或额外媒体转码。

## 可选 Office 组件

打开 **设置 → 更新与维护 → 可选组件 → Office 文档预览**，可检查版本、安装、取消安装、更新或卸载。组件默认不安装，不随主程序打包，应用自动下载设置也不会自动安装它。

未安装时，点击 Word、PPT 等文件仍会打开通用窗口，窗口内显示安装说明和入口。安装完成后，仍打开的文件会自动尝试预览，无需重启。Excel/CSV 已内置支持。

引擎安装在当前应用配置目录的 `components/office-preview/`，转换使用独立用户配置与缓存。远程文档通过 SSH 分块读取到本机后转换，远端无需安装 LibreOffice。卸载会清理组件程序、下载缓存和转换缓存，保留工作区中的源文件。

组件使用独立签名清单与平台包，支持 Windows x64、Windows ARM64、macOS ARM64。发布者必须先发布对应工件；组件清单不存在时，设置页会明确显示尚未发布。

## 开发与发布

文件元数据、文本读取、分块读取和保存属于 Host 工作区文件服务，不调用模型或 Runtime。桌面 `omp-file:` 资源通道为本地及 SSH 文件提供范围读取，PDF、媒体和 Office 原始字节不进入整文件 JSON 消息。

Office 打包入口：

```bash
npm run components:office:pack -- --version 26.8.2 --engine-version 26.8.2
```

需要 `OMP_RUNTIME_SIGNING_KEY`（私钥文件路径）和 `OMP_RUNTIME_SIGNING_KEY_ID`。必须在目标原生平台构建。默认下载官方 LibreOffice 发行包并核对官方 SHA-256，也可通过 `--source` 指定已经解出的完整发行目录。保留上游许可文件，输出独立 ZIP 与 `office-preview-<platform>.json`，不改主应用安装包。

手动 workflow `Optional Office preview component` 构建三个平台。默认只上传 workflow 工件；显式选择 `publish` 才发布到 `office-preview` Release。发布前留存旧 Release 元数据和组件清单，版本 ZIP 不覆盖，平台清单在 ZIP 全部上传后更新。

隔离验收脚本：

```bash
npm run check -- --only desktop
npm run components:office:smoke -- --directory outputs/file-viewer-office-qa --public-key outputs/file-viewer-office-qa/qa-public.pem
```

该目录应先包含已签名组件 ZIP、平台 JSON 和对应测试公钥。脚本在自己的 `isolated-profile/` 安装，使用真实 DOCX/PPTX 转换、核对 PDF 文本与源文件不变，再卸载，并保存转换 PDF 与 `smoke-results.json`。不会使用操作者的应用配置目录。

界面验收入口为开发服务器的 `file-viewer-harness.html?preview=1&marks=off`，复用生产文件窗口与渲染器，数据位于 `preview/filesPreview.ts`。真实与演示状态遵循统一预览开关。
