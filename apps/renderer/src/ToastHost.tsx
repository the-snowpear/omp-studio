import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/** 提示停留时长（ms）。 */
const SHOW_MS = 2800;
/**
 * 浮出动画时长（ms）。需不小于 styles/tokens.css 的 --dur-toast（320ms），
 * 略留余量，保证动画播完后再清空宿主状态。
 */
const OUT_MS = 400;

/**
 * 页面浮窗提示：浮入 → 停留 → 浮出，不占用页面布局空间。
 * message 非空时渲染；停留 SHOW_MS 后进入浮出阶段，浮出结束回调 onDismiss
 * 清空宿主状态。message 变化（或相同文案再次出现）会重新浮入。
 */
export function ToastHost({
  message,
  icon = "info",
  placement = "bottom",
  onDismiss,
}: {
  message: string | null;
  icon?: string;
  placement?: "top" | "bottom";
  onDismiss: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!message) return;
    setLeaving(false);
    let outTimer = 0;
    const showTimer = window.setTimeout(() => {
      setLeaving(true);
      outTimer = window.setTimeout(() => dismissRef.current(), OUT_MS);
    }, SHOW_MS);
    return () => {
      window.clearTimeout(showTimer);
      if (outTimer) window.clearTimeout(outTimer);
    };
  }, [message]);

  if (!message) return null;
  return (
    <div className={`toast-wrap${placement === "top" ? " is-top" : ""}`} role="status" aria-live="polite">
      <div key={message} className={`toast${leaving ? " leaving" : ""}`}>
        <Icon name={icon} extra="sm" />
        <span>{message}</span>
      </div>
    </div>
  );
}
