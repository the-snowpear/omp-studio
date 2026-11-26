import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { beginPointerDrag } from "../dock/pointerDrag";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import type { WebControlPosition } from "../settings/appSettings";
import { useWebAccessUi } from "./WebAccessContext";

export function WebControlBar({ children }: { children: ReactNode }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { position, setPosition, setVisible } = useWebAccessUi();
  const [point, setPoint] = useState(position);
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
    return point ?? { x: controls.current!.getBoundingClientRect().left - 8, y: box.top };
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

  const begin = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY }, previous = point, initial = origin();
    drag.current = beginPointerDrag(event, {
      onStart: () => setPoint(initial),
      onMove: next => setPoint({ x: initial.x + next.x - start.x, y: initial.y + next.y - start.y }),
      onDrop: next => {
        drag.current = null;
        commit.current = true;
        setPoint({ x: initial.x + next.x - start.x, y: initial.y + next.y - start.y });
      },
      onCancel: () => { drag.current = null; setPoint(previous); },
    });
  };
  const moveByKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Home") { event.preventDefault(); setPosition(null); setPoint(null); return; }
    const step = event.shiftKey ? 40 : 10;
    const offset = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!offset) return;
    event.preventDefault();
    const initial = origin();
    commit.current = true;
    setPoint({ x: initial.x + offset[0]!, y: initial.y + offset[1]! });
  };
  return <aside ref={bar} className={`web-access-strip${point ? " is-floating" : ""}`}
    style={point ? { left: point.x, top: point.y } : undefined} aria-label={zh ? "主机控制" : "Host control"}>
    <div className="web-control-bar" ref={controls}>
      <button type="button" className="web-control-drag" onPointerDown={begin} onKeyDown={moveByKey}
        aria-label={zh ? "移动 Web 控制条" : "Move Web control bar"}
        title={zh ? "拖动移动；方向键微调，Home 回到底部" : "Drag to move; use arrow keys to adjust, Home to dock at the bottom"}>
        <Icon name="grip" />
      </button>
      {children}
      <button type="button" className="web-control-dock" onClick={() => { setPosition(null); setPoint(null); }}
        aria-label={zh ? "控制条回到底部" : "Dock control bar at bottom"} title={zh ? "回到底部" : "Dock at bottom"}>
        <Icon name="panel-bottom" />
      </button>
      <button type="button" onClick={() => setVisible(false)}
        aria-label={zh ? "隐藏 Web 控制条" : "Hide Web control bar"}
        title={zh ? "隐藏后可从设置 › 常规与通知打开 Web 访问" : "Open Web access from Settings › General and notifications after hiding"}>
        <Icon name="x" />
      </button>
    </div>
  </aside>;
}
