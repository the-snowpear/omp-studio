import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  ConfigWriteResult,
  McpServerRecord,
  McpTestResult,
  StudioClient,
} from "@omp-studio/client-contract";
import { Icon } from "./icons";
import { ToastHost } from "./ToastHost";
import { tabPaneClass, tabPaneRole, useOverlappingTabs } from "./pageTransition";
import { SlidingTabs } from "./SlidingTabs";
import {
  createPreviewMcp,
  createPreviewSlashCommands,
  type PreviewMcp,
  type PreviewSlash,
} from "./capabilitiesPreview";
import {
  lookupSlashCommand,
  slashNeedsArgs,
  visibleSlashCatalog,
  type StudioSlashCommand,
} from "./composer/commands";
import { pluginToPreview, skillToPreview } from "./extensibilityMap";
import { hostErrorMessage, waitReceipt } from "./hostError";
import {
  createPreviewDrawerItems,
  withUniqueDrawerKeys,
  type PluginPreview,
  type SkillPreview,
} from "./skillsPreview";
import { usePreviewMode } from "./preview/PreviewContext";

export const CAP_INTENT_KEY = "omp.capIntent";

export type CapTab = "skills" | "plugins" | "mcp" | "slash";

type CapIntent = { tab?: CapTab; name?: string };

const TABS: ReadonlyArray<readonly [CapTab, string, string]> = [
  ["skills", "book", "Skills"],
  ["plugins", "package", "Plugins"],
  ["mcp", "plug", "MCP"],
  ["slash", "slash", "Slash Commands"],
];

const CONTRACT = {
  create: "创建（暂未实现）",
  view: "查看（暂未实现）",
  remove: "删除（暂未实现）",
  plugin: "插件（暂未实现）",
  builtinDir: "内置技能无本地目录",
  shadowed: "被更高优先级配置覆盖",
  slashComposer: "请在 Composer 输入",
} as const;

type McpLogView = {
  readonly name: string;
  readonly lines: readonly string[];
  readonly emptyReason?: string;
};

function slashToPreview(command: StudioSlashCommand): PreviewSlash {
  return {
    name: `/${command.name}`,
    desc: command.description,
    src: "内置",
    args: command.hint ?? "",
    ok: command.availability === "available",
  };
}

function slashBareName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

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
      data-tip={disabled ? "写入中" : undefined}
      onClick={onToggle}
    />
  );
}

function Disabled({ className, tip, children }: { className: string; tip: string; children: ReactNode }) {
  return (
    <button type="button" className={className} disabled data-tip={tip}>
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

export function CapabilitiesPage({
  client,
  onRunSlash,
}: {
  client: StudioClient;
  onRunSlash?: (command: StudioSlashCommand, args: string) => Promise<boolean>;
}) {
  const { preview } = usePreviewMode();
  const [tab, setTab] = useState<CapTab>("skills");
  const [skills, setSkills] = useState<SkillPreview[]>(() => preview ? previewSkills() : []);
  const [plugins, setPlugins] = useState<PluginPreview[]>(() => preview ? previewPlugins() : []);
  const [mcp, setMcp] = useState<PreviewMcp[]>(() => preview ? createPreviewMcp() : []);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [pluginBusy, setPluginBusy] = useState<ReadonlySet<string>>(new Set());
  const [skillBusy, setSkillBusy] = useState<ReadonlySet<string>>(new Set());
  const [mcpBusy, setMcpBusy] = useState<ReadonlySet<string>>(new Set());
  const [mcpTesting, setMcpTesting] = useState<ReadonlySet<string>>(new Set());
  const [mcpLogs, setMcpLogs] = useState<McpLogView | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const tabIndex = TABS.findIndex(([id]) => id === tab);
  const { incoming, outgoing, dir, live, stageRef } = useOverlappingTabs(tab, tabIndex);

  const slash = useMemo(
    () => (preview ? createPreviewSlashCommands() : visibleSlashCatalog().map(slashToPreview)),
    [preview],
  );

  const refresh = useCallback(async () => {
    if (preview) {
      setSkills(previewSkills());
      setPlugins(previewPlugins());
      setMcp(createPreviewMcp());
      setMcpServers([]);
      setLoadError(null);
      return;
    }
    try {
      const [skillsNext, mcpNext] = await Promise.all([
        client.query("skills.get", {}),
        client.query("mcp.get", {}),
      ]);
      setSkills(skillsNext.skills.map(skillToPreview));
      setPlugins(skillsNext.plugins.map(pluginToPreview));
      setMcp([]);
      setMcpServers([...mcpNext.servers]);
      setLoadError(skillsNext.unavailableReason ?? mcpNext.unavailableReason ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "skills.get / mcp.get failed";
      setSkills([]);
      setPlugins([]);
      setMcp([]);
      setMcpServers([]);
      setLoadError(message);
    }
  }, [client, preview]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts: Record<CapTab, number> = {
    skills: skills.length,
    plugins: plugins.length,
    mcp: preview ? mcp.length : mcpServers.length,
    slash: slash.length,
  };

  useEffect(() => {
    const intent = takeIntent();
    if (!intent) return;
    if (intent.tab) setTab(intent.tab);
    if (intent.name) setHighlight(intent.name);
  }, []);

  useEffect(() => {
    if (!highlight || incoming !== tab) return;
    const el = itemRefs.current.get(highlight);
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  }, [tab, incoming, highlight]);

  const bindItem = (name: string) => (node: HTMLElement | null) => {
    if (node) itemRefs.current.set(name, node);
    else itemRefs.current.delete(name);
  };

  const toast = (text: string) => {
    setFlash(text);
  };

  const withMcpBusy = async (name: string, run: () => Promise<void>, testing = false) => {
    setMcpBusy((current) => new Set(current).add(name));
    if (testing) setMcpTesting((current) => new Set(current).add(name));
    try {
      await run();
    } finally {
      setMcpBusy((current) => {
        const nextSet = new Set(current);
        nextSet.delete(name);
        return nextSet;
      });
      if (testing) {
        setMcpTesting((current) => {
          const nextSet = new Set(current);
          nextSet.delete(name);
          return nextSet;
        });
      }
    }
  };

  const revealSkill = async (skill: SkillPreview) => {
    if (preview) {
      toast("演示：已打开目录");
      return;
    }
    try {
      const handle = await client.command("skills.reveal", { name: skill.name });
      const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
      toast(receipt.message ?? `已打开 ${skill.name} 所在目录`);
    } catch (error) {
      toast(hostErrorMessage(error, "无法打开目录"));
    }
  };

  const revealSkillRoot = async () => {
    if (preview) {
      toast("演示：已打开目录");
      return;
    }
    try {
      const handle = await client.command("skills.revealRoot", { scope: "user" });
      const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
      toast(receipt.message ?? "已打开用户技能目录");
    } catch (error) {
      toast(hostErrorMessage(error, "无法打开目录"));
    }
  };

  const refreshMcp = async (item: McpServerRecord | PreviewMcp) => {
    if (preview) {
      toast("演示：已刷新配置");
      return;
    }
    if ("status" in item && item.status === "shadowed") return;
    await withMcpBusy(item.name, async () => {
      try {
        const handle = await client.command("mcp.refresh", { name: item.name });
        const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
        toast(receipt.message ?? "已刷新配置");
        await refresh();
      } catch (error) {
        toast(hostErrorMessage(error, "刷新失败"));
      }
    });
  };

  const testMcp = async (item: McpServerRecord | PreviewMcp) => {
    if (preview) {
      const tools = "tools" in item && typeof item.tools === "number" ? item.tools : 0;
      toast(`演示：已连接（${tools} 个工具）`);
      return;
    }
    if ("status" in item && item.status === "shadowed") return;
    await withMcpBusy(item.name, async () => {
      try {
        const handle = await client.command("mcp.test", {
          name: item.name,
          ...("scope" in item ? { scope: item.scope } : {}),
        });
        const result = await waitReceipt<McpTestResult>(client, handle.requestId);
        toast(result.ok ? (result.detail || `已连接（${result.toolCount ?? 0} 个工具）`) : result.detail);
        await refresh();
      } catch (error) {
        toast(hostErrorMessage(error, "测试连接失败"));
      }
    }, true);
  };

  const openMcpLogs = async (item: McpServerRecord | PreviewMcp) => {
    if (preview) {
      setMcpLogs({ name: item.name, lines: [], emptyReason: "尚无日志，请先测试连接" });
      return;
    }
    try {
      const result = await client.query("mcp.logs.get", { name: item.name });
      setMcpLogs({
        name: result.name,
        lines: result.lines,
        ...(result.emptyReason === undefined ? {} : { emptyReason: result.emptyReason }),
      });
    } catch (error) {
      toast(hostErrorMessage(error, "无法读取日志"));
    }
  };

  const runSlash = async (row: PreviewSlash) => {
    if (preview) {
      toast(`演示：已执行 ${row.name}`);
      return;
    }
    const command = lookupSlashCommand(slashBareName(row.name));
    if (command === undefined || onRunSlash === undefined) return;
    if (slashNeedsArgs(command, "")) return;
    try {
      await onRunSlash(command, "");
    } catch (error) {
      toast(hostErrorMessage(error, `执行 ${row.name} 失败`));
    }
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

  const toggleMcpServer = async (server: McpServerRecord) => {
    if (preview) return;
    const next = !server.enabled;
    setMcpBusy((current) => new Set(current).add(server.name));
    try {
      const handle = await client.command("mcp.setEnabled", {
        name: server.name,
        enabled: next,
        scope: server.scope,
      });
      const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
      toast(receipt.message ?? (next ? "已启用" : "已禁用"));
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "MCP 开关失败");
    } finally {
      setMcpBusy((current) => {
        const nextSet = new Set(current);
        nextSet.delete(server.name);
        return nextSet;
      });
    }
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
        {withUniqueDrawerKeys(skills).map(({ item: skill, key }) => {
          const scope = scopeOf(skill);
          const tone = skill.error ? "amber" : preview ? (skill.session ? "purple" : "gray") : "purple";
          const sourcePath = skill.path && skill.path !== skill.src ? skill.path : "";
          return (
            <div
              key={key}
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
                    {skill.src ? <span className="chip outline xs">{skill.src}</span> : null}
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
                    <Disabled className="switch" tip="内置">
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
                  {skill.scope === "builtin" ? (
                    <Disabled className="icon-btn small" tip={CONTRACT.builtinDir}><Icon name="folder-open" extra="sm" /></Disabled>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn small"
                      data-tip="打开来源目录"
                      aria-label={`打开来源目录：${skill.name}`}
                      onClick={() => void revealSkill(skill)}
                    >
                      <Icon name="folder-open" extra="sm" />
                    </button>
                  )}
                  <Disabled className="icon-btn small danger" tip={CONTRACT.remove}><Icon name="trash" extra="sm" /></Disabled>
                </div>
              </div>
              <div className="cap-item-body">
                <p className="cap-item-desc">{skill.desc}</p>
                {sourcePath ? <span className="cap-source" data-tip={sourcePath}>{sourcePath}</span> : null}
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
        {withUniqueDrawerKeys(plugins).map(({ item: plugin, key }) => {
          const err = Boolean(plugin.err);
          const enabled = plugin.enabled ?? plugin.status === "loaded";
          const chip = err
            ? { text: "加载失败", cls: "red" }
            : enabled
              ? { text: "已加载", cls: "green" }
              : { text: "已禁用", cls: "gray" };
          return (
            <div
              key={key}
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
    if (preview) {
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
                      <span className={`chip ${tone} xs`}>{item.status}</span>
                      <span className="chip outline xs">{item.transport}</span>
                    </div>
                  </div>
                  <div className="cap-item-actions">
                    <button type="button" className="btn small outline" aria-label={`测试连接：${item.name}`} onClick={() => void testMcp(item)}>
                      测试连接
                    </button>
                    <button type="button" className="btn small outline" aria-label={`日志：${item.name}`} onClick={() => void openMcpLogs(item)}>
                      日志
                    </button>
                    <button
                      type="button"
                      className="icon-btn small"
                      data-tip="刷新"
                      aria-label={`刷新：${item.name}`}
                      onClick={() => void refreshMcp(item)}
                    >
                      <Icon name="refresh" extra="sm" />
                    </button>
                    <Switch
                      on={isOn}
                      label={`启用 MCP 服务器 ${item.name}`}
                      onToggle={() => setMcp((current) => current.map((entry) => entry.name === item.name ? togglePreviewMcp(entry) : entry))}
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
    }

    const on = mcpServers.filter((item) => item.status === "enabled").length;
    const off = mcpServers.filter((item) => item.status === "disabled").length;
    const shadowed = mcpServers.filter((item) => item.status === "shadowed").length;
    return (
      <>
        <Summary
          total={mcpServers.length}
          stats={[
            { cls: "green", n: on, label: "已启用" },
            { cls: "gray", n: off, label: "已禁用" },
            { cls: "amber", n: shadowed, label: "被覆盖" },
          ]}
        />
        {mcpServers.length === 0 ? (
          <p className="muted small">未发现 MCP 配置。OMP 会扫描本机 mcp.json，以及 Codex / Cursor / Claude / Gemini 等来源。</p>
        ) : null}
        {mcpServers.map((item) => {
          const tone = item.status === "enabled" ? "green" : item.status === "shadowed" ? "amber" : "gray";
          const chipLabel = item.status === "enabled" ? "enabled" : item.status === "shadowed" ? "shadowed" : "disabled";
          return (
            <div
              key={`${item.scope}:${item.name}`}
              className="cap-item"
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
                    <span className={`chip ${tone} xs`}>{chipLabel}</span>
                    <span className="chip outline xs">{item.transport}</span>
                    <span className="chip outline xs">{item.sourceLabel}</span>
                  </div>
                </div>
                <div className="cap-item-actions">
                  {item.status === "shadowed" ? (
                    <>
                      <button type="button" className="btn small outline" disabled data-tip={CONTRACT.shadowed} aria-label={`测试连接：${item.name}`}>测试连接</button>
                      <button type="button" className="btn small outline" aria-label={`日志：${item.name}`} onClick={() => void openMcpLogs(item)}>
                        日志
                      </button>
                      <Disabled className="icon-btn small" tip={CONTRACT.shadowed}><Icon name="refresh" extra="sm" /></Disabled>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn small outline"
                        aria-label={`测试连接：${item.name}`}
                        disabled={mcpBusy.has(item.name)}
                        onClick={() => void testMcp(item)}
                      >
                        测试连接
                      </button>
                      <button type="button" className="btn small outline" aria-label={`日志：${item.name}`} onClick={() => void openMcpLogs(item)}>
                        日志
                      </button>
                      <button
                        type="button"
                        className="icon-btn small"
                        data-tip="刷新"
                        aria-label={`刷新：${item.name}`}
                        disabled={mcpBusy.has(item.name)}
                        onClick={() => void refreshMcp(item)}
                      >
                        <Icon name="refresh" extra="sm" />
                      </button>
                    </>
                  )}
                  <Switch
                    on={item.enabled}
                    label={`启用 MCP 服务器 ${item.name}`}
                    disabled={mcpBusy.has(item.name) || item.status === "shadowed"}
                    onToggle={() => void toggleMcpServer(item)}
                  />
                </div>
              </div>
              <div className="cap-item-body">
                <div className="cap-item-meta">
                  <span>Tools {item.lastProbe?.toolCount ?? "—"}</span>
                  <span>Resources —</span>
                  <span>Prompts —</span>
                  <span className="mono">
                    {item.lastProbe
                      ? (item.lastProbe.ok ? item.lastProbe.detail : `探测失败 · ${item.lastProbe.detail}`)
                      : "配置库存（非连接态）"}
                  </span>
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
          {slash.map((command) => {
            const catalog = preview ? undefined : lookupSlashCommand(slashBareName(command.name));
            const needsArgs = catalog !== undefined && slashNeedsArgs(catalog, "");
            const canRun = preview
              ? command.ok
              : command.ok && catalog !== undefined && onRunSlash !== undefined && !needsArgs;
            const tip = preview
              ? undefined
              : !command.ok
                ? (catalog?.disabledReason ?? "当前会话不可用")
                : needsArgs
                  ? `${CONTRACT.slashComposer} ${command.name} …`
                  : undefined;
            return (
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
                {canRun ? (
                  <button className="btn small primary" type="button" onClick={() => void runSlash(command)}>
                    执行
                  </button>
                ) : (
                  <Disabled className="btn small primary" tip={tip ?? "无法执行"}>执行</Disabled>
                )}
              </div>
            );
          })}
        </div>
      </>
    );
  };

  const tabBody = (id: CapTab) => {
    if (id === "skills") return renderSkills();
    if (id === "plugins") return renderPlugins();
    if (id === "mcp") return renderMcp();
    return renderSlash();
  };

  return (
    <div className="page-wide">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18 }}>能力中心</h1>
          <p className="muted small">这里汇总了你的全部能力，包括来自多个应用和插件市场的 Skills 与 Plugins。</p>
          {preview || loadError ? (
            <p className="tiny muted">{preview ? "演示模式：展示示例能力，不代表你的真实配置。" : loadError}</p>
          ) : null}
        </div>
        <span className="spacer" />
        <button type="button" className="btn outline" onClick={() => void revealSkillRoot()}>
          <Icon name="folder" extra="sm" />打开来源目录
        </button>
        <Disabled className="btn primary" tip={CONTRACT.create}><Icon name="plus" extra="sm" />创建 Skill</Disabled>
      </div>
      <ToastHost
        message={mcpTesting.size === 0 ? flash : `正在测试 ${[...mcpTesting].join("、")}…`}
        sticky={mcpTesting.size > 0}
        onDismiss={() => setFlash(null)}
      />
      <div className="cap-layout">
        <SlidingTabs
          id="capSide"
          ariaLabel="能力分类"
          value={tab}
          onChange={setTab}
          syncKey={TABS.map(([id]) => String(counts[id])).join(",")}
          items={TABS.map(([id, icon, label]) => ({
            id,
            icon,
            label,
            buttonId: `capTab-${id}`,
            panelId: `cap-${id}`,
            badge: <span className="cnt">{counts[id]}<span className="sr-only"> 项</span></span>,
          }))}
        />
        <div className="cap-main" id="capMain">
          <div className="cap-pane-stage" ref={stageRef}>
            {outgoing != null && outgoing !== incoming ? (
              <div
                key={outgoing}
                className={tabPaneClass(tabPaneRole(outgoing, incoming, outgoing, live), dir)}
                data-tab-pane={outgoing}
                role="tabpanel"
                id={`cap-${outgoing}`}
                tabIndex={-1}
                aria-labelledby={`capTab-${outgoing}`}
                aria-hidden
                inert
              >
                {tabBody(outgoing)}
              </div>
            ) : null}
            <div
              key={incoming}
              className={tabPaneClass(tabPaneRole(incoming, incoming, outgoing, live), dir)}
              data-tab-pane={incoming}
              role="tabpanel"
              id={`cap-${incoming}`}
              tabIndex={0}
              aria-labelledby={`capTab-${incoming}`}
            >
              {tabBody(incoming)}
            </div>
          </div>
        </div>
      </div>
      {mcpLogs ? createPortal(
        <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={() => setMcpLogs(null)}>
          <section
            className="modal create-project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capMcpLogTitle"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="create-project-head">
              <div>
                <span className="create-project-kicker">MCP</span>
                <h2 id="capMcpLogTitle">{mcpLogs.name} 日志</h2>
              </div>
              <button type="button" className="icon-btn" aria-label="关闭" onClick={() => setMcpLogs(null)}>
                <Icon name="x" />
              </button>
            </div>
            <div className="create-project-body">
              {mcpLogs.lines.length === 0 ? (
                <p className="muted">{mcpLogs.emptyReason ?? "尚无日志，请先测试连接"}</p>
              ) : (
                <pre className="cap-log-body mono">{mcpLogs.lines.join("\n")}</pre>
              )}
            </div>
            <div className="create-project-foot">
              <button type="button" className="btn outline" onClick={() => setMcpLogs(null)}>关闭</button>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function togglePreviewMcp(item: PreviewMcp): PreviewMcp {
  if (item.status === "disabled") return { ...item, status: "connected" };
  return { ...item, status: "disabled" };
}
