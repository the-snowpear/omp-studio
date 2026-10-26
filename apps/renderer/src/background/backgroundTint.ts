/**
 * 背景层的颜色数学：自动遮罩、对比度估算、原生标题栏 tint。
 *
 * 全部是纯函数，便于钉住默认值的可读性行为。颜色按 sRGB 通道线性混合，
 * 对「取平均色」这种近似足够；真正的可读性仍以截图与肉眼验收为准。
 */

export type BackgroundTheme = "light" | "dark";

/** 与 `styles/tokens.css` 的 `--bg` / `--text` 保持一致。 */
export const BACKGROUND_THEME_COLORS = {
  light: { background: "#fbfbfc", text: "#1d2129" },
  dark: { background: "#121519", text: "#e7e8eb" },
} as const;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function parseHexColor(value: string): Rgb | undefined {
  const match = /^#([0-9a-f]{6})$/iu.exec(value.trim());
  if (match === null) return undefined;
  const hex = match[1] ?? "";
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

export function toHexColor(rgb: Rgb): string {
  const channel = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

export function mixHexColor(from: string, to: string, toWeight: number): string {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (a === undefined) return to;
  if (b === undefined) return from;
  const weight = Math.max(0, Math.min(1, toWeight));
  return toHexColor({
    r: a.r + (b.r - a.r) * weight,
    g: a.g + (b.g - a.g) * weight,
    b: a.b + (b.b - a.b) * weight,
  });
}

/** 暗色主题下把过暗的壁纸提亮，避免深色底 + 深色图几乎看不见。 */
export function gradeBackgroundColor(theme: BackgroundTheme, avgColor: string, luma: number): string {
  if (theme !== "dark" || luma >= 0.25) return avgColor;
  const rgb = parseHexColor(avgColor);
  if (rgb === undefined) return avgColor;
  const factor = 1.55;
  return toHexColor({ r: rgb.r * factor, g: rgb.g * factor, b: rgb.b * factor });
}

export function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color);
  if (rgb === undefined) return 0;
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface ScrimInput {
  readonly opacity: number;
  readonly strength: number;
  readonly avgColor: string;
}

/**
 * 自动遮罩：从最小的主题色薄纱开始，找到能满足正文 4.6:1 的那一档。
 *
 * 不按亮度写死公式，因为「结构壳本身也会盖一层底色」——同样的图，透出强度
 * 越高需要的遮罩越少，越低则需要越多。最小值只是审美下限，避免纯色渐变被
 * 洗得看不见。
 */
export function autoScrim(theme: BackgroundTheme, input: ScrimInput): number {
  const minimum = theme === "light" ? 20 : 25;
  for (let scrim = minimum; scrim <= 95; scrim += 5) {
    if (estimateReadability({ ...input, scrim }, theme) >= 4.6) return scrim;
  }
  return 95;
}

export function scrimColorForTheme(theme: BackgroundTheme): string {
  return theme === "light" ? "#ffffff" : "#000000";
}

export interface ReadabilityInput {
  readonly opacity: number;
  readonly strength: number;
  readonly scrim: number;
  readonly avgColor: string;
}

/**
 * 估算正文落在「结构壳 → 遮罩 → 背景媒体」叠层后的对比度。
 * 只用于设置页提示（平均色无法代表每一条纹路），不作为硬性拦截。
 */
export function estimateReadability(input: ReadabilityInput, theme: BackgroundTheme): number {
  const colors = BACKGROUND_THEME_COLORS[theme];
  const media = mixHexColor(colors.background, input.avgColor, input.opacity / 100);
  const veil = mixHexColor(media, scrimColorForTheme(theme), input.scrim / 100);
  const shell = mixHexColor(veil, colors.background, Math.max(0, 100 - input.strength) / 100);
  return contrastRatio(colors.text, shell);
}

export interface TitlebarTint {
  readonly color: string;
  readonly symbolColor: string;
}

/**
 * Windows 捕获按钮区域由原生绘制，渲染层盖不到。取平均色混出近似底色，
 * 再按对比度挑深/浅符号色；macOS 没有这层遮罩，传了也不生效。
 */
export function titlebarTint(theme: BackgroundTheme, avgColor: string): TitlebarTint {
  const colors = BACKGROUND_THEME_COLORS[theme];
  let color = mixHexColor(colors.background, avgColor, 0.55);
  const candidates = [colors.text, "#f5f6f8"];
  const bestSymbol = (): string => candidates.reduce((best, candidate) =>
    contrastRatio(candidate, color) > contrastRatio(best, color) ? candidate : best, candidates[0] ?? "#ffffff");

  let symbolColor = bestSymbol();
  // 平均色落在中间调时，主题文字与纯白都不一定够 4.5:1；把 tint 往相反方向
  // 推几档，保证捕获按钮始终可读。最多 10 档，每档 12%。
  const target = symbolColor === "#f5f6f8" ? "#000000" : "#ffffff";
  for (let step = 0; step < 10 && contrastRatio(symbolColor, color) < 4.5; step += 1) {
    color = mixHexColor(color, target, 0.12);
    symbolColor = bestSymbol();
  }
  return { color, symbolColor };
}
