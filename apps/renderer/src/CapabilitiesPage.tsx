import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { ConfigWriteResult, StudioClient } from "@omp-studio/client-contract";
import { Icon } from "./icons";
import {
  createPreviewHostTools,
  createPreviewMcp,
  createPreviewSlashCommands,
  type PreviewMcp,
} from "./capabilitiesPreview";
import { pluginToPreview, skillToPreview } from "./extensibilityMap";
import {
  createPreviewDrawerItems,
  type PluginPreview,
  type SkillPreview,
} from "./skillsPreview";
import { usePreviewMode } from "./preview/PreviewContext";

export const CAP_INTENT_KEY = "omp.capIntent";

export type CapTab = "skills" | "plugins" | "mcp" | "host" | "slash";

type CapIntent = { tab?: CapTab; name?: string };

const TABS: ReadonlyArray<readonly [CapTab, string, string]> = [
  ["skills", "book", "Skills"],
  ["plugins", "package", "Plugins"],
  ["mcp", "plug", "MCP"],
  ["host", "monitor", "Host Tools"],
  ["slash", "slash", "Slash Commands"],
];

const CONTRACT = {
  folder: "打开来源目录不在公共 contract 中",
  create: "创建 Skill 不在公共 contract 中",
  view: "Skill 详情不在公共 contract 中",
  reveal: "打开 Skill 目录不在公共 contract 中",
  remove: "删除 Skill 不在公共 contract 中",
  plugin: "Plugin 详情 / 卸载不在公共 contract 中",
  mcp: "MCP 连接控制不在公共 contract 中",
  slash: "演示 slash 不能当作 operator.invoke id 执行",
} as const;

export function setCapIntent(tab: CapTab, name?: string): void {
  try {
    sessionStorage.setItem(CAP_INTENT_KEY, JSON.stringify({ tab, name: name ?? null }));
  } catch {
    /* sessionStorage may be blocked; navigation still opens the page. */
  }
}

function takeIntent(): CapIntent | null {
  try {
    const raw = sessionStorage.getItem(CAP_INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(CAP_INTENT_KEY);
    const value = JSON.parse(raw) as { tab?: unknown; name?: unknown };
    const tab = TABS.some(([id]) => id === value.tab) ? value.tab as CapTab : undefined;
    const name = typeof value.name === "string" ? value.name : undefined;
    return { ...(tab ? { tab } : {}), ...(name ? { name } : {}) };
  } catch {
    return null;
  }
}

function previewSkills(): SkillPreview[] {
  return createPreviewDrawerItems().filter((item): item is SkillPreview => item.kind === "skill");
}

/** Resolve a command's terminal result; rejects with an Error on failure. */
function waitReceipt<T>(client: StudioClient, requestId: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const unsub = client.subscribe({ scope: "command", requestId: requestId as never }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt.requestId !== requestId) return;
      unsub();
      if (event.receipt.status === "completed") resolve(event.receipt.result as T);
      else if (event.receipt.status === "failed") reject(new Error(event.receipt.error?.message ?? "命令失败"));
      else reject(new Error(`命令未完成：${event.receipt.status}`));
    });
  });
}

function previewPlugins(): PluginPreview[] {
  return createPreviewDrawerItems().filter((item): item is PluginPreview => item.kind === "plugin");
}

function scopeOf(skill: SkillPreview): { cls: "global" | "builtin" | "project"; label: string } {
  if (skill.scope === "global") return { cls: "global", label: "全局" };
  if (skill.scope === "builtin") return { cls: "builtin", label: "内置" };
  return { cls: "project", label: "项目" };
}

function Switch({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`switch${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      title={disabled ? "正在写入 OMP 配置…" : undefined}
      onClick={onToggle}
    />
  );
}

function Disabled({ className, tip, children }: { className: string; tip: string; children: ReactNode }) {
  return (
    <button type="button" className={className} disabled title={tip}>
      {children}
    </button>
  );
}

function Stepper({ loaded, session, configuredOnly }: { loaded: boolean; session: boolean; configuredOnly?: boolean }) {
  const seg = (on: boolean, label: string) => (
    <span className={`cap-step ${on ? "on" : "off"}`}>
      <Icon name={on ? "check" : "x"} extra="xs" />
      <span>{label}</span>
    </span>
  );
  return (
    <span className="cap-stepper" role="group" aria-label="能力状态：已配置 / 已加载 / 当前会话可用">
      {seg(true, "已配置")}
      {seg(configuredOnly ? false : loaded, configuredOnly ? "已加载未知" : "已加载")}
      {seg(configuredOnly ? false : session, configuredOnly ? "会话未知" : "当前会话可用")}
    </span>
  );
}

function Provide({ icon, label, count, items }: { icon: string; label: string; count: number; items: string[] }) {
  return (
    <div className="cap-provide">
      <div className="cap-provide-head">
        <Icon name={icon} extra="xs" />
        <span>{label}</span>
        <span className="cap-provide-count">{count}</span>
      </div>
      {items.length
        ? <div className="cap-provide-items">{items.map((item) => <span key={item} className="cap-provide-item">{item}</span>)}</div>
        : <div className="cap-provide-empty">无</div>}
    </div>
  );
}

function Summary({
  total,
  stats,
}: {
  total: number;
  stats: Array<{ cls: string; n: number; label: string }>;
}) {
  return (
    <div className="cap-summary">
      <span className="cap-sum-stat">
        <Icon name="layers" extra="xs" />
        <strong>{total}</strong>
        <span className="muted">项</span>
      </span>
      {stats.filter((stat) => stat.n > 0).map((stat) => (
        <span key={stat.label} className="cap-sum-stat">
          <span className={`dot ${stat.cls}`} />
          <strong>{stat.n}</strong>
          <span className="muted">{stat.label}</span>
        </span>
      ))}
    </div>
  );
}

export function CapabilitiesPage({ client }: { client: StudioClient }) {
  const { preview } = usePreviewMode();
  const [tab, setTab] = useState<CapTab>("skills");
  const [skills, setSkills] = useState<SkillPreview[]>(() => preview ? previewSkills() : []);
  const [plugins, setPlugins] = useState<PluginPreview[]>(() => preview ? previewPlugins() : []);
  const [mcp, setMcp] = useState(() => preview ? createPreviewMcp() : []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [pluginBusy, setPluginBusy] = useState<ReadonlySet<string>>(new Set());
  const [skillBusy, setSkillBusy] = useState<ReadonlySet<string>>(new Set());
  const sideRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());

  const hostTools = useMemo(() => preview ? createPreviewHostTools() : [], [preview]);
  const slash = useMemo(() => preview ? createPreviewSlashCommands() : [], [preview]);

  const refresh = useCallback(async () => {
    if (preview) {
      setSkills(previewSkills());
      setPlugins(previewPlugins());
      setMcp(createPreviewMcp());
      setLoadError(null);
      return;
    }
    try {
      const next = await client.query("skills.get", {});
      setSkills(next.skills.map(skillToPreview));
      setPlugins(next.plugins.map(pluginToPreview));
      setLoadError(next.unavailableReason ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "skills.get failed";
      setSkills([]);
      setPlugins([]);
      setLoadError(message);
    }
  }, [client, preview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts: Record<CapTab, number> = {
    skills: skills.length,
    plugins: plugins.length,
    mcp: mcp.length,
    host: hostTools.length,
    slash: slash.length,
  };

  useEffect(() => {
    const intent = takeIntent();
    if (!intent) return;
    if (intent.tab) setTab(intent.tab);
    if (intent.name) setHighlight(intent.name);
  }, []);

  useEffect(() => {
    if (!highlight) return;
    const el = itemRefs.current.get(highlight);
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  }, [tab, highlight]);

  const bindItem = (name: string) => (node: HTMLElement | null) => {
    if (node) itemRefs.current.set(name, node);
    else itemRefs.current.delete(name);
  };

  const selectTab = (next: CapTab) => {
    setTab(next);
  };

  const toast = (text: string) => {
    setFlash(text);
    window.setTimeout(() => setFlash(null), 3200);
  };

  /**
   * Whole-skill toggle (`skills.setEnabled`): preview mode only mutates
   * local state; real mode rewrites the SKILL.md frontmatter through the
   * Host and re-reads `skills.get` after the receipt.
   */
  const toggleSkill = async (skill: SkillPreview) => {
    if (preview) {
      setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled: !item.enabled } : item));
      return;
    }
    const next = !skill.enabled;
    setSkillBusy((current) => new Set(current).add(skill.name));
    try {
      const handle = await client.command("skills.setEnabled", { name: skill.name, enabled: next });
      const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
      toast(receipt.message ?? (next ? "已启用" : "已禁用"));
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "技能开关失败");
    } finally {
      setSkillBusy((current) => {
        const nextSet = new Set(current);
        nextSet.delete(skill.name);
        return nextSet;
      });
    }
  };

  /**
   * Whole-package plugin toggle (`plugins.setEnabled`): preview mode only
   * mutates local state; real mode writes the OMP-native files through the
   * Host and re-reads `skills.get` after the receipt so the list reflects
   * the disk immediately.
   */
  const togglePlugin = async (plugin: PluginPreview) => {
    if (preview) {
      setPlugins((current) => current.map((item) => item.name === plugin.name ? { ...item, enabled: !item.enabled } : item));
      return;
    }
    const next = !(plugin.enabled ?? plugin.status === "loaded");
    setPluginBusy((current) => new Set(current).add(plugin.name));
    try {
      const handle = await client.command("plugins.setEnabled", { name: plugin.name, enabled: next });
      const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
      toast(receipt.message ?? (next ? "已启用" : "已禁用"));
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "插件开关失败");
    } finally {
      setPluginBusy((current) => {
        const nextSet = new Set(current);
        nextSet.delete(plugin.name);
        return nextSet;
      });
    }
  };

  const onSideKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const all = [...(sideRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = all[(index + 1) % all.length];
    else if (event.key === "ArrowUp") next = all[(index - 1 + all.length) % all.length];
    else if (event.key === "Home") next = all[0];
    else if (event.key === "End") next = all[all.length - 1];
    if (!next) return;
    event.preventDefault();
    const id = next.dataset.cap;
    if (id && TABS.some(([tabId]) => tabId === id)) selectTab(id as CapTab);
    next.focus();
  };

  const renderSkills = () => {
    const fail = skills.filter((skill) => Boolean(skill.error)).length;
    const disabled = skills.filter((skill) => skill.enabled === false).length;
    const ok = preview ? skills.filter((skill) => skill.session).length : skills.length - fail - disabled;
    return (
      <>
        <Summary
          total={skills.length}
          stats={[
            { cls: "green", n: ok, label: preview ? "可用" : "已配置" },
            { cls: "gray", n: disabled, label: "已禁用" },
            { cls: "red", n: fail, label: "失败" },
          ]}
        />
        {skills.map((skill) => {
          const scope = scopeOf(skill);
          const tone = skill.error ? "amber" : preview ? (skill.session ? "purple" : "gray") : "purple";
          const source = skill.path || skill.src || "";
          return (
            <div
              key={skill.name}
              className={`cap-item cap-skills${skill.error ? " has-error" : ""}`}
              data-name={skill.name}
              tabIndex={highlight === skill.name ? 0 : -1}
              ref={bindItem(skill.name)}
            >
              <div className="cap-item-summary">
                <span className={`a-ic ${tone}`}><Icon name="book" extra="lg" /></span>
                <div className="cap-item-main">
                  <div className="cap-item-name-row">
                    <span className="cap-item-name">{skill.name}</span>
                    <span className={`cap-scope ${scope.cls}`}>{scope.label}</span>
                  </div>
                  <Stepper loaded={skill.loaded} session={skill.session} configuredOnly={!preview} />
                </div>
                <div className="cap-item-actions">
                  {preview ? (
                    <Switch
                      on={skill.enabled}
                      label={`启用 Skill ${skill.name}`}
                      onToggle={() => void toggleSkill(skill)}
                    />
                  ) : skill.scope === "builtin" ? (
                    <Disabled className="switch" tip="内置技能不可切换">
                      <span className="sr-only">启用 Skill {skill.name}</span>
                    </Disabled>
                  ) : (
                    <Switch
                      on={skill.enabled}
                      label={`启用 Skill ${skill.name}`}
                      disabled={skillBusy.has(skill.name)}
                      onToggle={() => void toggleSkill(skill)}
                    />
                  )}
                  <Disabled className="btn small outline" tip={CONTRACT.view}>查看</Disabled>
                  <Disabled className="icon-btn small" tip={CONTRACT.reveal}><Icon name="folder-open" extra="sm" /></Disabled>
                  <Disabled className="icon-btn small danger" tip={CONTRACT.remove}><Icon name="trash" extra="sm" /></Disabled>
                </div>
              </div>
              <div className="cap-item-body">
                <p className="cap-item-desc">{skill.desc}</p>
                {source ? <span className="cap-source" title={source}>{source}</span> : null}
              </div>
              {skill.error ? (
                <div className="cap-error">
                  <Icon name="alert-c" extra="xs" />
                  <span>{skill.error}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </>
    );
  };

  const renderPlugins = () => {
    const fail = plugins.filter((plugin) => plugin.err || plugin.status === "error").length;
    const off = plugins.filter((plugin) => plugin.enabled === false).length;
    const ok = plugins.length - fail - off;
    return (
      <>
        <Summary
          total={plugins.length}
          stats={[
            { cls: "green", n: ok, label: "已启用" },
            { cls: "gray", n: off, label: "已禁用" },
            { cls: "red", n: fail, label: "失败" },
          ]}
        />
        {plugins.map((plugin) => {
          const err = Boolean(plugin.err);
          const enabled = plugin.enabled ?? plugin.status === "loaded";
          const chip = err
            ? { text: "加载失败", cls: "red" }
            : enabled
              ? { text: "已加载", cls: "green" }
              : { text: "已禁用", cls: "gray" };
          return (
            <div
              key={plugin.name}
              className={`cap-item${err ? " has-error" : ""}`}
              data-name={plugin.name}
              tabIndex={highlight === plugin.name ? 0 : -1}
              ref={bindItem(plugin.name)}
            >
              <div className="cap-item-summary">
                <span className={`a-ic ${err ? "amber" : "blue"}`}><Icon name="package" extra="sm" /></span>
                <div className="cap-item-main">
                  <div className="cap-item-name-row">
                    <span className="cap-item-name">{plugin.name}</span>
                    <span className={`chip ${chip.cls} xs`}>{chip.text}</span>
                    <span className="chip outline xs">{plugin.src}</span>
                  </div>
                </div>
                <div className="cap-item-actions">
                  <Switch
                    on={enabled}
                    label={`启用插件 ${plugin.name}`}
                    disabled={pluginBusy.has(plugin.name)}
                    onToggle={() => void togglePlugin(plugin)}
                  />
                  <Disabled className="btn small outline" tip={CONTRACT.plugin}>{err ? "查看错误" : "详情"}</Disabled>
                  <Disabled className="icon-btn small" tip={CONTRACT.plugin}><Icon name="more" extra="sm" /></Disabled>
                </div>
              </div>
              <div className="cap-item-provides">
                <Provide icon="terminal" label="工具" count={plugin.tools} items={plugin.toolItems ?? []} />
                <Provide icon="slash" label="指令" count={plugin.commands} items={plugin.commandItems ?? []} />
                <Provide icon="zap" label="Hook" count={plugin.hooks} items={plugin.hookItems ?? []} />
                <Provide
                  icon="monitor"
                  label="UI 能力"
                  count={plugin.uiItems?.length ?? (plugin.ui ? 1 : 0)}
                  items={plugin.uiItems ?? (plugin.ui ? ["提供 UI"] : [])}
                />
              </div>
              {plugin.err ? (
                <div className="cap-error">
                  <Icon name="alert-c" extra="xs" />
                  <span>{plugin.err}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </>
    );
  };

  const renderMcp = () => {
    const ok = mcp.filter((item) => item.status === "connected").length;
    const fail = mcp.filter((item) => item.status === "error").length;
    const off = mcp.length - ok - fail;
    return (
      <>
        <Summary
          total={mcp.length}
          stats={[
            { cls: "green", n: ok, label: "已连接" },
            { cls: "red", n: fail, label: "失败" },
            { cls: "gray", n: off, label: "未连接" },
          ]}
        />
        {mcp.map((item) => {
          const tone = item.status === "connected" ? "green" : item.status === "reconnecting" ? "amber" : "gray";
          const chip = tone;
          const isOn = item.status !== "disabled";
          return (
            <div
              key={item.name}
              className={`cap-item${item.status === "error" ? " has-error" : ""}`}
              data-tone={tone}
              data-name={item.name}
              tabIndex={highlight === item.name ? 0 : -1}
              ref={bindItem(item.name)}
            >
              <div className="cap-item-summary">
                <span className={`a-ic ${tone}`}><Icon name="plug" extra="sm" /></span>
                <div className="cap-item-main">
                  <div className="cap-item-name-row">
                    <span className="cap-item-name">{item.name}</span>
                    <span className={`chip ${chip} xs`}>{item.status}</span>
                    <span className="chip outline xs">{item.transport}</span>
                  </div>
                </div>
                <div className="cap-item-actions">
                  <Disabled className="btn small outline" tip={CONTRACT.mcp}>测试连接<span className="sr-only">：{item.name}</span></Disabled>
                  <Disabled className="btn small outline" tip={CONTRACT.mcp}>日志<span className="sr-only">：{item.name}</span></Disabled>
                  <Disabled className="icon-btn small" tip={CONTRACT.mcp}><Icon name="refresh" extra="sm" /></Disabled>
                  <Switch
                    on={isOn}
                    label={`启用 MCP 服务器 ${item.name}`}
                    onToggle={() => setMcp((current) => current.map((entry) => entry.name === item.name ? toggleMcp(entry) : entry))}
                  />
                </div>
              </div>
              <div className="cap-item-body">
                <div className="cap-item-meta">
                  <span>Tools {item.tools}</span>
                  <span>Resources {item.resources}</span>
                  <span>Prompts {item.prompts}</span>
                  <span className="mono">最近调用 {item.last}</span>
                </div>
              </div>
            </div>
          );
        })}
      </>
    );
  };

  const renderHost = () => {
    const ok = hostTools.filter((tool) => tool.registered).length;
    return (
      <>
        <Summary
          total={hostTools.length}
          stats={[
            { cls: "green", n: ok, label: "已注册" },
            { cls: "gray", n: hostTools.length - ok, label: "未注册" },
          ]}
        />
        {hostTools.map((tool) => {
          const tone = tool.registered ? "green" : "amber";
          return (
            <div key={tool.name} className="cap-item" data-name={tool.name} tabIndex={highlight === tool.name ? 0 : -1} ref={bindItem(tool.name)}>
              <div className="cap-item-summary">
                <span className={`a-ic ${tone}`}><Icon name="monitor" extra="sm" /></span>
                <div className="cap-item-main">
                  <div className="cap-item-name-row">
                    <span className="cap-item-name mono">{tool.name}</span>
                    <span className={`chip ${tone} xs`}>{tool.registered ? "已注册" : "未注册"}</span>
                  </div>
                </div>
              </div>
              <div className="cap-item-body">
                <p className="cap-item-desc">{tool.desc}</p>
                <div className="cap-item-meta">
                  <span>累计调用 {tool.calls} 次</span>
                </div>
              </div>
            </div>
          );
        })}
      </>
    );
  };

  const renderSlash = () => {
    const ok = slash.filter((command) => command.ok).length;
    return (
      <>
        <Summary
          total={slash.length}
          stats={[
            { cls: "green", n: ok, label: "当前可用" },
            { cls: "gray", n: slash.length - ok, label: "不可用" },
          ]}
        />
        <div className="cap-slash-list">
          {slash.map((command) => (
            <div
              key={command.name}
              className="cap-slash-row"
              data-ok={String(command.ok)}
              data-name={command.name}
              tabIndex={highlight === command.name ? 0 : -1}
              ref={bindItem(command.name)}
            >
              <div className="cap-slash-name">
                <span className="a-ic purple"><Icon name="slash" extra="sm" /></span>
                <span className="mono">{command.name}</span>
                <span className="muted">{command.args}</span>
              </div>
              <div className="cap-slash-desc">{command.desc}<span className="muted"> · {command.src}</span></div>
              <span className={`chip ${command.ok ? "green" : "gray"} sm`}>{command.ok ? "当前会话可用" : "不可用"}</span>
              <button className="btn small primary" type="button" disabled title={CONTRACT.slash}>执行</button>
            </div>
          ))}
        </div>
      </>
    );
  };

  return (
    <div className="page-wide">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>能力中心</h1>
          <p className="muted small">Skills / Plugins 扫描 OMP / Claude / Agents / Codex / OpenCode / GitHub / 插件与市场（configured 库存，非 Runtime loaded）。MCP / Host Tools / Slash 仍无对应 read model。</p>
          <p className="tiny muted">
            {preview
              ? "演示目录 · 预览开时覆盖真实库存"
              : loadError
                ? loadError
                : "已配置库存 · 当前会话是否加载需 Runtime introspection"}
          </p>
        </div>
        <span className="spacer" />
        <Disabled className="btn outline" tip={CONTRACT.folder}><Icon name="folder" extra="sm" />打开来源目录</Disabled>
        <Disabled className="btn primary" tip={CONTRACT.create}><Icon name="plus" extra="sm" />创建 Skill</Disabled>
      </div>
      {flash ? (
        <div className="cap-flash" role="status">
          <Icon name="info" extra="xs" />
          <span>{flash}</span>
        </div>
      ) : null}
      <div className="cap-layout">
        <div
          className="cap-side"
          id="capSide"
          ref={sideRef}
          role="tablist"
          aria-label="能力分类"
          aria-orientation="vertical"
          onKeyDown={onSideKey}
        >
          {TABS.map(([id, icon, label]) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                data-cap={id}
                className={active ? "active" : undefined}
                role="tab"
                aria-selected={active}
                aria-controls="capMain"
                tabIndex={active ? 0 : -1}
                onClick={() => selectTab(id)}
              >
                <Icon name={icon} extra="sm" />
                {label}
                <span className="cnt">{counts[id]}<span className="sr-only"> 项</span></span>
              </button>
            );
          })}
        </div>
        <div className="cap-main" id="capMain" role="tabpanel" tabIndex={0} aria-label="能力列表">
          {tab === "skills" ? renderSkills() : null}
          {tab === "plugins" ? renderPlugins() : null}
          {tab === "mcp" ? renderMcp() : null}
          {tab === "host" ? renderHost() : null}
          {tab === "slash" ? renderSlash() : null}
        </div>
      </div>
    </div>
  );
}

function toggleMcp(item: PreviewMcp): PreviewMcp {
  if (item.status === "disabled") return { ...item, status: "connected" };
  return { ...item, status: "disabled" };
}
