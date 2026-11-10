/**
 * 教程动画的时间轴。
 *
 * 用「秒」写关键帧，再按场景时长换算成 CSS keyframes 百分比，避免手算百分比时
 * 光标、拖动幽灵和窗口几何互相错位：同一段拖动只要起止时间相同、缓动相同，
 * 画面就逐帧同步。生成的 CSS 只含本模块的静态字符串，以 <style> 注入场景根节点。
 */

import { ONBOARDING_TEMPO, SCENE_DURATION, type OnboardingSceneId } from "./scenes";

type Key = readonly [seconds: number, css: string];
type Tracks = Readonly<Record<string, readonly Key[]>>;

const tr = (x: number, y: number, s = 1): string => `transform:translate(${x}px,${y}px) scale(${s})`;
const geo = (l: number, t: number, w: number, h: number): string => `left:${l}px;top:${t}px;width:${w}px;height:${h}px`;
const bg = (value: string): string => `background-color:${value}`;
const X = (x: number): string => `transform:translateX(${x}px)`;
const SOFT = "var(--accent-soft)";
const SURF = "var(--surface-2)";
const CLEAR = "transparent";
/** 固定场景：应用内浮窗 / 独立系统窗口（多一圈强调色描边与更深的投影）。阴影层数一致才能插值。 */
const IN_APP = "box-shadow:0 0 0 0 transparent,0 10px 26px -10px rgba(10,12,30,.32)";
const LIFTED = "box-shadow:0 0 0 2px var(--accent-border),0 24px 46px -12px rgba(10,12,30,.55)";
/** 应用窗口缩进任务栏图标：中心 (256,186) → (320,385)。 */
const MIN_UP = "transform:translate(0px,0px) scale(1)";
const MIN_DOWN = "transform:translate(64px,199px) scale(.06)";

/** 光标路径：[秒, x, y]。 */
function path(points: readonly (readonly [number, number, number])[]): Key[] {
  return points.map(([t, x, y]) => [t, tr(x, y)] as const);
}

/** 点击涟漪：每次点击一个从小到大的淡出环。 */
function pulses(times: readonly number[]): Key[] {
  const rest = "opacity:0;transform:scale(.3)";
  const keys: Key[] = [[0, rest]];
  for (const t of times) {
    keys.push([t - 0.02, rest], [t, "opacity:.9;transform:scale(.45)"], [t + 0.42, "opacity:0;transform:scale(1.9)"], [t + 0.44, rest]);
  }
  return keys;
}

/** 按住期间显示的实心点。 */
function holds(ranges: readonly (readonly [number, number])[]): Key[] {
  const keys: Key[] = [[0, "opacity:0;transform:scale(.4)"]];
  for (const [start, end] of ranges) {
    keys.push([start - 0.05, "opacity:0;transform:scale(.4)"], [start, "opacity:.95;transform:scale(1)"], [end, "opacity:.95;transform:scale(1)"], [end + 0.1, "opacity:0;transform:scale(.4)"]);
  }
  return keys;
}

/** 按键按下：每次 0.25s。 */
function keyPresses(times: readonly number[]): Key[] {
  const up = "transform:translateY(0)";
  const keys: Key[] = [[0, up]];
  for (const t of times) keys.push([t - 0.04, up], [t, "transform:translateY(2px)"], [t + 0.22, up]);
  return keys;
}

const TRACKS: Readonly<Record<Exclude<OnboardingSceneId, "overview">, Tracks>> = {
  windows: {
    "s3-cur": path([[0, 360, 300], [0.9, 70, 87], [1.1, 70, 87], [2.6, 310, 110], [2.8, 310, 110], [3.5, 330, 108], [3.8, 330, 108], [4.8, 370, 138], [5.0, 370, 138], [5.6, 465, 138], [5.85, 465, 138], [6.6, 465, 371], [7.4, 465, 371], [8.4, 360, 300]]),
    "s3-ring": pulses([1.0, 3.8, 5.85, 7.4]),
    "s3-press": holds([[1.0, 2.7], [3.8, 4.9]]),
    "s3-row": [[0, "opacity:0"], [0.95, "opacity:0"], [1.05, "opacity:1"], [2.7, "opacity:1"], [2.85, "opacity:0"]],
    "s3-ghost": [[0, `${tr(50, 80)};opacity:0`], [1.1, `${tr(50, 80)};opacity:0`], [1.25, "opacity:1"], [1.9, "opacity:1"], [2.1, "opacity:0"], [2.6, tr(290, 103)]],
    "s3-preview": [[0, `${tr(10, 77)};opacity:0`], [1.1, tr(10, 77)], [1.9, "opacity:0"], [2.15, "opacity:1"], [2.6, tr(250, 100)], [2.7, "opacity:1"], [2.95, "opacity:0"]],
    "s3-win": [
      [0, `${tr(0, 0, 0.96)};opacity:0`], [2.7, `${tr(0, 0, 0.96)};opacity:0`], [3.0, `${tr(0, 0)};opacity:1`],
      [3.8, tr(0, 0)], [4.8, tr(40, 30)], [5.85, `${tr(40, 30)};opacity:1`], [6.3, `${tr(110, 197, 0.12)};opacity:0`],
      [7.4, `${tr(110, 197, 0.12)};opacity:0`], [7.85, `${tr(40, 30)};opacity:1`], [8.6, `${tr(40, 30)};opacity:1`], [9, `${tr(40, 30)};opacity:0`],
    ],
    "s3-cap": [[0, "opacity:0;transform:scale(.8)"], [6.15, "opacity:0;transform:scale(.8)"], [6.4, "opacity:1;transform:scale(1)"], [7.4, "opacity:1;transform:scale(1)"], [7.6, "opacity:0;transform:scale(.8)"]],
  },
  snap: {
    "s4-cur": path([[0, 420, 330], [0.8, 380, 128], [1.0, 380, 128], [2.2, 156, 240], [2.5, 156, 240], [3.5, 290, 258], [4.2, 290, 258], [5.4, 628, 30], [5.6, 628, 30], [6.2, 615, 219], [6.9, 615, 219], [7.5, 593, 134], [8.8, 593, 134], [9.6, 420, 330]]),
    "s4-ring": pulses([1.0, 4.2, 8.2]),
    "s4-press": holds([[1.0, 2.3], [4.2, 5.5]]),
    "s4-b": [
      [0, geo(330, 120, 200, 140)], [1.0, geo(330, 120, 200, 140)], [2.2, geo(106, 232, 200, 140)], [2.3, geo(106, 232, 200, 140)],
      [2.65, geo(148, 20, 243, 378)], [8.3, geo(148, 20, 243, 378)], [8.75, geo(148, 20, 161, 378)], [9.3, geo(148, 20, 161, 378)], [9.8, geo(330, 120, 200, 140)],
    ],
    "s4-a": [
      [0, `${geo(146, 18, 494, 382)};border-color:transparent;border-radius:0px`], [2.3, `${geo(146, 18, 494, 382)};border-color:transparent;border-radius:0px`],
      [2.65, `${geo(396, 20, 242, 378)};border-color:var(--border-strong);border-radius:8px`], [5.5, geo(396, 20, 242, 378)], [5.9, geo(396, 211, 242, 187)],
      [8.3, geo(396, 211, 242, 187)], [8.75, geo(312, 20, 161, 378)], [9.3, `${geo(312, 20, 161, 378)};border-color:var(--border-strong);border-radius:8px`],
      [9.8, `${geo(146, 18, 494, 382)};border-color:transparent;border-radius:0px`],
    ],
    "s4-c": [
      [0, `${geo(250, 250, 170, 110)};opacity:0;transform:scale(.96)`], [3.0, `${geo(250, 250, 170, 110)};opacity:0;transform:scale(.96)`], [3.35, "opacity:1;transform:scale(1)"],
      [4.2, geo(250, 250, 170, 110)], [5.4, geo(588, 22, 170, 110)], [5.5, geo(588, 22, 170, 110)], [5.9, geo(396, 20, 242, 188)],
      [8.3, geo(396, 20, 242, 188)], [8.75, geo(476, 20, 162, 378)], [9.3, `${geo(476, 20, 162, 378)};opacity:1;transform:scale(1)`],
      [9.65, `${geo(476, 20, 162, 378)};opacity:0;transform:scale(.96)`], [10, `${geo(250, 250, 170, 110)};opacity:0;transform:scale(.96)`],
    ],
    "s4-pv": [
      [0, `${geo(148, 20, 243, 378)};opacity:0`], [1.6, `${geo(148, 20, 243, 378)};opacity:0`], [1.95, `${geo(148, 20, 243, 378)};opacity:1`],
      [2.3, `${geo(148, 20, 243, 378)};opacity:1`], [2.55, `${geo(148, 20, 243, 378)};opacity:0`], [3.0, `${geo(396, 20, 242, 188)};opacity:0`],
      [4.9, `${geo(396, 20, 242, 188)};opacity:0`], [5.2, `${geo(396, 20, 242, 188)};opacity:1`], [5.5, `${geo(396, 20, 242, 188)};opacity:1`],
      [5.75, `${geo(396, 20, 242, 188)};opacity:0`], [10, `${geo(148, 20, 243, 378)};opacity:0`],
    ],
    "s4-pick": [[0, "opacity:0;transform:translateY(6px) scale(.97)"], [6.7, "opacity:0;transform:translateY(6px) scale(.97)"], [7.0, "opacity:1;transform:translateY(0) scale(1)"], [8.2, "opacity:1;transform:translateY(0) scale(1)"], [8.45, "opacity:0;transform:translateY(4px) scale(.98)"]],
    "s4-tpl": [[0, `${bg("var(--surface-2)")};border-color:var(--border)`], [7.5, `${bg("var(--surface-2)")};border-color:var(--border)`], [7.65, `${bg(SOFT)};border-color:var(--accent)`], [8.45, `${bg(SOFT)};border-color:var(--accent)`], [8.6, `${bg("var(--surface-2)")};border-color:var(--border)`]],
  },
  dock: {
    // + 新建浏览器标签 → 右键 →「拆分」把它分到下方一组 → 复位。
    "s5-cur": path([[0, 330, 200], [0.8, 595, 27], [1.0, 595, 27], [1.6, 540, 67], [1.9, 540, 67], [2.6, 598, 27], [3.0, 598, 27], [3.5, 592, 66], [4.0, 592, 66], [4.9, 330, 200]]),
    "s5-ring": pulses([1.0, 1.9, 3.0, 4.0]),
    "s5-menu": [[0, "opacity:0;transform:translateY(-4px) scale(.98)"], [1.0, "opacity:0;transform:translateY(-4px) scale(.98)"], [1.22, "opacity:1;transform:translateY(0) scale(1)"], [1.9, "opacity:1;transform:translateY(0) scale(1)"], [2.08, "opacity:0;transform:translateY(-4px) scale(.98)"]],
    "s5-menu-hit": [[0, bg(CLEAR)], [1.5, bg(CLEAR)], [1.62, bg(SOFT)], [1.95, bg(SOFT)], [2.08, bg(CLEAR)]],
    "s5-rplus": [[0, X(0)], [1.95, X(0)], [2.25, X(31)], [4.05, X(31)], [4.35, X(0)]],
    "s5-rbrowser": [[0, "opacity:0;transform:scale(.85)"], [1.95, "opacity:0;transform:scale(.85)"], [2.2, "opacity:1;transform:scale(1)"], [4.05, "opacity:1;transform:scale(1)"], [4.3, "opacity:0;transform:scale(.85)"]],
    "s5-rgit": [[0, bg(SURF)], [1.95, bg(SURF)], [2.2, bg(CLEAR)], [4.05, bg(CLEAR)], [4.3, bg(SURF)]],
    "s5-rbody-browser": [[0, "opacity:0"], [2.0, "opacity:0"], [2.3, "opacity:1"], [4.05, "opacity:1"], [4.3, "opacity:0"]],
    "s5-ctx": [[0, "opacity:0;transform:scale(.97)"], [3.0, "opacity:0;transform:scale(.97)"], [3.2, "opacity:1;transform:scale(1)"], [4.0, "opacity:1;transform:scale(1)"], [4.15, "opacity:0;transform:scale(.97)"]],
    "s5-ctx-hit": [[0, bg(CLEAR)], [3.5, bg(CLEAR)], [3.6, bg(SOFT)], [4.05, bg(SOFT)], [4.15, bg(CLEAR)]],
    "s5-split": [[0, "opacity:0;transform:translateY(14px)"], [4.05, "opacity:0;transform:translateY(14px)"], [4.4, "opacity:1;transform:translateY(0)"], [5.8, "opacity:1;transform:translateY(0)"], [6.15, "opacity:0;transform:translateY(14px)"]],
  },
  dragAll: {
    // ① 右栏浏览器标签 → 拖进工作区右半 → 吸附成窗口，对话让到左半；
    // ② 侧栏会话 → 拖进底栏标签行 → 变成底栏标签；
    // ③ 浏览器窗口 → 拖回右栏 → 重新变成标签。拖动期间所有可放置位置亮出虚线框。
    "sd-cur": path([[0, 330, 240], [0.8, 598, 27], [1.0, 598, 27], [2.2, 430, 170], [2.4, 430, 170], [3.1, 70, 87], [3.4, 70, 87], [4.8, 262, 327], [5.0, 262, 327], [5.8, 400, 28], [6.2, 400, 28], [6.5, 420, 60], [7.4, 575, 140], [7.6, 575, 140], [8.6, 330, 240]]),
    "sd-ring": pulses([1.0, 3.4, 6.2]),
    "sd-press": holds([[1.0, 2.3], [3.4, 4.9], [6.2, 7.5]]),
    "sd-zones": [[0, "opacity:0"], [1.1, "opacity:0"], [1.35, "opacity:1"], [2.3, "opacity:1"], [2.5, "opacity:0"], [3.5, "opacity:0"], [3.75, "opacity:1"], [4.9, "opacity:1"], [5.1, "opacity:0"], [6.5, "opacity:0"], [6.75, "opacity:1"], [7.5, "opacity:1"], [7.7, "opacity:0"]],
    // ①
    "sd-rtab": [[0, `opacity:1;${bg(CLEAR)}`], [1.05, "opacity:1"], [1.2, "opacity:.28"], [2.3, "opacity:.28"], [2.45, `opacity:0;${bg(CLEAR)}`], [7.5, `opacity:0;${bg(SURF)}`], [7.75, `opacity:1;${bg(SURF)}`], [9.3, bg(SURF)], [9.6, bg(CLEAR)]],
    "sd-rplus": [[0, X(0)], [2.35, X(0)], [2.65, X(-31)], [7.5, X(-31)], [7.75, X(0)]],
    "sd-gtab": [[0, `${tr(583, 19)};opacity:0`], [1.0, `${tr(583, 19)};opacity:0`], [1.15, "opacity:1"], [2.2, tr(415, 162)], [2.3, "opacity:1"], [2.45, "opacity:0"]],
    "sd-pv": [[0, "opacity:0"], [1.75, "opacity:0"], [1.95, "opacity:1"], [2.3, "opacity:1"], [2.5, "opacity:0"]],
    "sd-convo": [[0, "width:374px"], [2.3, "width:374px"], [2.6, "width:187px"], [7.5, "width:187px"], [7.8, "width:374px"]],
    "sd-win": [
      [0, `${geo(335, 20, 183, 296)};opacity:0;transform:scale(.96)`], [2.3, `${geo(335, 20, 183, 296)};opacity:0;transform:scale(.96)`],
      [2.55, "opacity:1;transform:scale(1)"], [6.2, `${geo(335, 20, 183, 296)};opacity:1`], [6.5, `${geo(330, 52, 150, 110)};opacity:.92`],
      [7.4, `${geo(485, 132, 150, 110)};opacity:.92;transform:scale(1)`], [7.7, `${geo(485, 132, 150, 110)};opacity:0;transform:scale(.8)`],
      [10, `${geo(335, 20, 183, 296)};opacity:0;transform:scale(.96)`],
    ],
    // ②
    "sd-row": [[0, "opacity:0"], [3.35, "opacity:0"], [3.45, "opacity:1"], [4.9, "opacity:1"], [5.05, "opacity:0"]],
    "sd-grow": [[0, `${tr(50, 80)};opacity:0`], [3.45, `${tr(50, 80)};opacity:0`], [3.6, "opacity:1"], [4.8, tr(242, 320)], [4.9, "opacity:1"], [5.05, "opacity:0"]],
    "sd-dropb": [[0, "opacity:0"], [4.3, "opacity:0"], [4.5, "opacity:1"], [4.9, "opacity:1"], [5.1, "opacity:0"]],
    "sd-dropbar": [[0, "opacity:0"], [4.3, "opacity:0"], [4.5, "opacity:1"], [4.9, "opacity:1"], [5.1, "opacity:0"]],
    "sd-bterm": [[0, bg(SURF)], [4.9, bg(SURF)], [5.1, bg(CLEAR)], [9.3, bg(CLEAR)], [9.6, bg(SURF)]],
    "sd-btab": [[0, "opacity:0;transform:scale(.8)"], [4.9, "opacity:0;transform:scale(.8)"], [5.15, "opacity:1;transform:scale(1)"], [9.3, "opacity:1;transform:scale(1)"], [9.6, "opacity:0;transform:scale(.8)"]],
    "sd-bplus": [[0, X(0)], [4.9, X(0)], [5.2, X(32)], [9.3, X(32)], [9.6, X(0)]],
    "sd-bbody": [[0, "opacity:0"], [4.95, "opacity:0"], [5.25, "opacity:1"], [9.3, "opacity:1"], [9.6, "opacity:0"]],
    // ③
    "sd-dropr": [[0, "opacity:0"], [6.95, "opacity:0"], [7.15, "opacity:1"], [7.5, "opacity:1"], [7.7, "opacity:0"]],
    "sd-rgit": [[0, bg(SURF)], [7.5, bg(SURF)], [7.75, bg(CLEAR)], [9.3, bg(CLEAR)], [9.6, bg(SURF)]],
    "sd-rbody": [[0, "opacity:0"], [7.55, "opacity:0"], [7.85, "opacity:1"], [9.3, "opacity:1"], [9.6, "opacity:0"]],
  },
  toolRail: {
    "s6-cur": path([[0, 360, 300], [0.8, 560, 58], [1.3, 560, 58], [2.2, 607, 29], [2.8, 607, 29], [3.8, 621, 89], [4.3, 621, 89], [5.3, 380, 240], [5.9, 380, 240], [6.7, 607, 29], [7.1, 607, 29], [7.9, 360, 300]]),
    "s6-ring": pulses([1.0, 2.5, 4.0, 5.6, 6.9]),
    "s6-env": [
      [0, "height:58px;opacity:1;transform:translateX(0)"], [1.0, "height:58px"], [1.35, "height:20px"], [2.5, "opacity:1;transform:translateX(0)"],
      [2.85, "opacity:0;transform:translateX(16px)"], [6.9, "height:20px;opacity:0;transform:translateX(16px)"], [7.35, "height:58px;opacity:1;transform:translateX(0)"],
    ],
    "s6-env-body": [[0, "opacity:1"], [1.0, "opacity:1"], [1.2, "opacity:0"], [6.95, "opacity:0"], [7.3, "opacity:1"]],
    "s6-env-meter": [[0, "opacity:0"], [1.15, "opacity:0"], [1.4, "opacity:1"], [6.9, "opacity:1"], [7.2, "opacity:0"]],
    "s6-below": [[0, `${tr(0, 0)};opacity:1`], [1.0, tr(0, 0)], [1.35, tr(0, -38)], [2.5, `${tr(0, -38)};opacity:1`], [2.85, `${tr(16, -38)};opacity:0`], [6.9, `${tr(16, -38)};opacity:0`], [7.35, `${tr(0, 0)};opacity:1`]],
    "s6-icons": [[0, "opacity:0;transform:translateX(8px)"], [2.6, "opacity:0;transform:translateX(8px)"], [2.95, "opacity:1;transform:translateX(0)"], [6.9, "opacity:1;transform:translateX(0)"], [7.15, "opacity:0;transform:translateX(8px)"]],
    "s6-doc": [[0, "right:128px"], [2.5, "right:128px"], [2.9, "right:40px"], [6.9, "right:40px"], [7.3, "right:128px"]],
    "s6-pop": [[0, "opacity:0;transform:translateX(10px) scale(.97)"], [4.0, "opacity:0;transform:translateX(10px) scale(.97)"], [4.3, "opacity:1;transform:translateX(0) scale(1)"], [5.6, "opacity:1;transform:translateX(0) scale(1)"], [5.85, "opacity:0;transform:translateX(10px) scale(.97)"]],
    "s6-toggle": [[0, "opacity:0"], [2.45, "opacity:0"], [2.55, "opacity:1"], [2.95, "opacity:0"], [6.85, "opacity:0"], [6.95, "opacity:1"], [7.35, "opacity:0"]],
  },
  pin: {
    // 图钉 →「独立窗口并置顶」→ 任务栏出现它自己的图标 → 拖出应用边界 →
    // 最小化应用，窗口仍留在桌面 → 从任务栏恢复应用 → 图钉 →「不固定」收回。
    "s7-cur": path([[0, 250, 300], [0.8, 404, 128], [1.0, 404, 128], [1.5, 440, 225], [1.8, 440, 225], [2.6, 340, 128], [3.1, 340, 128], [4.3, 520, 200], [4.5, 520, 200], [5.1, 458, 23], [5.4, 458, 23], [6.3, 320, 385], [6.8, 320, 385], [7.6, 584, 200], [8.0, 584, 200], [8.4, 520, 227], [8.7, 520, 227], [9.7, 250, 300]]),
    "s7-ring": pulses([1.0, 1.8, 5.3, 6.8, 8.0, 8.65]),
    "s7-press": holds([[3.1, 4.4]]),
    "s7-menu1": [[0, "opacity:0;transform:translateY(-4px)"], [1.0, "opacity:0;transform:translateY(-4px)"], [1.22, "opacity:1;transform:translateY(0)"], [1.85, "opacity:1;transform:translateY(0)"], [2.0, "opacity:0;transform:translateY(-4px)"]],
    "s7-hit1": [[0, bg(CLEAR)], [1.5, bg(CLEAR)], [1.62, bg(SOFT)], [1.9, bg(SOFT)], [2.0, bg(CLEAR)]],
    "s7-win": [
      [0, `left:300px;top:120px;${IN_APP}`], [1.85, `left:300px;top:120px;${IN_APP}`], [2.25, LIFTED],
      [3.1, "left:300px;top:120px"], [4.3, "left:480px;top:192px"],
      [8.75, `left:480px;top:192px;${LIFTED}`], [9.55, `left:300px;top:120px;${IN_APP}`],
    ],
    "s7-badge": [[0, "opacity:0;transform:scale(.6)"], [1.95, "opacity:0;transform:scale(.6)"], [2.2, "opacity:1;transform:scale(1.35)"], [2.45, "opacity:1;transform:scale(1)"], [8.75, "opacity:1;transform:scale(1)"], [9.0, "opacity:0;transform:scale(.6)"]],
    "s7-tb": [[0, "opacity:0;transform:translateY(6px) scale(.6)"], [2.05, "opacity:0;transform:translateY(6px) scale(.6)"], [2.35, "opacity:1;transform:translateY(0) scale(1)"], [8.9, "opacity:1;transform:translateY(0) scale(1)"], [9.2, "opacity:0;transform:translateY(6px) scale(.6)"]],
    "s7-app": [[0, `${MIN_UP};opacity:1`], [5.35, `${MIN_UP};opacity:1`], [5.8, `${MIN_DOWN};opacity:0`], [6.85, `${MIN_DOWN};opacity:0`], [7.3, `${MIN_UP};opacity:1`]],
    "s7-appind": [[0, "opacity:1;width:10px"], [5.55, "opacity:1;width:10px"], [5.8, "opacity:.45;width:4px"], [6.95, "opacity:.45;width:4px"], [7.2, "opacity:1;width:10px"]],
    "s7-menu2": [[0, "opacity:0;transform:translateY(-4px)"], [8.0, "opacity:0;transform:translateY(-4px)"], [8.22, "opacity:1;transform:translateY(0)"], [8.7, "opacity:1;transform:translateY(0)"], [8.85, "opacity:0;transform:translateY(-4px)"]],
    "s7-hit2": [[0, bg(CLEAR)], [8.35, bg(CLEAR)], [8.45, bg(SOFT)], [8.75, bg(SOFT)], [8.85, bg(CLEAR)]],
  },
  shortcuts: {
    "s8-cur": [[0, `${tr(380, 260)};opacity:0`], [4.8, `${tr(380, 260)};opacity:0`], [5.0, "opacity:1"], [5.7, tr(107, 9)], [6.0, tr(107, 9)], [6.6, tr(150, 34)], [8.0, tr(150, 34)], [8.6, "opacity:1"], [8.8, `${tr(380, 260)};opacity:0`]],
    "s8-ring": pulses([6.0, 7.2]),
    "s8-k1": [[0, "opacity:0;transform:translateY(8px) scale(.96)"], [0.3, "opacity:0;transform:translateY(8px) scale(.96)"], [0.6, "opacity:1;transform:translateY(0) scale(1)"], [2.7, "opacity:1;transform:translateY(0) scale(1)"], [2.95, "opacity:0;transform:translateY(-6px) scale(.98)"]],
    "s8-press1": keyPresses([1.0, 2.0]),
    "s8-k2": [[0, "opacity:0;transform:translateY(8px) scale(.96)"], [3.0, "opacity:0;transform:translateY(8px) scale(.96)"], [3.3, "opacity:1;transform:translateY(0) scale(1)"], [4.9, "opacity:1;transform:translateY(0) scale(1)"], [5.15, "opacity:0;transform:translateY(-6px) scale(.98)"]],
    "s8-press2": keyPresses([3.6, 4.5]),
    "s8-side": [[0, "opacity:1;transform:translateX(0)"], [1.05, "opacity:1;transform:translateX(0)"], [1.45, "opacity:0;transform:translateX(-120px)"], [2.05, "opacity:0;transform:translateX(-120px)"], [2.45, "opacity:1;transform:translateX(0)"]],
    "s8-convo": [[0, "left:146px;height:300px"], [1.05, "left:146px"], [1.45, "left:26px"], [2.05, "left:26px"], [2.45, "left:146px"], [3.65, "height:300px"], [4.05, "height:382px"], [4.55, "height:382px"], [4.95, "height:300px"]],
    "s8-bottom": [[0, "left:146px;transform:translateY(0)"], [1.05, "left:146px"], [1.45, "left:26px"], [2.05, "left:26px"], [2.45, "left:146px"], [3.65, "transform:translateY(0)"], [4.05, "transform:translateY(84px)"], [4.55, "transform:translateY(84px)"], [4.95, "transform:translateY(0)"]],
    "s8-help": [[0, "opacity:0;transform:translateY(-4px)"], [6.0, "opacity:0;transform:translateY(-4px)"], [6.2, "opacity:1;transform:translateY(0)"], [7.2, "opacity:1;transform:translateY(0)"], [7.4, "opacity:0;transform:translateY(-4px)"]],
    "s8-helpfocus": [[0, "opacity:0"], [5.95, "opacity:0"], [6.05, "opacity:1"], [7.2, "opacity:1"], [7.4, "opacity:0"]],
    "s8-hit": [[0, bg(CLEAR)], [6.5, bg(CLEAR)], [6.65, bg(SOFT)], [7.25, bg(SOFT)], [7.4, bg(CLEAR)]],
    "s8-modal": [[0, "opacity:0;transform:scale(.94)"], [7.35, "opacity:0;transform:scale(.94)"], [7.65, "opacity:1;transform:scale(1)"], [8.4, "opacity:1;transform:scale(1)"], [8.7, "opacity:0;transform:scale(.97)"]],
  },
};

const pct = (seconds: number, duration: number): string => `${Math.min(100, Math.max(0, (seconds / duration) * 100)).toFixed(3)}%`;

function trackCss(scene: OnboardingSceneId, cls: string, keys: readonly Key[], duration: number): string {
  const sorted = [...keys].sort((a, b) => a[0] - b[0]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return "";
  const frames: Key[] = [];
  if (first[0] > 0) frames.push([0, first[1]]);
  frames.push(...sorted);
  if (last[0] < duration) frames.push([duration, last[1]]);
  const name = `ob-${scene}-${cls}`;
  // 关键帧按编排秒书写，duration 是编排时长；播放时长另乘 TEMPO，百分比不变。
  const body = frames.map(([t, css]) => `${pct(t, duration)}{${css}}`).join("");
  return `.ob-scene[data-scene="${scene}"] .${cls}{animation-name:${name}}@keyframes ${name}{${body}}`;
}

const cache = new Map<OnboardingSceneId, string>();

/** 场景的 keyframes CSS（静态字符串，按场景缓存）。 */
export function sceneKeyframes(scene: OnboardingSceneId): string {
  if (scene === "overview") return "";
  const hit = cache.get(scene);
  if (hit !== undefined) return hit;
  const duration = SCENE_DURATION[scene] / ONBOARDING_TEMPO;
  const css = Object.entries(TRACKS[scene]).map(([cls, keys]) => trackCss(scene, cls, keys, duration)).join("\n");
  cache.set(scene, css);
  return css;
}
