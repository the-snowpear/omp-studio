import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { INSTANT_MS, MOTION_EASE, MOTION_MS, transitionMs } from "./motion";
import { avatarInitial } from "./settings/operatorProfile";

/**
 * 左下角身份块的头像是一个共享元素：展开时它在 rail 底部，收起后它在侧栏底栏。
 * 两边硬切换会眨一下 —— rail 收起的头几帧就把头像裁掉，底栏那只又跟着侧栏整体
 * 右移 56px 滑进来，两只根本不在同一个点上。
 *
 * 所以搬运期间由一个 fixed 的「幽灵」顶着：它从源头像的矩形起跳、落到目标头像的
 * 矩形，时长和缓动直接读 rail 自己的宽度过渡（同一条时钟）。两处真身在飞行期间
 * 都被 `:root.is-identity-floating` 藏起来，落地那一帧才显形，于是整个过程看起来
 * 就是「同一个头像原地缩小 / 长大了一下」。
 *
 * 全程走 DOM + WAAPI，不进 React state：`AppShell` 是棵很大的树，起点和落点各来
 * 一次重渲染，正好砸在动画的头尾两帧上，就是那种「最后抖一下」。
 */

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Source {
  readonly rect: Rect;
  /** 头像圆的字号比例（font-size / 直径）：幽灵按这个比例换算，落地时字形才对得上。 */
  readonly ratio: number;
}

const DEFAULT_RATIO = 0.4;
/** 真身在飞行期间隐身，靠这个根类名统一控制（规则写在 App.css）。 */
const FLOATING_CLASS = "is-identity-floating";

function elementRect(element: Element | null): Rect | null {
  if (element === null) return null;
  const box = element.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  return { x: box.left, y: box.top, w: box.width, h: box.height };
}

function glyphRatio(element: Element | null): number {
  if (element === null) return DEFAULT_RATIO;
  const size = Number.parseFloat(getComputedStyle(element).fontSize);
  const box = element.getBoundingClientRect();
  return Number.isFinite(size) && box.width > 1 ? size / box.width : DEFAULT_RATIO;
}

/** 底栏是「从底部长出来」的盒子：它挂上那一帧内容还压在下面，只有盒子的底边是稳的
 *  （margin-top:auto 钉在侧栏底）。所以落点要按「盒底 − 内容高 + 头像在内容里的偏移」
 *  换算，不能直接拿头像的 rect —— 否则幽灵会飞到侧栏底栏还没长出来的位置。 */
function footerTargetRect(footer: HTMLElement | null, avatar: HTMLElement | null): Rect | null {
  const base = elementRect(avatar);
  if (base === null || footer === null || avatar === null) return base;
  const body = avatar.closest<HTMLElement>(".sb-footer-body");
  if (body === null) return base;
  const bodyRect = body.getBoundingClientRect();
  return { ...base, y: footer.getBoundingClientRect().bottom - body.offsetHeight + (base.y - bodyRect.y) };
}

export function useIdentityFlight({
  collapsed,
  profile,
  railAvatarRef,
  footerAvatarRef,
  footerRef,
}: {
  readonly collapsed: boolean;
  readonly profile: { readonly displayName: string; readonly avatarSrc: string };
  /** rail 底部的头像圆。 */
  readonly railAvatarRef: RefObject<HTMLElement | null>;
  /** 侧栏底栏的头像圆；收起那一刻才挂载。 */
  readonly footerAvatarRef: RefObject<HTMLElement | null>;
  /** 底栏盒子本身（高度还在长的时候要用它的底边换算落点）。 */
  readonly footerRef: RefObject<HTMLElement | null>;
}): { readonly begin: (next: boolean) => void; readonly ghost: ReactNode } {
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const pendingRef = useRef<Source | null>(null);

  const stop = useCallback(() => {
    animationRef.current?.cancel();
    animationRef.current = null;
    ghostRef.current?.classList.remove("is-flying");
    document.documentElement.classList.remove(FLOATING_CLASS);
  }, []);

  /** 在切换折叠态「之前」调用：量的必须是还没动的那个头像。 */
  const begin = useCallback((next: boolean) => {
    const ghost = ghostRef.current;
    /* 飞行途中又被点了一下：从幽灵此刻的位置续上，别跳回任何一端的锚点。 */
    const interrupted = animationRef.current === null ? null : elementRect(ghost);
    if (interrupted !== null) {
      pendingRef.current = { rect: interrupted, ratio: glyphRatio(ghost) };
      stop();
      return;
    }
    const source = next ? railAvatarRef.current : footerAvatarRef.current;
    const rect = elementRect(source);
    pendingRef.current = rect === null ? null : { rect, ratio: glyphRatio(source) };
  }, [footerAvatarRef, railAvatarRef, stop]);

  useLayoutEffect(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null) return;
    const rail = document.querySelector<HTMLElement>(".app-rail");
    const duration = rail === null ? MOTION_MS.slow : transitionMs(rail);
    /* 减动效档把过渡压到 0s：此时不飞，直接换。 */
    if (duration < INSTANT_MS) return;
    const target = collapsed
      ? footerTargetRect(footerRef.current, footerAvatarRef.current)
      : elementRect(railAvatarRef.current);
    if (target === null) return;
    /* 底栏是「收起这一帧」才挂上的，此刻侧栏还整体压在 rail 右边，目标点要减去
       那段还没走完的位移，否则头像会飞到侧栏原来的位置。 */
    const shift = collapsed && rail !== null ? rail.getBoundingClientRect().width : 0;
    const from = pending.rect;
    const to = { ...target, x: target.x - shift };
    const ghost = ghostRef.current;
    if (ghost === null) return;

    ghost.style.left = `${from.x}px`;
    ghost.style.top = `${from.y}px`;
    ghost.style.width = `${from.w}px`;
    ghost.style.height = `${from.h}px`;
    ghost.style.fontSize = `${Math.round(from.w * pending.ratio * 100) / 100}px`;
    ghost.classList.add("is-flying");
    document.documentElement.classList.add(FLOATING_CLASS);

    const grow = to.w / from.w;
    const dx = to.x + to.w / 2 - (from.x + from.w / 2);
    const dy = to.y + to.h / 2 - (from.y + from.h / 2);
    /* 中途抬一点：两只头像之间只差几个像素，直线会显得「贴地拖」，给一点上行弧
       和微膨胀，读起来像被拿起来再放下。 */
    const lift = Math.min(3, Math.max(1.5, Math.abs(dy) * 0.4));
    const animation = ghost.animate(
      [
        { transform: "translate(0px, 0px) scale(1)" },
        { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - lift}px) scale(${1 + (grow - 1) * 0.45 + 0.035})`, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(${grow})` },
      ],
      {
        duration,
        easing: rail === null ? MOTION_EASE.nav : getComputedStyle(rail).transitionTimingFunction,
        fill: "both",
      },
    );
    animationRef.current = animation;
    animation.onfinish = () => stop();
    return () => stop();
  }, [collapsed, footerAvatarRef, footerRef, railAvatarRef, stop]);

  const ghost = createPortal(
    <div ref={ghostRef} className="identity-ghost" aria-hidden="true">
      {profile.avatarSrc
        ? <img src={profile.avatarSrc} alt="" draggable={false} />
        : <span>{avatarInitial(profile.displayName)}</span>}
    </div>,
    document.body,
  );

  return { begin, ghost };
}
