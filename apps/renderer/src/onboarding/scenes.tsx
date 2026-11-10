/**
 * 教程舞台里的低保真动画场景。
 *
 * 每个场景都画在 640×400 的固定画布上（外层按容器宽度整体缩放），元素用
 * 绝对定位，动画全部是 CSS keyframes（见 onboarding.css 中同名前缀）。
 * 低保真只用形状与图标，不放文字，跨语言通用。
 *
 * 约定：元素的「非动画样式」就是该场景的代表画面。减少动效档位
 * （`data-perf-tier~="L1"`）会把动画压成 0.01ms 一次，届时只显示这一帧，
 * 所以光标、幽灵、弹层的基础样式都是隐藏的。
 */

import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "../icons";

export type OnboardingSceneId = "overview" | "windows" | "snap" | "dock" | "dragAll" | "toolRail" | "pin" | "shortcuts";

/**
 * 整体节奏：timelines.ts 里的关键帧和下面的时长都按「编排秒」书写，
 * 播放时统一乘以这个系数。想整体调快调慢只改这里。
 */
export const ONBOARDING_TEMPO = 0.72;

const BASE_DURATION: Readonly<Record<OnboardingSceneId, number>> = {
  overview: 10,
  windows: 9,
  snap: 10,
  dock: 6.5,
  dragAll: 10,
  toolRail: 8,
  pin: 10.5,
  shortcuts: 9,
};

/** 每个场景一轮动画的实际时长（秒），文字面板里的同步高亮也用它。 */
export const SCENE_DURATION: Readonly<Record<OnboardingSceneId, number>> = Object.fromEntries(
  Object.entries(BASE_DURATION).map(([id, seconds]) => [id, seconds * ONBOARDING_TEMPO]),
) as Record<OnboardingSceneId, number>;

const at = (x: number, y: number, w: number, h: number): CSSProperties => ({ left: x, top: y, width: w, height: h });

function Ln({ w, tone, style }: { w: number | string; tone?: "accent" | "strong" | "faint"; style?: CSSProperties }) {
  return <i className={`ob-ln${tone ? ` is-${tone}` : ""}`} style={{ width: w, ...style }} />;
}

function Ic({ name, className }: { name: IconName; className?: string }) {
  return <span className={`ob-ic${className ? ` ${className}` : ""}`}><Icon name={name} /></span>;
}

function Cursor({ className, children }: { className: string; children?: ReactNode }) {
  return (
    <div className={`ob-cursor ob-a ${className}`} aria-hidden="true">
      <svg viewBox="0 0 16 22" width="15" height="21">
        <path d="M1.5 1.5v16.2l4.1-3.9 2.6 6 2.7-1.2-2.6-5.9h5.9z" />
      </svg>
      {children}
    </div>
  );
}

/** 光标上的点击涟漪；时间点由各场景的 keyframes 决定。 */
function Ring({ className }: { className: string }) {
  return <i className={`ob-ring ob-a ${className}`} />;
}

/** 按住拖动时光标尖端的实心点。 */
function Press({ className }: { className: string }) {
  return <i className={`ob-press ob-a ${className}`} />;
}

// ---- 低保真工作台积木 -------------------------------------------------------

function Titlebar({ helpClass }: { helpClass?: string }) {
  return (
    <div className="ob-titlebar" style={at(0, 0, 640, 18)}>
      <i className="ob-logo" />
      <Ln w={14} style={{ left: 30 }} />
      <Ln w={14} style={{ left: 52 }} />
      <Ln w={14} style={{ left: 74 }} />
      <Ln w={16} style={{ left: 99 }} />
      {helpClass ? <i className={`ob-menu-focus ob-a ${helpClass}`} style={at(94, 3, 27, 12)} /> : null}
      <span className="ob-caption"><i /><i /><i /></span>
    </div>
  );
}

const RAIL_ICONS: readonly IconName[] = ["workbench", "home", "history", "package", "server", "settings"];

function Rail() {
  return (
    <div className="ob-rail" style={at(0, 18, 26, 382)}>
      <i className="ob-rail-ind" />
      {RAIL_ICONS.map((name, index) => (
        <span key={name} className="ob-rail-ic" style={{ top: 26 + index * 22 }}><Icon name={name} /></span>
      ))}
      <i className="ob-avatar" style={{ left: 6, top: 360 }} />
    </div>
  );
}

function SidebarRows({ activeRow = 0, rowClass }: { activeRow?: number; rowClass?: string }) {
  const rows = [0, 1, 2, 3, 4];
  return (
    <>
      <div className="ob-side-head" style={at(8, 10, 104, 10)}>
        <Ic name="folder" /><Ln w={52} tone="strong" />
      </div>
      {rows.map((row) => (
        <div key={row} className={`ob-side-row${row === activeRow ? " is-active" : ""}`} style={at(6, 26 + row * 18, 108, 14)}>
          <i className="ob-dot" /><Ln w={[64, 52, 70, 44, 58][row]!} />
        </div>
      ))}
      {rowClass ? <i className={`ob-side-lift ob-a ${rowClass}`} style={at(6, 62, 108, 14)} /> : null}
      <div className="ob-side-head" style={at(8, 126, 104, 10)}>
        <Ic name="folder" /><Ln w={40} tone="strong" />
      </div>
      {[0, 1].map((row) => (
        <div key={row} className="ob-side-row" style={at(6, 142 + row * 18, 108, 14)}>
          <i className="ob-dot" /><Ln w={[48, 60][row]!} />
        </div>
      ))}
    </>
  );
}

function Sidebar({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div className={`ob-sidebar${className ? ` ${className}` : ""}`} style={style ?? at(26, 18, 120, 382)}>
      <SidebarRows />
    </div>
  );
}

/** 对话正文 + 输入框；宽高随父容器变化，便于动画改窗口尺寸。 */
function Convo({ header = true, inset = 0, docClass, mini = false }: { header?: boolean; inset?: number; docClass?: string; mini?: boolean }) {
  return (
    <div className={`ob-convo${mini ? " is-mini" : ""}`}>
      {header ? (
        <div className="ob-convo-head">
          <Ln w={64} tone="strong" />
          <Ln w={28} tone="faint" />
          <span className="ob-head-btns"><Ic name="panel" /><Ic name="more" /></span>
        </div>
      ) : null}
      <div className={`ob-convo-doc${docClass ? ` ob-a ${docClass}` : ""}`} style={{ right: inset }}>
        <i className="ob-bubble" />
        <Ln w="66%" />
        <Ln w="54%" />
        <Ln w="72%" />
        <i className="ob-code" />
        <Ln w="48%" />
        <div className="ob-composer"><i className="ob-send" /></div>
      </div>
    </div>
  );
}

function TermBody() {
  return (
    <div className="ob-term">
      <Ln w="42%" tone="accent" />
      <Ln w="70%" />
      <Ln w="58%" />
      <Ln w="36%" tone="accent" />
      <Ln w="64%" />
    </div>
  );
}

function GitBody() {
  return (
    <div className="ob-git">
      {(["g", "a", "r", "g", "a"] as const).map((tone, index) => (
        <div key={index} className="ob-git-row"><i className={`ob-chip is-${tone}`} /><Ln w={[60, 46, 54, 40, 50][index]!} /></div>
      ))}
    </div>
  );
}

function BrowserBody() {
  return (
    <div className="ob-browser">
      <div className="ob-addr"><Ic name="globe" /><Ln w="55%" tone="faint" /></div>
      <i className="ob-hero" />
      <div className="ob-cards"><i /><i /></div>
    </div>
  );
}

type WinKind = "convo" | "term" | "git" | "browser";
const WIN_ICON: Readonly<Record<WinKind, IconName>> = { convo: "message", term: "terminal", git: "branch", browser: "globe" };

function Win({ kind, className, style, badge }: { kind: WinKind; className: string; style: CSSProperties; badge?: ReactNode }) {
  return (
    <div className={`ob-win ob-a ${className}`} style={style}>
      <div className="ob-win-bar">
        <Ic name={WIN_ICON[kind]} />
        <Ln w={kind === "convo" ? 54 : 30} tone="strong" />
        {badge}
        <span className="ob-win-btns">
          <Ic name="pin" className="is-pin" />
          <Ic name="minimize" />
          <Ic name="maximize" />
          <Ic name="x" />
        </span>
      </div>
      <div className="ob-win-body">
        {kind === "convo" ? <Convo header={false} mini /> : kind === "term" ? <TermBody /> : kind === "git" ? <GitBody /> : <BrowserBody />}
      </div>
    </div>
  );
}

function Tabs({ items, active, style }: { items: readonly IconName[]; active: number; style: CSSProperties }) {
  return (
    <div className="ob-tabrow" style={style}>
      {items.map((name, index) => (
        <span key={name} className={`ob-tab${index === active ? " is-active" : ""}`}><Ic name={name} /></span>
      ))}
    </div>
  );
}

// ---- 场景 -------------------------------------------------------------------

/** 概览五个区域依次高亮；文字面板的图例用同一组负延迟。 */
export function overviewSlotDelay(index: number): string {
  const duration = SCENE_DURATION.overview;
  return `${(index * duration) / 5 - duration}s`;
}

function OverviewScene() {
  const slots: readonly { readonly key: string; readonly rects: readonly CSSProperties[] }[] = [
    { key: "rail", rects: [at(1, 19, 24, 380)] },
    { key: "side", rects: [at(27, 19, 118, 380)] },
    { key: "convo", rects: [at(147, 19, 284, 298)] },
    { key: "tools", rects: [at(434, 42, 82, 138)] },
    { key: "docks", rects: [at(521, 19, 118, 380), at(147, 319, 372, 80)] },
  ];
  return (
    <>
      <Titlebar />
      <Rail />
      <Sidebar />
      <div className="ob-region" style={at(146, 18, 374, 300)}>
        <Convo inset={92} />
        <div className="ob-card" style={at(292, 30, 74, 40)}><Ic name="folder" /><Ln w={34} tone="strong" /><Ln w={50} style={{ top: 22 }} /><i className="ob-bar" /></div>
        <div className="ob-card" style={at(292, 76, 74, 26)}><Ic name="layers" /><Ln w={30} tone="strong" /><i className="ob-meter" /></div>
        <div className="ob-card" style={at(292, 108, 74, 50)}><Ic name="bot" /><Ln w={30} tone="strong" /><Ln w={44} style={{ top: 24 }} /><Ln w={38} style={{ top: 34 }} /></div>
      </div>
      <div className="ob-dock-r" style={at(520, 18, 120, 382)}>
        <Tabs items={["branch", "changes", "terminal"]} active={0} style={at(2, 1, 116, 16)} />
        <div className="ob-dock-body" style={at(0, 18, 120, 364)}><GitBody /></div>
      </div>
      <div className="ob-dock-b" style={at(146, 318, 374, 82)}>
        <Tabs items={["terminal", "console", "alert"]} active={0} style={at(4, 1, 200, 16)} />
        <div className="ob-dock-body" style={at(0, 18, 374, 64)}><TermBody /></div>
      </div>
      {slots.map((slot, index) => (
        <div key={slot.key} className="ob-hl ob-a s1-slot" style={{ animationDelay: overviewSlotDelay(index) }}>
          {slot.rects.map((rect, rectIndex) => (
            <div key={rectIndex} className="ob-hl-rect" style={rect}>
              {rectIndex === 0 ? <b className="ob-hl-badge">{index + 1}</b> : null}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function WindowsScene() {
  return (
    <>
      <Titlebar />
      <Rail />
      <div className="ob-sidebar" style={at(26, 18, 120, 382)}>
        <SidebarRows rowClass="s3-row" />
      </div>
      <div className="ob-region" style={at(146, 18, 494, 382)}><Convo /></div>
      <div className="ob-ghost-row ob-a s3-ghost" style={at(0, 0, 92, 14)}><i className="ob-dot" /><Ln w={56} /></div>
      <div className="ob-preview ob-a s3-preview" style={at(0, 0, 210, 148)} />
      <Win kind="convo" className="s3-win" style={at(250, 100, 210, 148)} />
      <div className="ob-capsule ob-a s3-cap" style={at(420, 362, 90, 18)}><Ic name="message" /><Ln w={44} /></div>
      <Cursor className="s3-cur"><Ring className="s3-ring" /><Press className="s3-press" /></Cursor>
    </>
  );
}

function SnapScene() {
  return (
    <>
      <Titlebar />
      <Rail />
      <Sidebar />
      <div className="ob-snapzone" style={at(146, 18, 494, 382)} />
      <div className="ob-split ob-a s4-a" style={at(146, 18, 494, 382)}>
        <div className="ob-split-bar">
          <Ic name="message" /><Ln w={56} tone="strong" />
          <span className="ob-win-btns"><Ic name="minimize" /><Ic name="maximize" className="is-max" /><Ic name="x" /></span>
        </div>
        <div className="ob-split-body"><Convo header={false} /></div>
      </div>
      <i className="ob-snap-pv ob-a s4-pv" style={at(148, 20, 243, 378)} />
      <Win kind="convo" className="s4-b" style={at(330, 120, 200, 140)} />
      <Win kind="term" className="s4-c" style={at(250, 250, 170, 110)} />
      <div className="ob-pop ob-a s4-pick" style={at(462, 108, 160, 94)}>
        {["halves", "two-one", "thirds", "left-stack", "right-stack", "quad"].map((layout, index) => (
          <span key={layout} className={`ob-tpl is-${layout}${index === 2 ? " ob-a s4-tpl" : ""}`}><i /><i /><i /><i /></span>
        ))}
      </div>
      <Cursor className="s4-cur"><Ring className="s4-ring" /><Press className="s4-press" /></Cursor>
    </>
  );
}

function DockScene() {
  return (
    <>
      <Titlebar />
      <Rail />
      <Sidebar />
      <div className="ob-region" style={at(146, 18, 374, 300)}><Convo /></div>
      <div className="ob-dock-r" style={at(520, 18, 120, 382)}>
        <div className="ob-tabrow is-abs" style={at(2, 1, 116, 16)}>
          <span className="ob-tab is-active ob-a s5-rgit" style={{ left: 0 }}><Ic name="branch" /></span>
          <span className="ob-tab" style={{ left: 31 }}><Ic name="changes" /></span>
          <span className="ob-tab is-active ob-a s5-rbrowser" style={{ left: 62 }}><Ic name="globe" /></span>
          <span className="ob-plus ob-a s5-rplus" style={{ left: 66 }}><Icon name="plus" /></span>
        </div>
        <div className="ob-dock-body" style={at(0, 18, 120, 364)}>
          <GitBody />
          <div className="ob-a s5-rbody-browser"><BrowserBody /></div>
        </div>
        <div className="ob-dock-split ob-a s5-split" style={at(0, 196, 120, 186)}>
          <div className="ob-tabrow" style={at(2, 1, 116, 16)}><span className="ob-tab is-active"><Ic name="globe" /></span></div>
          <div className="ob-dock-body" style={at(0, 18, 120, 168)}><BrowserBody /></div>
        </div>
      </div>
      <div className="ob-dock-b" style={at(146, 318, 374, 82)}>
        <Tabs items={["terminal", "console", "alert"]} active={0} style={at(4, 1, 200, 16)} />
        <div className="ob-dock-body" style={at(0, 18, 374, 64)}><TermBody /></div>
      </div>
      <div className="ob-pop ob-a s5-menu" style={at(470, 40, 160, 150)}>
        {([
          ["is-a", ["globe", "message"]],
          ["is-b", ["branch", "file-tree"]],
          ["is-c", ["clock", "bot"]],
        ] as const).map(([hue, icons]) => (
          <div key={hue} className="ob-menu-group">
            <i className={`ob-menu-cat ${hue}`} />
            {icons.map((name) => (
              <div key={name} className={`ob-menu-row${name === "globe" ? " ob-a s5-menu-hit" : ""}`}><Ic name={name} /><Ln w={56} /></div>
            ))}
          </div>
        ))}
      </div>
      <div className="ob-pop ob-ctx ob-a s5-ctx" style={at(556, 38, 80, 74)}>
        {[46, 54, 38, 50].map((w, index) => <div key={index} className={`ob-menu-row${index === 1 ? " ob-a s5-ctx-hit" : ""}`}><Ln w={w} /></div>)}
      </div>
      <Cursor className="s5-cur"><Ring className="s5-ring" /></Cursor>
    </>
  );
}

/** 万物皆可拖拽：标签 → 吸附窗口，会话 → 底栏标签，窗口 → 右栏标签。 */
function DragAllScene() {
  return (
    <>
      <Titlebar />
      <Rail />
      <div className="ob-sidebar" style={at(26, 18, 120, 382)}>
        <SidebarRows rowClass="sd-row" />
      </div>
      <div className="ob-region ob-a sd-convo" style={at(146, 18, 187, 300)}><Convo /></div>
      <div className="ob-dock-r" style={at(520, 18, 120, 382)}>
        <div className="ob-tabrow is-abs" style={at(2, 1, 116, 16)}>
          <span className="ob-tab is-active ob-a sd-rgit" style={{ left: 0 }}><Ic name="branch" /></span>
          <span className="ob-tab" style={{ left: 31 }}><Ic name="changes" /></span>
          <span className="ob-tab ob-a sd-rtab" style={{ left: 62 }}><Ic name="globe" /></span>
          <span className="ob-plus ob-a sd-rplus" style={{ left: 97 }}><Icon name="plus" /></span>
        </div>
        <div className="ob-dock-body" style={at(0, 18, 120, 364)}>
          <GitBody />
          <div className="ob-a sd-rbody"><BrowserBody /></div>
        </div>
      </div>
      <div className="ob-dock-b" style={at(146, 318, 374, 82)}>
        <div className="ob-tabrow is-abs" style={at(4, 1, 260, 16)}>
          <span className="ob-tab ob-a sd-bterm" style={{ left: 0 }}><Ic name="terminal" /></span>
          <span className="ob-tab" style={{ left: 32 }}><Ic name="console" /></span>
          <span className="ob-tab is-active ob-a sd-btab" style={{ left: 64 }}><Ic name="message" /></span>
          <span className="ob-plus ob-a sd-bplus" style={{ left: 66 }}><Icon name="plus" /></span>
        </div>
        <div className="ob-dock-body" style={at(0, 18, 374, 64)}>
          <TermBody />
          <div className="ob-a sd-bbody"><Convo header={false} mini /></div>
        </div>
      </div>
      <div className="ob-a sd-zones">
        <i className="ob-zone" style={at(150, 22, 179, 292)} />
        <i className="ob-zone" style={at(337, 22, 179, 292)} />
        <i className="ob-zone" style={at(150, 321, 366, 76)} />
        <i className="ob-zone" style={at(523, 21, 114, 376)} />
      </div>
      <i className="ob-snap-pv ob-a sd-pv" style={at(335, 20, 183, 296)} />
      <i className="ob-drop ob-a sd-dropb" style={at(146, 318, 374, 82)} />
      <i className="ob-drop-bar ob-a sd-dropbar" style={at(212, 320, 3, 14)} />
      <i className="ob-drop ob-a sd-dropr" style={at(520, 18, 120, 382)} />
      <Win kind="browser" className="sd-win" style={at(335, 20, 183, 296)} />
      <div className="ob-tab ob-ghost-tab ob-a sd-gtab" style={at(0, 0, 30, 16)}><Ic name="globe" /></div>
      <div className="ob-ghost-row ob-a sd-grow" style={at(0, 0, 92, 14)}><i className="ob-dot" /><Ln w={56} /></div>
      <Cursor className="sd-cur"><Ring className="sd-ring" /><Press className="sd-press" /></Cursor>
    </>
  );
}

function ToolRailScene() {
  return (
    <>
      <Titlebar />
      <Rail />
      <Sidebar />
      <div className="ob-region" style={at(146, 18, 494, 382)}><Convo inset={128} docClass="s6-doc" /></div>
      <i className="ob-head-hit ob-a s6-toggle" style={at(608, 21, 16, 16)} />
      <div className="ob-card ob-a s6-env" style={at(512, 48, 120, 58)}>
        <Ic name="folder" /><Ln w={44} tone="strong" />
        <i className="ob-chev" />
        <div className="ob-a s6-env-body"><Ln w={84} style={{ top: 24 }} /><Ln w={60} style={{ top: 36 }} /><i className="ob-bar" /></div>
        <i className="ob-mini-meter ob-a s6-env-meter" />
      </div>
      <div className="ob-a s6-below">
        <div className="ob-card" style={at(512, 112, 120, 44)}><Ic name="layers" /><Ln w={40} tone="strong" /><i className="ob-meter" style={{ top: 26 }} /></div>
        <div className="ob-card" style={at(512, 162, 120, 64)}>
          <Ic name="bot" /><Ln w={38} tone="strong" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="ob-agent-row" style={{ top: 24 + row * 12 }}><i className={`ob-dot${row === 0 ? " is-live" : ""}`} /><Ln w={[60, 48, 54][row]!} /></div>
          ))}
        </div>
      </div>
      <div className="ob-a s6-icons" style={at(610, 48, 24, 90)}>
        <span className="ob-rail-chip"><Icon name="folder" /></span>
        <span className="ob-rail-chip is-ring"><Icon name="layers" /></span>
        <span className="ob-rail-chip"><Icon name="bot" /></span>
      </div>
      <div className="ob-pop ob-a s6-pop" style={at(462, 64, 140, 96)}>
        <Ic name="layers" /><Ln w={50} tone="strong" />
        <svg className="ob-donut" viewBox="0 0 36 36" width="46" height="46" aria-hidden="true">
          <circle cx="18" cy="18" r="14" pathLength="100" className="is-track" />
          <circle cx="18" cy="18" r="14" pathLength="100" className="is-a" strokeDasharray="34 66" />
          <circle cx="18" cy="18" r="14" pathLength="100" className="is-b" strokeDasharray="18 82" strokeDashoffset="-34" />
          <circle cx="18" cy="18" r="14" pathLength="100" className="is-c" strokeDasharray="10 90" strokeDashoffset="-52" />
        </svg>
        <div className="ob-legend-rows"><Ln w={40} /><Ln w={30} /><Ln w={36} /></div>
      </div>
      <Cursor className="s6-cur"><Ring className="s6-ring" /></Cursor>
    </>
  );
}

function PinMenu({ className, style, hitRow, hitClass }: { className: string; style: CSSProperties; hitRow: number; hitClass: string }) {
  const rows: readonly IconName[] = ["pin", "folder", "workbench", "external", "arrow-u"];
  return (
    <div className={`ob-pop ob-a ${className}`} style={style}>
      {rows.map((name, index) => (
        <div key={name} className={`ob-menu-row${index === hitRow ? ` ob-a ${hitClass}` : ""}`}><Ic name={name} /><Ln w={[40, 58, 50, 46, 62][index]!} /></div>
      ))}
    </div>
  );
}

/**
 * 独立窗口：图钉选「独立窗口并置顶」→ 任务栏多出它自己的图标 → 拖出应用边界 →
 * 应用最小化后它仍留在桌面 → 选「不固定」收回应用。
 */
function PinScene() {
  return (
    <>
      <i className="ob-desktop" />
      <div className="ob-app ob-a s7-app" style={at(16, 14, 480, 344)}>
        <div className="ob-titlebar" style={at(0, 0, 480, 18)}>
          <i className="ob-logo" /><Ln w={14} style={{ left: 30 }} /><Ln w={14} style={{ left: 52 }} /><Ln w={14} style={{ left: 74 }} />
          <span className="ob-caption"><i /><i /><i /></span>
        </div>
        <div className="ob-rail" style={at(0, 18, 26, 326)}>
          {RAIL_ICONS.slice(0, 4).map((name, index) => <span key={name} className="ob-rail-ic" style={{ top: 8 + index * 22 }}><Icon name={name} /></span>)}
        </div>
        <div className="ob-sidebar" style={at(26, 18, 110, 326)}><SidebarRows /></div>
        <div className="ob-region" style={at(136, 18, 344, 326)}><Convo /></div>
      </div>
      <div className="ob-taskbar" style={at(0, 370, 640, 30)}>
        <span className="ob-tb-ic" style={{ left: 286 }}><Icon name="folder" /></span>
        <span className="ob-tb-ic" style={{ left: 310 }}><i className="ob-logo" /><i className="ob-tb-ind ob-a s7-appind" /></span>
        <span className="ob-tb-ic is-accent ob-a s7-tb" style={{ left: 334 }}><Icon name="branch" /><i className="ob-tb-ind" /></span>
      </div>
      <Win
        kind="git"
        className="s7-win"
        style={at(480, 192, 150, 116)}
        badge={<i className="ob-pin-badge ob-a s7-badge"><Icon name="arrow-u" /></i>}
      />
      <PinMenu className="s7-menu1" style={at(376, 138, 140, 108)} hitRow={4} hitClass="s7-hit1" />
      <PinMenu className="s7-menu2" style={at(470, 212, 140, 108)} hitRow={0} hitClass="s7-hit2" />
      <Cursor className="s7-cur"><Ring className="s7-ring" /><Press className="s7-press" /></Cursor>
    </>
  );
}

function Keycap({ label, wide = false }: { label: string; wide?: boolean }) {
  return <span className={`ob-key${wide ? " is-wide" : ""}`}>{label}</span>;
}

function ShortcutsScene({ mod }: { mod: string }) {
  return (
    <>
      <Titlebar helpClass="s8-helpfocus" />
      <Rail />
      <Sidebar className="ob-a s8-side" />
      <div className="ob-region ob-a s8-convo" style={{ left: 146, top: 18, right: 0, height: 300 }}><Convo /></div>
      <div className="ob-dock-b ob-a s8-bottom" style={{ left: 146, top: 318, right: 0, height: 82 }}>
        <Tabs items={["terminal", "console", "alert"]} active={0} style={at(4, 1, 200, 16)} />
        <div className="ob-dock-body" style={{ left: 0, top: 18, right: 0, height: 64 }}><TermBody /></div>
      </div>
      <div className="ob-keys ob-a s8-k1"><span className="ob-a s8-press1"><Keycap label={mod} wide /></span><b>+</b><span className="ob-a s8-press1"><Keycap label="B" /></span></div>
      <div className="ob-keys ob-a s8-k2"><span className="ob-a s8-press2"><Keycap label={mod} wide /></span><b>+</b><span className="ob-a s8-press2"><Keycap label="J" /></span></div>
      <div className="ob-pop ob-a s8-help" style={at(96, 18, 132, 70)}>
        <div className="ob-menu-row ob-a s8-hit"><Ic name="sparkles" className="is-accent" /><Ln w={60} /></div>
        <div className="ob-menu-row"><Ic name="keyboard" /><Ln w={48} /></div>
        <div className="ob-menu-row"><Ic name="info" /><Ln w={54} /></div>
      </div>
      <div className="ob-mini-tour ob-a s8-modal" style={at(250, 110, 280, 170)}>
        <i className="ob-mini-stage" />
        <div className="ob-mini-copy"><Ln w={70} tone="strong" /><Ln w={96} /><Ln w={80} /></div>
        <div className="ob-mini-foot"><span className="ob-mini-dots"><i /><i /><i /><i /></span><i className="ob-mini-btn" /></div>
      </div>
      <Cursor className="s8-cur"><Ring className="s8-ring" /></Cursor>
    </>
  );
}

export function OnboardingScene({ id, mod }: { id: OnboardingSceneId; mod: string }) {
  switch (id) {
    case "overview": return <OverviewScene />;
    case "windows": return <WindowsScene />;
    case "snap": return <SnapScene />;
    case "dock": return <DockScene />;
    case "dragAll": return <DragAllScene />;
    case "toolRail": return <ToolRailScene />;
    case "pin": return <PinScene />;
    case "shortcuts": return <ShortcutsScene mod={mod} />;
  }
}
