# 字体设置 / Font settings

在 **设置 → 常规 → 字体** 分别配置三类文字，修改即时生效并自动保存到本机。

| 分组 | 影响内容 | 默认基准字号 |
|---|---|---|
| 界面 / Interface | 导航、侧栏、设置、按钮和输入控件 | 14px |
| 终端 / Terminal | 本机 Shell 与终端录制回放 | 12px |
| 输出 / Output | 用户和助手正文、思考、代码、工具输出、底部 Output 与日志内容 | 14px |

点击「加载系统字体」后，可以搜索本机字体家族；安装新字体后点击「刷新系统字体」。也可以选择「自定义名称…」，输入已安装字体名称并按回车或移开焦点。字体列表仅保存在内存中，名称与字号保存到本机设置。

界面与输出的字号是基准值：原有标题、正文、代码的字号层级按比例调整。终端使用所设的实际像素字号。界面支持 12–20px；终端和输出支持 8–32px。每组可独立恢复默认，也可使用常规页的「恢复默认值」。

默认字体保留现有正文与等宽代码的区别。自定义输出字体同时用于正文和代码，建议选择等宽字体，例如已经安装的 Cascadia Code、Consolas 或 JetBrains Mono。未安装的字体使用默认字体回退，设置中保留用户输入的名称。不支持字体枚举的浏览器仍可手填名称。

预览模式展示演示字体列表，修改只影响设置页示例，不修改真实偏好或本机终端。

## English

Open **Settings → General → Fonts** to customize interface, terminal and output text independently. Changes apply immediately and persist locally. Load system fonts to search installed families, or choose **Custom name…** and commit a family name with Enter or blur. Refresh the list after installing a font.

Interface and output sizes scale the existing text hierarchy; terminal size is an absolute pixel value. Reset each group independently or use General's reset action. A custom output family applies to both prose and code, so a monospaced family is recommended. Missing fonts fall back to the existing defaults. Browsers without Local Font Access still support manual entry. Preview edits affect only the samples.

## 实现参考

- [Zed settings](https://zed.dev/docs/reference/all-settings)：界面、编辑内容与终端分别配置。
- [Tabby appearance settings](https://github.com/Eugeny/tabby/blob/master/tabby-terminal/src/components/appearanceSettingsTab.component.ts)：本机字体搜索与示例。
- [Chromium Local Font Access](https://developer.chrome.com/docs/capabilities/web-apis/local-fonts)：用户操作触发本机字体枚举。
- [xterm.js terminal options](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)：运行时更新字体与字号。
