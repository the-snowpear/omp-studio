import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { useConversationDom } from "../conversationWorkspace/Context";
import { useDock, useDockEngine } from "./DockContext";
import { DockToolsButton, locationDescription, useDockCopy } from "./DockMenus";
import { locatePanel, panelInstanceIds } from "./model";
import { TOOL_GROUPS } from "./toolGroups";
import { isInstancePanelId, isRepeatablePanelId, isScopedPanelId, type PanelDefinition, type PanelId } from "./types";
import "./launcher.css";

/**
 * 右栏 / 底栏没有任何标签组时的「新标签页」：一行标签栏 + 工具快速入口。
 * 只是空态的外观，不进布局模型；选中工具就把它移入该区域（与标签栏 + 同一动作），
 * 新组建好后这页自然消失。工具清单取自已注册的面板，预览 / 真实两种模式相同。
 */

type Tint = "orange" | "blue" | "violet" | "green" | "rose" | "teal" | "pink" | "indigo" | "cyan" | "lime";
type ToolCopy = { name: readonly [string, string]; detail: readonly [string, string]; tint: Tint };

const TOOL_COPY: Partial<Record<PanelId, ToolCopy>> = {
  files: { name: ["文件", "Files"], detail: ["浏览工作区目录与文件", "Browse workspace folders and files"], tint: "orange" },
  browser: { name: ["浏览器", "Browser"], detail: ["浏览网页、预览本地应用", "Browse the web and preview apps"], tint: "blue" },
  terminal: { name: ["终端", "Terminal"], detail: ["运行命令并查看输出", "Run commands and read the output"], tint: "violet" },
  changes: { name: ["变更", "Changes"], detail: ["审查代码变更与差异", "Review code changes and diffs"], tint: "green" },
  git: { name: ["Git", "Git"], detail: ["分支、提交与暂存", "Branches, commits and staging"], tint: "rose" },
  "git-quick": { name: ["Git 快捷卡", "Git quick card"], detail: ["常用 Git 操作一卡集中", "Common Git actions in one card"], tint: "rose" },
  agents: { name: ["Agents", "Agents"], detail: ["跟踪子 Agent 的运行状态", "Follow subagent runs"], tint: "teal" },
  btw: { name: ["BTW", "BTW"], detail: ["旁路提问，不打断主对话", "Ask aside without interrupting"], tint: "pink" },
  computer: { name: ["电脑", "Computer"], detail: ["查看并操控桌面", "View and control the desktop"], tint: "indigo" },
  environment: { name: ["环境", "Environment"], detail: ["运行时与工具链信息", "Runtime and toolchain"], tint: "cyan" },
  context: { name: ["上下文", "Context"], detail: ["上下文窗口占用", "Context window usage"], tint: "indigo" },
  "context-viewer": { name: ["上下文查看器", "Context viewer"], detail: ["逐条查看上下文内容", "Inspect context entries"], tint: "indigo" },
  annotations: { name: ["标注", "Annotations"], detail: ["阅读原文并整理反馈", "Read sources and leave feedback"], tint: "violet" },
  "token-counter": { name: ["Token 计数", "Token counter"], detail: ["离线估算文本 Token", "Estimate tokens offline"], tint: "lime" },
  problems: { name: ["问题", "Problems"], detail: ["诊断与报错", "Diagnostics and errors"], tint: "rose" },
  tests: { name: ["测试", "Tests"], detail: ["测试运行结果", "Test runs"], tint: "green" },
  output: { name: ["输出", "Output"], detail: ["进程输出", "Process output"], tint: "cyan" },
  logs: { name: ["OMP 日志", "OMP logs"], detail: ["Runtime 日志", "Runtime logs"], tint: "orange" },
  pvlogs: { name: ["预览日志", "Preview logs"], detail: ["预览服务日志", "Preview server logs"], tint: "blue" },
};
/** 大卡片：最常打开的几样；其余按「新建标签」菜单的分类顺序排成小标签。 */
const PRIMARY: readonly PanelId[] = ["files", "browser", "terminal", "changes", "git", "agents"];

export const LAUNCHER_FULLSCREEN = "launcher";

export function DockFullscreenButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const copy = useDockCopy();
  const label = active ? copy("退出全屏", "Exit full screen") : copy("全屏显示", "Full screen");
  return <button type="button" className={`dock-icon-button dock-fullscreen-toggle${active ? " is-on" : ""}`} aria-pressed={active} aria-label={label}
    data-tip={active ? `${label} · Esc` : label} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); onToggle(); }}>
    <Icon name={active ? "contract" : "expand"} extra="sm" />
  </button>;
}

const titlebarBottom = (document: Document) => Math.max(0, Math.round(document.querySelector(".app-titlebar")?.getBoundingClientRect().bottom ?? 0));
const POPUPS = '.dock-menu-popover, .app-select-popup, [role="menu"], [role="listbox"], [data-dock-modal]';

/**
 * 把一个标签组（或新标签页）铺满标题栏以下的整个窗口。用 portal 挂到 body，
 * 避开侧栏 / 底栏祖先的裁切与层叠上下文；面板正文仍由 PanelHosts 按槽位定位，
 * 它认 `data-dock-fullscreen` 提升层级。原位置留一个占位：它被隐藏（切到独立
 * 页面、区域收起）时自动退出全屏。
 */
export function DockFullscreen({ anchor, label, onExit, children }: { anchor: RefObject<HTMLElement | null>; label: string; onExit: () => void; children: ReactNode }) {
  const { document, window } = useConversationDom();
  const { hosts } = useDockEngine();
  const [top, setTop] = useState(() => titlebarBottom(document));
  const exit = useRef(onExit);
  exit.current = onExit;
  useLayoutEffect(() => {
    const read = () => setTop(titlebarBottom(document));
    read();
    hosts.flush();
    window.addEventListener("resize", read);
    return () => { window.removeEventListener("resize", read); hosts.schedule(); };
  }, [document, window, hosts]);
  useEffect(() => {
    const node = anchor.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (!node.getClientRects().length || node.closest("[hidden], [inert]")) exit.current(); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [anchor]);
  useEffect(() => {
    // 捕获阶段读：菜单自己处理 Esc 时可能先把自己卸掉，冒泡阶段就分不清了。
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      // 终端、输入框里的 Esc 属于它们自己（vim、取消补全……）。
      if (target?.closest('.dock-panel-content, input, textarea, select, [contenteditable="true"]')) return;
      if (target?.closest(POPUPS) || document.querySelector(POPUPS)) return;
      event.preventDefault();
      exit.current();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [document, window]);
  return createPortal(<div className="dock-fullscreen" data-dock-fullscreen="" role="region" aria-label={label} style={{ top }}>{children}</div>, document.body);
}

function toolName(definition: PanelDefinition, copy: ReturnType<typeof useDockCopy>) {
  const known = TOOL_COPY[definition.id];
  return known ? copy(known.name[0], known.name[1]) : definition.menuTitle ?? definition.title;
}

export function DockLauncher({ region, expanded, onExpand, fullscreen, onFullscreen }: {
  region: "right" | "bottom";
  expanded: boolean;
  onExpand: () => void;
  fullscreen: boolean;
  onFullscreen: () => void;
}) {
  const { definitions, layout, store, preferences } = useDock();
  const copy = useDockCopy();
  const available = definitions.filter(definition => definition.id !== "agent-detail" && !isInstancePanelId(definition.id) && !isScopedPanelId(definition.id));
  const byId = new Map(available.map(definition => [definition.id, definition]));
  const primary = PRIMARY.flatMap(id => byId.get(id) ?? []);
  const grouped = TOOL_GROUPS.flatMap(group => group.panels);
  const rest = available.filter(definition => !PRIMARY.includes(definition.id))
    .sort((a, b) => (grouped.indexOf(a.id) + 1 || 999) - (grouped.indexOf(b.id) + 1 || 999));
  const locked = preferences.locked;
  const open = (panel: PanelId) => { if (!locked) store.openIn(panel, { region }); };
  /** 已经摆在别处的工具会被移过来；可重复工具则在这里再开一个。 */
  const placedAt = (panel: PanelId) => locatePanel(layout, panel) ? locationDescription(layout, panel, copy) : null;
  const placement = (panel: PanelId): "same" | "another" | "move" | "open" => {
    const locations = panelInstanceIds(layout, panel).flatMap(id => { const location = locatePanel(layout, id); return location ? [location] : []; });
    if (locations.some(location => location.region === region)) return "same";
    if (isRepeatablePanelId(panel) && locations.length) return "another";
    return locations.length ? "move" : "open";
  };
  const tip = (panel: PanelId, fallback: string) => {
    if (locked) return copy("布局已锁定，不能移动工具", "Layout is locked");
    const kind = placement(panel);
    if (kind === "same") return copy("已在当前区域，点击聚焦", "Already here; click to focus");
    if (kind === "another") return copy("在此再开一个", "Open another one here");
    const from = placedAt(panel);
    return kind === "move" && from ? copy(`从「${from}」移到这里`, `Move here from ${from}`) : fallback;
  };
  const actionLabel = (panel: PanelId) => {
    const kind = placement(panel);
    return kind === "same" ? copy("聚焦", "Focus") : kind === "another" ? copy("再开", "Another") : kind === "move" ? copy("移入", "Move") : copy("打开", "Open");
  };
  const detailLabel = (panel: PanelId, fallback: string) => {
    const kind = placement(panel);
    if (kind === "same") return copy("已在当前区域", "Already in this region");
    if (kind === "another") return copy("已在别处打开，将再开一个", "Open elsewhere; opens another here");
    const from = placedAt(panel);
    return from ? copy(`当前在${from}`, `Now in ${from}`) : fallback;
  };
  const title = copy("新标签页", "New tab");
  return <div className={`dock-launcher dock-launcher-${region}`} data-dock-launcher={region}>
    <div className="dock-tab-strip dock-launcher-strip" onDoubleClick={event => { if (event.target === event.currentTarget) onFullscreen(); }}>
      <div className="dock-tabs" role="tablist" aria-label={copy("工具标签", "Tool tabs")}>
        <div className="dock-tab is-active dock-launcher-tab" role="presentation">
          <button type="button" className="dock-tab-label" role="tab" aria-selected="true" tabIndex={0} onClick={onExpand}>
            <Icon name="new-tab" extra="sm" /><span>{title}</span>
          </button>
        </div>
      </div>
      <DockToolsButton className="dock-tab-add" label={copy("新建标签", "New tab")} onPick={open} />
      <span className="dock-toolbar-spacer" onDoubleClick={onFullscreen} />
      <DockFullscreenButton active={fullscreen} onToggle={onFullscreen} />
    </div>
    {(expanded || fullscreen) && <div className="dock-launcher-body">
      <div className="dock-launcher-inner">
        <header className="dock-launcher-head">
          <span className="dock-launcher-mark" aria-hidden="true"><Icon name="new-tab" /></span>
          <div>
            <h2>{title}</h2>
            <p>{copy("选一个工具在这里打开，或把其他标签拖到此处。", "Pick a tool to open here, or drag a tab in.")}</p>
          </div>
        </header>
        <section className="dock-launcher-section" aria-label={copy("常用工具", "Common tools")}>
          <div className="dock-launcher-label">{copy("常用", "Common")}</div>
          <div className="dock-launcher-grid">
            {primary.map(definition => {
              const known = TOOL_COPY[definition.id];
              return <button type="button" key={definition.id} className="dock-launcher-card" data-tint={known?.tint ?? "blue"} disabled={locked}
                data-tip={tip(definition.id, copy(`在这里打开${toolName(definition, copy)}`, `Open ${toolName(definition, copy)} here`))} onClick={() => open(definition.id)}>
                <span className="dock-launcher-ic"><Icon name={definition.icon} /></span>
                <span className="dock-launcher-text">
                  <span className="dock-launcher-name">{toolName(definition, copy)}</span>
                  <span className="dock-launcher-detail">{detailLabel(definition.id, known ? copy(known.detail[0], known.detail[1]) : definition.detail ?? "")}</span>
                </span>
                <span className="dock-launcher-go" aria-hidden="true">{actionLabel(definition.id)}<Icon name="arrow-r" extra="sm" /></span>
              </button>;
            })}
          </div>
        </section>
        {rest.length > 0 && <section className="dock-launcher-section" aria-label={copy("更多工具", "More tools")}>
          <div className="dock-launcher-label">{copy("更多工具", "More tools")}</div>
          <div className="dock-launcher-chips">
            {rest.map(definition => {
              const known = TOOL_COPY[definition.id];
              return <button type="button" key={definition.id} className={`dock-launcher-chip${placement(definition.id) === "open" ? "" : " is-placed"}`} data-tint={known?.tint ?? "blue"} disabled={locked}
                data-tip={tip(definition.id, known ? copy(known.detail[0], known.detail[1]) : definition.detail ?? definition.title)} onClick={() => open(definition.id)}>
                <Icon name={definition.icon} extra="sm" /><span>{toolName(definition, copy)}</span>
              </button>;
            })}
          </div>
        </section>}
        <p className="dock-launcher-foot">{copy("双击标签栏空白处可全屏，Esc 退出", "Double-click the tab bar to go full screen · Esc to exit")}</p>
      </div>
    </div>}
  </div>;
}
