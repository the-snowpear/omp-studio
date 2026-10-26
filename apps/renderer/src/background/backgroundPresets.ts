/**
 * 内置背景预设。
 *
 * 只用 CSS 渐变，不随包携带位图：打开设置就能看到可用的「第一张背景」，
 * 预览模式、离线环境、存储不可用时也都有内容可选。`avgColor` / `luma`
 * 是给遮罩与原生标题栏 tint 用的近似值，改动配色时一并调整。
 */

export interface BackgroundPreset {
  readonly id: string;
  readonly nameZh: string;
  readonly nameEn: string;
  /** 直接写进 `style.background`；只来自本模块静态常量。 */
  readonly css: string;
  /** 平均色，用于原生标题栏 tint。 */
  readonly avgColor: string;
  /** 平均相对亮度 0–1，用于自动遮罩。 */
  readonly luma: number;
}

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  {
    id: "preset:aurora",
    nameZh: "极光",
    nameEn: "Aurora",
    css:
      "radial-gradient(120% 90% at 12% 8%, rgba(110,86,207,0.62), transparent 62%)," +
      "radial-gradient(90% 80% at 88% 18%, rgba(34,211,238,0.34), transparent 66%)," +
      "radial-gradient(110% 100% at 52% 108%, rgba(236,72,153,0.24), transparent 72%)," +
      "linear-gradient(160deg, #121325, #1b1c33 55%, #0e1020)",
    avgColor: "#22243c",
    luma: 0.03,
  },
  {
    id: "preset:dusk",
    nameZh: "暮色",
    nameEn: "Dusk",
    css:
      "radial-gradient(110% 90% at 18% 12%, rgba(245,158,11,0.42), transparent 64%)," +
      "radial-gradient(90% 80% at 82% 24%, rgba(239,68,68,0.3), transparent 66%)," +
      "radial-gradient(120% 110% at 50% 110%, rgba(124,58,237,0.24), transparent 70%)," +
      "linear-gradient(165deg, #241420, #351d2a 55%, #1a1018)",
    avgColor: "#3a2230",
    luma: 0.05,
  },
  {
    id: "preset:mist",
    nameZh: "雾林",
    nameEn: "Mist",
    css:
      "radial-gradient(100% 90% at 20% 10%, rgba(74,222,128,0.18), transparent 62%)," +
      "radial-gradient(90% 80% at 78% 22%, rgba(45,212,191,0.16), transparent 66%)," +
      "radial-gradient(120% 100% at 50% 105%, rgba(148,163,184,0.18), transparent 72%)," +
      "linear-gradient(160deg, #131b18, #1d2a24 55%, #101714)",
    avgColor: "#1f2b26",
    luma: 0.03,
  },
  {
    id: "preset:paper",
    nameZh: "纸纹",
    nameEn: "Paper",
    css:
      "radial-gradient(120% 90% at 12% 6%, rgba(255,255,255,0.9), transparent 60%)," +
      "radial-gradient(90% 80% at 86% 20%, rgba(214,205,190,0.55), transparent 66%)," +
      "repeating-linear-gradient(0deg, rgba(120,110,95,0.05) 0 1px, transparent 1px 3px)," +
      "linear-gradient(160deg, #efe9dd, #e4dccd 55%, #d8d0c1)",
    avgColor: "#e2dacc",
    luma: 0.71,
  },
  {
    id: "preset:stardust",
    nameZh: "星尘",
    nameEn: "Stardust",
    css:
      "radial-gradient(circle at 18% 22%, rgba(255,255,255,0.9) 0 1px, transparent 1.6px) 0 0 / 46px 46px," +
      "radial-gradient(circle at 72% 68%, rgba(255,255,255,0.7) 0 1px, transparent 1.5px) 0 0 / 31px 31px," +
      "radial-gradient(110% 80% at 50% 0%, rgba(99,102,241,0.4), transparent 64%)," +
      "radial-gradient(90% 70% at 80% 90%, rgba(14,165,233,0.24), transparent 66%)," +
      "linear-gradient(180deg, #0a0d18, #11162a 60%, #080b14)",
    avgColor: "#0f1424",
    luma: 0.015,
  },
  {
    id: "preset:linen",
    nameZh: "亚麻",
    nameEn: "Linen",
    css:
      "repeating-linear-gradient(90deg, rgba(120,108,92,0.06) 0 1px, transparent 1px 4px)," +
      "repeating-linear-gradient(0deg, rgba(120,108,92,0.05) 0 1px, transparent 1px 4px)," +
      "radial-gradient(120% 90% at 10% 0%, rgba(255,255,255,0.75), transparent 60%)," +
      "linear-gradient(160deg, #ddd6c9, #d0c7b8 60%, #c4baa9)",
    avgColor: "#cfc6b8",
    luma: 0.6,
  },
];

export function findBackgroundPreset(id: string): BackgroundPreset | undefined {
  return BACKGROUND_PRESETS.find((preset) => preset.id === id);
}
