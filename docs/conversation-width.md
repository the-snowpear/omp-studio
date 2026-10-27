# Issue 7：对话宽度与窄窗口适配说明

## 使用对话宽度设置

打开 **设置 → 常规 → 对话宽度**，可选择：

- **标准**：最大阅读宽度 768px，兼容原有布局。
- **宽松**：最大阅读宽度 1024px。
- **填满**：使用当前主对话区的可用宽度。
- **自定义**：640–1440px，按32px步进调整。

自定义宽度在切换其他档位后会保留。窗口或面板变窄时，实际显示宽度会临时夹紧，保存的设置不会被覆盖；窗口恢复后会回到首选宽度。

工作台对话菜单也提供同样的四档快捷入口。预览模式中的调整只保存在演示状态，不会写入真实偏好。

## 窄窗口行为

当工作台空间不足时，应用会按以下顺序临时退让：

1. 压缩右侧辅助面板和左侧栏到各自最小宽度。
2. 仍不足时临时隐藏右侧面板。
3. 再不足时临时隐藏左侧栏。
4. 窗口变宽后按原首选尺寸恢复。

用户明确关闭的面板不会因为窗口变宽而自动打开。用户在窄窗口主动打开面板时，面板会以覆盖式布局显示，并提供关闭按钮、Escape 和焦点返回路径。

窄对话区会减少水平留白；小地图在较窄容器中隐藏并恢复原生滚动条。代码、表格、diff 和 Mermaid 图形继续在各自内容块内横向滚动，普通文本和长 URL 会换行。

## 长对话与滚动

调宽或调窄会重新测量可见行，但不会重新请求会话或强制跳到最新消息。贴底阅读继续由原有尾部跟随逻辑负责；离底阅读使用当前消息和可见内容块作为锚点，宽度变化期间保持阅读位置。行高估算按实际宽度分桶，并保持有界缓存。

矮窗口会先将底部面板折叠为标签条；空间仍不足时临时隐藏。打开终端时会保留终端实例，自动尺寸调整不会抢走当前焦点。

## 限制

首版没有正文边缘拖柄。正文宽度通过设置和工作台菜单调整，避免与左右面板拖动、小地图和文本选择手势冲突。完整移动端导航不属于本次适配范围。

## English

Open **Settings → General → Conversation width** to choose Standard (768px), Wide (1024px), Full width, or a Custom width from 640px to 1440px in 32px steps. Custom width is preserved when switching presets. A narrow window temporarily clamps the effective width without overwriting the saved preference.

The workbench conversation menu exposes the same choices. Preview changes stay in demo memory and never write the real preference.

When space is tight, panels shrink and temporarily hide in priority order: right panel, then sidebar. Saved panel choices are restored when space returns, while panels explicitly closed by the user remain closed. A manually opened panel uses a temporary overlay with Escape and focus return.

Narrow conversation columns reduce gutters, hide the minimap and restore the native scrollbar. Code, tables, diffs and Mermaid content keep local horizontal scrolling; ordinary text and long URLs wrap. Resizing a long conversation preserves the visible message/block anchor and does not force the reader to the tail.
