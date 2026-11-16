import { useEffect, useState } from "react";
import { GraphicPreview } from "../graphics/GraphicPreview";
import { useI18n } from "../i18n";
import { MarkdownText } from "../conversation/markdown";
import { CONTENT_GALLERY_GRAPHICS, contentGalleryGlb } from "./contentGalleryGraphics";
import { usePreviewMode } from "./PreviewContext";

function getStreamingSamples(zh: boolean) {
  return [
    [
      zh ? "普通正文与未完成段落" : "Plain prose and unfinished paragraph",
      zh
        ? "## 流式正文\n\n- 已收到的列表项\n- 第二项\n\n接下来的段落正在逐字输出，**尚未闭合的强调"
        : "## Streaming prose\n\n- Received list item\n- Second item\n\nThe following paragraph is streaming token by token, **unclosed emphasis",
    ],
    [
      zh ? "未闭合 TypeScript 围栏" : "Unclosed TypeScript fence",
      zh
        ? "正文前缀已经完成。\n\n```tsx\nconst Result = () => <strong>正在输出…</strong>;\n"
        : "Prose prefix finished.\n\n```tsx\nconst Result = () => <strong>Streaming…</strong>;\n",
    ],
    [
      zh ? "未闭合 Bash 命令" : "Unclosed Bash command",
      "```bash\nreport_dir=\"docs/check reports\"\nprintf '%s\\n' \"$report_dir\"\n",
    ],
    [
      zh ? "未闭合 PowerShell 命令" : "Unclosed PowerShell command",
      "```pwsh\n$root = Get-Location\nGet-ChildItem -LiteralPath $root |\n  Select-Object -First 5\n",
    ],
    [
      zh ? "流式 Mermaid 以源码展示" : "Streaming Mermaid shown as source",
      zh
        ? "```mermaid\nflowchart LR\n  A[用户消息] --> B[工具链]\n"
        : "```mermaid\nflowchart LR\n  A[User message] --> B[Tool chain]\n",
    ],
    [
      zh ? "流式 SVG 图形" : "Streaming SVG graphic",
      "```svg\n" + CONTENT_GALLERY_GRAPHICS[0].source,
    ],
  ] as const;
}

/** Additional parser examples use the same product components, without a live Host turn. */
export function ContentGallerySamples() {
  const { marks } = usePreviewMode();
  const zh = useI18n().resolvedLanguage === "zh";
  const [glbUrl, setGlbUrl] = useState<string>();
  const streamingSamples = getStreamingSamples(zh);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([contentGalleryGlb()], { type: "model/gltf-binary" }));
    setGlbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, []);
  return <>
    <div className="ev ev-assistant" data-item-id="content-gallery-glb">
      <MarkdownText
        text={
          zh
            ? "## 二进制图形 · GLB\n\n与 glTF 样例相同的三角形，使用完整二进制数据进入图形解析器。"
            : "## Binary graphic · GLB\n\nThe same triangle as the glTF sample, passed to the graphics parser as full binary data."
        }
      />
      {marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
      {glbUrl ? <GraphicPreview name="triangle.glb" src={glbUrl} /> : null}
    </div>
    <div className="ev ev-assistant" data-item-id="content-gallery-streaming">
      <MarkdownText
        text={
          zh
            ? "## 流式格式图鉴\n\n下方保留未完成输出，用于检查正文切块、未闭合围栏及流式图形。"
            : "## Streaming format gallery\n\nIncomplete output is preserved below to inspect prose chunking, unclosed fences, and streaming graphics."
        }
      />
      {marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
      {streamingSamples.map(([title, source]) => <div key={title}>
        <MarkdownText text={`### ${title}`} />
        <MarkdownText text={source} streaming />
      </div>)}
    </div>
  </>;
}
