/**
 * 背景媒体渲染：预设 / 图片 / 视频共用。真实背景层与设置页预览卡都走这里，
 * 保证「预览看到的裁切、模糊、不透明度」和真实背景一致。
 */

import { useEffect, useRef } from "react";

import type { BackgroundSettings } from "./backgroundSettings";
import type { BackgroundAsset } from "./backgroundLibrary";

export function BackgroundMedia({
  asset,
  url,
  settings,
  motion,
}: {
  readonly asset: BackgroundAsset;
  readonly url: string | null;
  readonly settings: BackgroundSettings;
  /** 已经合并了「跟随系统减少动态效果」的最终播放意图。 */
  readonly motion: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lumaBand = asset.luma < 0.25 ? "dark" : asset.luma > 0.6 ? "bright" : "mid";

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return undefined;
    const sync = (): void => {
      if (document.hidden) video.pause();
      else void video.play().catch(() => undefined);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [url]);

  if (asset.kind === "preset") {
    return (
      <div
        className="bg-media bg-media-preset"
        data-luma={lumaBand}
        style={{ background: asset.presetCss ?? "var(--bg)" }}
      />
    );
  }

  if (asset.kind === "video") {
    if (!motion || url === null) {
      return asset.thumbDataUrl === undefined
        ? <div className="bg-media bg-media-empty" />
        : <img className="bg-media" data-luma={lumaBand} src={asset.thumbDataUrl} alt="" draggable={false} />;
    }
    return (
      <video
        ref={videoRef}
        className="bg-media"
        data-luma={lumaBand}
        src={url}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
        {...(asset.thumbDataUrl === undefined ? {} : { poster: asset.thumbDataUrl })}
      />
    );
  }

  const source = (motion ? url ?? asset.thumbDataUrl : asset.thumbDataUrl ?? url) ?? undefined;
  if (source === undefined) return <div className="bg-media bg-media-empty" />;
  if (settings.fit === "tile") {
    return (
      <div
        className="bg-media-tile"
        data-luma={lumaBand}
        style={{ backgroundImage: `url("${source}")` }}
      />
    );
  }
  return <img className="bg-media" data-luma={lumaBand} src={source} alt="" draggable={false} />;
}
