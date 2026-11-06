/**
 * 读元素身上真正生效的过渡时钟。
 *
 * 折叠/展开这一套动作要求「头像、底栏高度、分界线、面板」都在同一根曲线上，所以时长和
 * 延迟都从 CSS 读，而不是在 JS 里再写一份常量：性能档位把 `transition-duration` 压到
 * 0.01ms 时，这里读出来就是 0，调用方自然走「直接换、不做动画」的快路径。
 */

/** 只读不写死：拿不到就按 250ms（--dur-slow）算。 */
const FALLBACK_MS = 250;

function firstDuration(value: string): number {
  const raw = value.split(",")[0]?.trim() ?? "";
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return FALLBACK_MS;
  return raw.endsWith("ms") ? parsed : parsed * 1000;
}

/** 第一段过渡的时长（毫秒）。 */
export function transitionMs(element: HTMLElement): number {
  return firstDuration(getComputedStyle(element).transitionDuration);
}

/** 第一段过渡的延迟（毫秒）：折回时底栏会先等标签淡出再收，卸载计时要把这段算上。 */
export function transitionDelayMs(element: HTMLElement): number {
  const raw = getComputedStyle(element).transitionDelay.split(",")[0]?.trim() ?? "";
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return 0;
  return raw.endsWith("ms") ? parsed : parsed * 1000;
}
