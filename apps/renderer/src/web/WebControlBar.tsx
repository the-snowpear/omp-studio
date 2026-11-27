import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { beginPointerDrag } from "../dock/pointerDrag";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import type { WebControlPosition } from "../settings/appSettings";
import { useWebAccessUi } from "./WebAccessContext";

/** Who holds write control: this device, another paired device, or nobody. */
export type WebControlHolder = { kind: "self" } | { kind: "other"; name: string } | { kind: "free" };

/** Floating frame inset (web.css `.web-access-strip.is-floating` padding):
    lifting the row out keeps the grip exactly under the pointer. */
const FLOAT_INSET = 4;

export function WebControlBar({ holder, demo, busy, onTakeControl, manageOpen, onManage, authorizationUrl }: {
  holder: WebControlHolder;
  demo: boolean;
  busy: boolean;
  onTakeControl: () => void;
  manageOpen: boolean;
  onManage: () => void;
  authorizationUrl?: string | undefined;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { position, setPosition, setVisible } = useWebAccessUi();
  const [point, setPoint] = useState(position);
  const [dragging, setDragging] = useState(false);
  const bar = useRef<HTMLElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const drag = useRef<ReturnType<typeof beginPointerDrag> | null>(null);
  const commit = useRef(false);

  const bounded = (next: WebControlPosition): WebControlPosition => {
    const element = bar.current!, view = element.ownerDocument.defaultView!;
    const box = element.getBoundingClientRect();
    const top = (element.ownerDocument.querySelector(".app-titlebar")?.getBoundingClientRect().bottom ?? 0) + 8;
    return {
      x: Math.max(8, Math.min(next.x, view.innerWidth - box.width - 8)),
      y: Math.max(top, Math.min(next.y, view.innerHeight - box.height - 8)),
    };
  };
  const origin = () => {
    const box = bar.current!.getBoundingClientRect();
    return point ?? { x: controls.current!.getBoundingClientRect().left - FLOAT_INSET, y: box.top };
  };

  useLayoutEffect(() => { setPoint(position); }, [position]);
  useLayoutEffect(() => {
    if (!point) return;
    const next = bounded(point);
    if (next.x !== point.x || next.y !== point.y) setPoint(next);
    if (commit.current) {
      commit.current = false;
      setPosition(next);
    }
  }, [point, setPosition]);
  useLayoutEffect(() => {
    const view = bar.current!.ownerDocument.defaultView!;
    const fit = () => setPoint(current => {
      if (!current) return current;
      const next = bounded(current);
      return next.x === current.x && next.y === current.y ? current : next;
    });
    const observer = new ResizeObserver(fit);
    observer.observe(bar.current!);
    view.addEventListener("resize", fit);
    return () => { drag.current?.cancel(); observer.disconnect(); view.removeEventListener("resize", fit); };
  }, []);

  const begin = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY }, previous = point, initial = origin();
    drag.current = beginPointerDrag(event, {
      onStart: () => { setDragging(true); setPoint(initial); },
      onMove: next => setPoint({ x: initial.x + next.x - start.x, y: initial.y + next.y - start.y }),
      onDrop: next => {
        drag.current = null;
        commit.current = true;
        setDragging(false);
        setPoint({ x: initial.x + next.x - start.x, y: initial.y + next.y - start.y });
      },
      onCancel: () => { drag.current = null; setDragging(false); setPoint(previous); },
    });
  };
  const dock = () => { setPosition(null); setPoint(null); };
  const moveByKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Home") { event.preventDefault(); dock(); return; }
    const step = event.shiftKey ? 40 : 10;
    const offset = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!offset) return;
    event.preventDefault();
    const initial = origin();
    commit.current = true;
    setPoint({ x: initial.x + offset[0]!, y: initial.y + offset[1]! });
  };

  const status = holder.kind === "self"
    ? <span className="web-control-text">{zh ? "此设备正在控制" : "You have control"}</span>
    : holder.kind === "other"
      ? <><span className="web-control-name">{holder.name}</span><span className="web-control-suffix">{zh ? " 正在控制" : " has control"}</span></>
      : <span className="web-control-text">{zh ? "可接管工作台" : "Workbench available"}</span>;
  const statusTip = holder.kind === "self"
    ? zh ? "此设备可以写入与使用终端" : "This device can make changes and type in terminals"
    : holder.kind === "other"
      ? zh ? `${holder.name} 正在控制；此设备只读` : `${holder.name} has control; this device is read-only`
      : zh ? "当前没有设备控制工作台" : "No device controls the workbench right now";
  const floating = point !== null;
  const primary = holder.kind !== "self" || Boolean(authorizationUrl);

  return <aside ref={bar} className={`web-access-strip${floating ? " is-floating" : ""}${dragging ? " is-dragging" : ""}`}
    style={floating ? { left: point.x, top: point.y } : undefined} aria-label={zh ? "主机控制" : "Host control"}>
    <div className="web-control-bar" ref={controls}>
      <div className="web-control-grab" onPointerDown={begin}>
        <button type="button" className="web-control-drag" onKeyDown={moveByKey}
          aria-label={zh ? "移动 Web 控制条" : "Move Web control bar"}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Home"
          data-tip={dragging ? undefined : zh
            ? "拖动以移动 · 方向键微调（Shift 加速）· Home 停靠底部 · 拖动中按 Esc 撤销"
            : "Drag to move · Arrow keys nudge (Shift for bigger steps) · Home docks · Esc cancels a drag"}>
          <Icon name="grip-dots" />
        </button>
        <div className="web-control-status" role="status" data-tip={dragging ? undefined : statusTip}>
          <span className="web-control-dot" data-state={holder.kind} aria-hidden="true" />
          <span className="web-control-label">{status}</span>
          {demo && <span className="chip gray xs web-control-demo">{zh ? "演示" : "Demo"}</span>}
        </div>
      </div>
      <div className="web-control-actions">
        {holder.kind !== "self" && <button type="button" className="web-control-action web-control-take" disabled={busy} onClick={onTakeControl}
          data-tip={zh ? "让此设备获得写入与终端输入权" : "Let this device make changes and type in terminals"}>
          {zh ? "接管" : "Take control"}
        </button>}
        {authorizationUrl && <a className="web-control-action web-control-signin" href={authorizationUrl} target="_blank" rel="noopener noreferrer"
          aria-label={zh ? "完成登录" : "Complete sign-in"}
          data-tip={zh ? "在浏览器中完成登录" : "Finish signing in in your browser"}>
          <span>{zh ? "完成登录" : "Complete sign-in"}</span><Icon name="external" />
        </a>}
        {primary && <span className="web-control-sep" aria-hidden="true" />}
        <button type="button" className="web-control-icon web-manage" onClick={onManage}
          aria-label={zh ? "Web 访问" : "Web access"} aria-haspopup="dialog" aria-expanded={manageOpen}
          data-tip={zh ? "设备与 Web 访问" : "Devices and Web access"}>
          <Icon name="globe" />
        </button>
        {floating && <button type="button" className="web-control-icon web-control-dock" onClick={dock}
          aria-label={zh ? "控制条回到底部" : "Dock control bar at bottom"}
          data-tip={zh ? "停靠到底部（Home）" : "Dock at bottom (Home)"}>
          <Icon name="panel-bottom" />
        </button>}
        <button type="button" className="web-control-icon web-control-hide" onClick={() => setVisible(false)}
          aria-label={zh ? "隐藏 Web 控制条" : "Hide Web control bar"}
          data-tip={zh ? "隐藏控制条 · 可在 设置 › 常规与通知 › Web 访问 中重新显示" : "Hide the control bar · Turn it back on in Settings › General and notifications › Web access"}>
          <Icon name="x" />
        </button>
      </div>
    </div>
  </aside>;
}
