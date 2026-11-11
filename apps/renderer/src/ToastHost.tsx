import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";
import { useSurfaceDocument } from "./dock/SurfaceContext";
import { MOTION_MS, MOTION_SLACK_MS } from "./motion";

/** 提示停留时长（ms）。 */
const SHOW_MS = 2800;
/** 浮出动画（--motion-toast-out，--dur-slow）播完后再清空宿主状态。 */
const OUT_MS = MOTION_MS.slow + MOTION_SLACK_MS;

/**
 * 页面浮窗提示：浮入 → 停留 → 浮出，不占用页面布局空间。
 * message 非空时渲染；停留 SHOW_MS 后进入浮出阶段，浮出结束回调 onDismiss
 * 清空宿主状态。message 变化（或相同文案再次出现）会重新浮入。
 * sticky 时一直留着，直到 message 换成非 sticky 或被宿主清掉（进行中状态用）。
 */
export function ToastHost({
  message,
  icon = "info",
  placement = "bottom",
  sticky = false,
  onDismiss,
}: {
  message: string | null;
  icon?: IconName;
  placement?: "top" | "bottom";
  sticky?: boolean;
  onDismiss: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const document = useSurfaceDocument();
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!message) return;
    setLeaving(false);
    if (sticky) return;
    let outTimer = 0;
    const showTimer = window.setTimeout(() => {
      setLeaving(true);
      outTimer = window.setTimeout(() => dismissRef.current(), OUT_MS);
    }, SHOW_MS);
    return () => {
      window.clearTimeout(showTimer);
      if (outTimer) window.clearTimeout(outTimer);
    };
  }, [message, sticky]);

  if (!message) return null;
  return createPortal(
    <div className={`toast-wrap${placement === "top" ? " is-top" : ""}`} role="status" aria-live="polite">
      <div key={message} className={`toast${sticky ? " is-busy" : ""}${leaving ? " leaving" : ""}`}>
        {sticky ? <span className="spinner" aria-hidden="true" /> : <Icon name={icon} extra="sm" />}
        <span>{message}</span>
      </div>
    </div>,
    document.body,
  );
}
