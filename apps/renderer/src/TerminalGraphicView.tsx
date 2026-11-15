import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { isRasterBase64, type TerminalGraphic } from "./terminalGraphics";

export function RasterPreview({ value, alt }: { value: unknown; alt: string }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [failed, setFailed] = useState(false);
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const data = record.data, mime = record.mimeType;
  useEffect(() => setFailed(false), [data, mime]);
  if (!isRasterBase64(data, mime)) return null;
  return failed ? <p role="status">{alt}: {zh ? "图片无法显示" : "image unavailable"}</p> :
    <img className="tool-media-preview" style={{ maxWidth: "100%", maxHeight: 360, objectFit: "contain" }} src={`data:${String(mime)};base64,${data}`} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

export function TerminalGraphicView({ image }: { image: TerminalGraphic }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const label = zh ? `${image.source} 图像` : `${image.source} image`;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!image.pixels || !image.width || !image.height) return;
    const ctx = ref.current?.getContext("2d");
    if (ctx) { const frame = ctx.createImageData(image.width, image.height); frame.data.set(image.pixels); ctx.putImageData(frame, 0, 0); }
  }, [image]);
  return image.data ? <RasterPreview value={{ data: image.data, mimeType: "image/png" }} alt={label} /> :
    <canvas ref={ref} width={image.width} height={image.height} role="img" aria-label={label} style={{ maxWidth: "100%", maxHeight: 360, objectFit: "contain" }} />;
}
