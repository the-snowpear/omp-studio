/**
 * 身份稳定的事件回调。
 *
 * 组件里直接写的 handler 每次渲染都是新函数，传给 `memo` 子树等于每帧把 memo 击穿；
 * 而给它们套 `useCallback` 又会因为闭包里那些每帧都在变的值（disabled 原因、busy、
 * 临时闭包）而依赖不稳定。这里把最新实现存在 ref 里，对外只暴露一个恒定引用。
 *
 * 只能用于事件回调：返回的函数在渲染期间调用会读到上一次提交的实现。
 */

import { useCallback, useRef } from "react";

export function useStableCallback<Args extends readonly unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const ref = useRef(callback);
  ref.current = callback;
  return useCallback((...args: Args) => ref.current(...args), []);
}
