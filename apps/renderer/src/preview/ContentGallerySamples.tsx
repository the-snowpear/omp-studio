import { useEffect, useState } from "react";
import { GraphicPreview } from "../graphics/GraphicPreview";
import { MarkdownText } from "../conversation/markdown";
import { CONTENT_GALLERY_GRAPHICS, contentGalleryGlb } from "./contentGalleryGraphics";
import { usePreviewMode } from "./PreviewContext";

const STREAMING_SAMPLES = [
  ["普通正文与未完成段落", "## 流式正文\n\n- 已收到的列表项\n- 第二项\n\n接下来的段落正在逐字输出，**尚未闭合的强调"],
  ["未闭合 TypeScript 围栏", "正文前缀已经完成。\n\n```tsx\nconst Result = () => <strong>正在输出…</strong>;\n"],
  ["未闭合 Bash 命令", "```bash\nreport_dir=\"docs/check reports\"\nprintf '%s\\n' \"$report_dir\"\n"],
  ["未闭合 PowerShell 命令", "```pwsh\n$root = Get-Location\nGet-ChildItem -LiteralPath $root |\n  Select-Object -First 5\n"],
  ["流式 Mermaid 以源码展示", "```mermaid\nflowchart LR\n  A[用户消息] --> B[工具链]\n"],
  ["流式 SVG 图形", "```svg\n" + CONTENT_GALLERY_GRAPHICS[0].source],
] as const;

/** Additional parser examples use the same product components, without a live Host turn. */
export function ContentGallerySamples() {
  const { marks } = usePreviewMode();
  const [glbUrl, setGlbUrl] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([contentGalleryGlb()], { type: "model/gltf-binary" }));
    setGlbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, []);
  return <>
    <div className="ev ev-assistant" data-item-id="content-gallery-glb">
      <MarkdownText text="## 二进制图形 · GLB\n\n与 glTF 样例相同的三角形，使用完整二进制数据进入图形解析器。" />
      {marks ? <span className="chip gray xs">演示</span> : null}
      {glbUrl ? <GraphicPreview name="triangle.glb" src={glbUrl} /> : null}
    </div>
    <div className="ev ev-assistant" data-item-id="content-gallery-streaming">
      <MarkdownText text="## 流式格式图鉴\n\n下方保留未完成输出，用于检查正文切块、未闭合围栏及流式图形。" />
      {marks ? <span className="chip gray xs">演示</span> : null}
      {STREAMING_SAMPLES.map(([title, source]) => <div key={title}>
        <MarkdownText text={`### ${title}`} />
        <MarkdownText text={source} streaming />
      </div>)}
    </div>
  </>;
}
