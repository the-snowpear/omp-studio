/**
 * 思考强度滑条：Composer 「思考强度」弹层、模型菜单「切换时的思考档位」共用。
 * pill 本身保持原样（标签 + 下拉箭头）。
 *
 * 形态是一根粗胶囊滑条：已选部分是按档位热度着色的光谱（Off 冷灰 → Low 蓝 →
 * High 紫 → Max 炽橙），条内有随档位加速的流动纹理、扫光和前沿辉光，把手是
 * 条内一根发光竖条。拖动时把手连续跟手并随速度拉宽，松手吸附到最近刻度；
 * 点击轨道 / 刻度标签直接跳档；← → / Home / End / PageUp / PageDown 键盘调节。
 *
 * 弹层的提交由调用方决定（真实模式 session.thinking.set，预览模式本地选择）。
 * 请求进行中弹层暂留用户刚选的档位，免得等 Runtime 回推前滑条弹回旧值；请求
 * 失败或回推结果不同时，以 `value`（Runtime 真值）为准。
 *
 * 光效只叠加：外发光、余烬、扫光、前沿辉光都乘 `--lux-k`，光效「关」时只剩
 * 光谱和流动纹理；L2 起由 perf/tiers.css 去掉这些层，L1 由 motion.css 静止循环。
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { motionMs } from "../motion";

import "./thinkingSlider.css";

export interface ThinkingLevelItem {
  readonly id: string;
  readonly label: string;
}

/** 档位身份 → 热度 0..1；未知档位按它在列表里的位置估算。 */
const LEVEL_HEAT: Readonly<Record<string, number>> = {
  keep: 0,
  off: 0,
  auto: 0.25,
  minimal: 1 / 6,
  low: 2 / 6,
  medium: 3 / 6,
  high: 4 / 6,
  xhigh: 5 / 6,
  max: 1,
};

const KNOWN_TONES = new Set(Object.keys(LEVEL_HEAT));
const HOT_HEAT = 4 / 6;

const DESC_KEYS: Readonly<Record<string, string>> = {
  off: "composer.thinkingDescOff",
  minimal: "composer.thinkingDescMinimal",
  low: "composer.thinkingDescLow",
  medium: "composer.thinkingDescMedium",
  high: "composer.thinkingDescHigh",
  xhigh: "composer.thinkingDescXhigh",
  max: "composer.thinkingDescMax",
};

/** Runtime 迟迟不回推（例如档位被就近吸附成别的值）时，最多暂留这么久就回到真值。 */
const PENDING_SETTLE_MS = 1500;
const EMBER_COUNT = 6;

function heatOf(id: string, index: number, count: number): number {
  return LEVEL_HEAT[id] ?? (count > 1 ? index / (count - 1) : 0);
}

function toneOf(id: string): string {
  return KNOWN_TONES.has(id) ? id : "medium";
}

function toneVar(id: string): string {
  return `var(--think-c-${toneOf(id)})`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 刻度 / 把手在轨道上的位置：两端各留半个条高，把手停在胶囊圆头的圆心上。 */
function trackAt(fraction: number): string {
  return `calc(var(--think-h) / 2 + ${fraction.toFixed(4)} * (100% - var(--think-h)))`;
}

/** 当前档位的配色变量：弹层、滑条、电平都从这里取。 */
function heatStyle(items: ReadonlyArray<ThinkingLevelItem>, index: number): CSSProperties {
  const item = items[index] ?? items[0];
  const count = items.length;
  const span = Math.max(1, count - 1);
  const stops = count > 1
    ? items.map((entry, at) => `${toneVar(entry.id)} ${trackAt(at / span)}`).join(", ")
    : `${toneVar(item?.id ?? "off")} 0%, ${toneVar(item?.id ?? "off")} 100%`;
  return {
    "--think-heat": toneVar(item?.id ?? "off"),
    "--think-k": (item ? heatOf(item.id, index, count) : 0).toFixed(3),
    "--think-spectrum": `linear-gradient(90deg, ${stops})`,
  } as CSSProperties;
}

/**
 * 粗滑条本体。`index` 是当前（已提交或暂留）档位；`onPick` 在松手、点击、
 * 键盘调节时给出新档位；`onScrub` 在拖动中报告把手下最近的档位（松手后报 null）。
 */
export function ThinkingTrack({
  items,
  index,
  label,
  onPick,
  onScrub,
  onEnter,
  compact = false,
  labels = !compact,
  busy = false,
  autoFocus = false,
}: {
  items: ReadonlyArray<ThinkingLevelItem>;
  index: number;
  label: string;
  onPick: (index: number) => void;
  onScrub?: (index: number | null) => void;
  onEnter?: () => void;
  compact?: boolean;
  labels?: boolean;
  busy?: boolean;
  autoFocus?: boolean;
}) {
  const count = items.length;
  const span = Math.max(1, count - 1);
  const [drag, setDrag] = useState<{ pos: number; moved: boolean } | null>(null);
  const [pingKey, setPingKey] = useState(0);

  const trackRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const stretchTimer = useRef<number | undefined>(undefined);
  const lastMove = useRef<{ x: number; t: number } | null>(null);
  const scrubRef = useRef(onScrub);
  scrubRef.current = onScrub;

  const nearest = (pos: number) => Math.round(clamp01(pos) * span);
  const committed = Math.min(Math.max(index, 0), Math.max(0, count - 1));
  const shownIndex = drag ? nearest(drag.pos) : committed;
  const shown = items[shownIndex] ?? items[0];
  const pos = drag
    ? (drag.moved ? clamp01(drag.pos) : nearest(drag.pos) / span)
    : (count > 1 ? committed / span : 0);
  const heat = shown ? heatOf(shown.id, shownIndex, count) : 0;
  const scrubbing = drag ? shownIndex : null;

  useEffect(() => { scrubRef.current?.(scrubbing); }, [scrubbing]);

  useEffect(() => {
    if (autoFocus) sliderRef.current?.focus({ preventScroll: true });
    return () => window.clearTimeout(stretchTimer.current);
  }, [autoFocus]);

  const pick = (target: number) => {
    const next = Math.min(Math.max(target, 0), count - 1);
    if (next < 0) return;
    setPingKey((key) => key + 1);
    onPick(next);
  };

  const posFromPointer = (clientX: number) => {
    const rail = railRef.current;
    const rect = rail?.getBoundingClientRect();
    if (!rect || rect.width <= rect.height) return pos;
    const cap = rect.height / 2;
    return clamp01((clientX - rect.left - cap) / (rect.width - rect.height));
  };

  const setStretch = (value: number) => {
    trackRef.current?.style.setProperty("--think-stretch", value.toFixed(3));
  };

  const resetDrag = () => {
    window.clearTimeout(stretchTimer.current);
    setStretch(0);
    setDrag(null);
    lastMove.current = null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || count < 2) return;
    event.preventDefault();
    sliderRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    lastMove.current = { x: event.clientX, t: event.timeStamp };
    setDrag({ pos: posFromPointer(event.clientX), moved: false });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const next = posFromPointer(event.clientX);
    const previous = lastMove.current;
    if (previous) {
      const speed = Math.abs(event.clientX - previous.x) / Math.max(1, event.timeStamp - previous.t);
      setStretch(Math.min(1, speed * 0.45));
      window.clearTimeout(stretchTimer.current);
      stretchTimer.current = window.setTimeout(() => setStretch(0), motionMs("tactile"));
    }
    lastMove.current = { x: event.clientX, t: event.timeStamp };
    if (drag.moved && nearest(next) !== nearest(drag.pos)) setPingKey((key) => key + 1);
    const width = railRef.current?.clientWidth ?? 200;
    setDrag({ pos: next, moved: drag.moved || Math.abs(next - drag.pos) * width > 2 });
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const target = nearest(drag.moved ? posFromPointer(event.clientX) : drag.pos);
    resetDrag();
    pick(target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 2, PageDown: -2,
    };
    let target: number | undefined;
    if (event.key in step) target = committed + step[event.key]!;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = count - 1;
    else if (event.key === "Enter" && onEnter) {
      event.preventDefault();
      onEnter();
      return;
    }
    if (target === undefined) return;
    event.preventDefault();
    if (Math.min(Math.max(target, 0), count - 1) !== committed) pick(target);
  };

  return (
    <div
      ref={trackRef}
      className="think-track"
      data-compact={compact || undefined}
      data-level={shown ? toneOf(shown.id) : "off"}
      data-hot={heat >= HOT_HEAT || undefined}
      data-dragging={drag?.moved || undefined}
      data-pressed={drag ? true : undefined}
      style={{ ...heatStyle(items, shownIndex), "--think-pos": pos.toFixed(4) } as CSSProperties}
    >
      <div
        ref={sliderRef}
        className="think-slider"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, count - 1)}
        aria-valuenow={shownIndex}
        aria-valuetext={shown?.label ?? ""}
        aria-busy={busy || undefined}
        aria-disabled={count < 2 || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={resetDrag}
        onLostPointerCapture={() => { if (drag) resetDrag(); }}
        onKeyDown={onKeyDown}
      >
        <div className="think-rail" ref={railRef}>
          <span className="think-glow" aria-hidden="true"><i /></span>
          <span className="think-fill" aria-hidden="true">
            <i className="think-flow" />
            <i className="think-shine" />
            <i className="think-edge" />
            <i className="think-gloss" />
          </span>
          {items.map((item, at) => (
            <i
              key={item.id}
              className="think-tick"
              data-on={at <= shownIndex || undefined}
              data-current={at === shownIndex || undefined}
              style={{ left: trackAt(count > 1 ? at / span : 0) }}
              aria-hidden="true"
            />
          ))}
          <span className="think-handle" aria-hidden="true">
            <i className="think-handle-core" />
            {pingKey > 0 ? <i key={pingKey} className="think-ping" /> : null}
            {shown?.id === "max" ? Array.from({ length: EMBER_COUNT }, (_, i) => (
              <i key={i} className="think-ember" style={{ "--i": i } as CSSProperties} />
            )) : null}
          </span>
        </div>
      </div>
      {labels ? (
        <div className="think-labels">
          {items.map((item, at) => (
            <button
              type="button"
              key={item.id}
              tabIndex={-1}
              className="think-label"
              data-on={at === shownIndex || undefined}
              style={{ left: trackAt(count > 1 ? at / span : 0), "--think-tick-c": toneVar(item.id) } as CSSProperties}
              onClick={() => pick(at)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ThinkingSliderPopover({
  open = true,
  items,
  value,
  unverified = false,
  onCommit,
  onClose,
}: {
  open?: boolean;
  items: ReadonlyArray<ThinkingLevelItem>;
  /** Runtime（或预览本地选择）的当前档位。 */
  value: string;
  unverified?: boolean;
  /** 返回是否成功；弹层保持打开，失败时回到 `value`。 */
  onCommit: (id: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const count = items.length;

  const [pending, setPending] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");

  const valueRef = useRef(value);
  valueRef.current = value;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const active = useRef(true);
  const inflight = useRef(false);
  const queued = useRef<string | null>(null);
  const settleTimer = useRef<number | undefined>(undefined);
  const shownRef = useRef<number>(-1);

  const found = items.findIndex((item) => item.id === (pending ?? value));
  const committedIndex = found < 0 ? 0 : found;
  const shownIndex = scrub ?? committedIndex;
  const shown = items[shownIndex] ?? items[0];

  // 读数换档时的方向：更高档从右侧进入，更低档从左侧进入。
  useLayoutEffect(() => {
    if (shownIndex === shownRef.current) return;
    setDir(shownIndex > shownRef.current ? "fwd" : "back");
    shownRef.current = shownIndex;
  }, [shownIndex]);

  // Runtime 回推了用户刚选的档位，暂留值就可以交还给真值。
  useEffect(() => {
    if (pending !== null && value === pending && !inflight.current) setPending(null);
  }, [value, pending]);

  useEffect(() => { if (!open) setScrub(null); }, [open]);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      queued.current = null;
      window.clearTimeout(settleTimer.current);
    };
  }, []);

  const send = (id: string) => {
    if (inflight.current) {
      queued.current = id;
      return;
    }
    inflight.current = true;
    setSyncing(true);
    window.clearTimeout(settleTimer.current);
    void commitRef.current(id)
      .catch(() => false)
      .then((ok) => {
        if (!active.current) return;
        inflight.current = false;
        const next = queued.current;
        queued.current = null;
        if (next !== null && next !== id) {
          send(next);
          return;
        }
        setSyncing(false);
        if (!ok || valueRef.current === id) {
          setPending(null);
          return;
        }
        settleTimer.current = window.setTimeout(() => setPending(null), PENDING_SETTLE_MS);
      });
  };

  const choose = (index: number) => {
    const item = items[index];
    if (!item || item.id === (pending ?? value)) return;
    setPending(item.id);
    send(item.id);
  };

  const descKey = shown ? DESC_KEYS[shown.id] : undefined;

  // Closing the dialog keeps already-picked levels queued for this conversation.
  // The owner key unmounts us when the conversation or model actually changes.
  if (!open) return null;

  return (
    <>
      <div className="approval-menu-backdrop" onClick={onClose} />
      <div
        className="cmp-menu think-pop"
        role="dialog"
        aria-label={t("composer.reasoningEffort")}
        style={heatStyle(items, shownIndex)}
      >
        <span className="think-aura" aria-hidden="true" />
        <div className="think-head">
          <span className="think-head-ic" aria-hidden="true"><Icon name="brain" extra="sm" /></span>
          <span className="think-head-title">{t("composer.reasoningEffort")}</span>
          {unverified ? <span className="chip gray xs">{t("composer.thinkingUnverified")}</span> : null}
          <span className="spacer" />
          {syncing ? (
            <span className="think-head-state is-syncing" role="status">
              <i aria-hidden="true" />{t("composer.thinkingApplying")}
            </span>
          ) : (
            <span className="think-head-state">
              {t("composer.thinkingStep", { current: String(shownIndex + 1), total: String(count) })}
            </span>
          )}
        </div>

        <div className="think-readout" aria-hidden="true">
          <b key={`v-${shown?.id}`} className="think-value" data-dir={dir}>{shown?.label ?? "—"}</b>
          <span key={`d-${shown?.id}`} className="think-desc" data-dir={dir}>
            {descKey ? t(descKey) : " "}
          </span>
        </div>

        <ThinkingTrack
          items={items}
          index={committedIndex}
          label={t("composer.reasoningEffort")}
          onPick={choose}
          onScrub={setScrub}
          onEnter={onClose}
          busy={syncing}
          autoFocus
        />
      </div>
    </>
  );
}
