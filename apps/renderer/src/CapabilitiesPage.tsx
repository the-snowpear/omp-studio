import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  ConfigWriteResult,
  McpServerRecord,
  McpTestResult,
  StudioClient,
} from "@omp-studio/client-contract";
import type { OperatorCommandManifest } from "@omp-studio/studio-protocol";
import { Icon } from "./icons";
import { ToastHost } from "./ToastHost";
import { tabPaneClass, tabPaneRole, useOverlappingTabs } from "./pageTransition";
import { SlidingTabs } from "./SlidingTabs";
import { useI18n, type TranslationParams } from "./i18n";
import {
  createPreviewMcp,
  createPreviewSlashCommands,
  type PreviewMcp,
  type PreviewSlash,
} from "./capabilitiesPreview";
import {
  mergeSlashCatalogWithManifest,
  lookupSlashCommand,
  slashNeedsArgs,
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

/** Translation function signature shared by module-scope display builders. */
type TFunc = (key: string, params?: TranslationParams) => string;

const TABS: ReadonlyArray<readonly [CapTab, string]> = [
  ["skills", "book"],
  ["plugins", "package"],
  ["mcp", "plug"],
  ["slash", "slash"],
];

const TAB_LABELS: Record<CapTab, string> = {
  skills: "capabilities.skillsTab",
  plugins: "capabilities.pluginsTab",
  mcp: "capabilities.mcpTab",
  slash: "capabilities.slashTab",
};

type McpLogView = {
  readonly name: string;
  readonly lines: readonly string[];
  readonly emptyReason?: string;
};

function slashToPreview(t: TFunc, command: StudioSlashCommand): PreviewSlash {
  return {
    name: `/${command.name}`,
    desc: command.description,
    src: command.source === undefined || command.source === "builtin" ? t("capabilities.scopeBuiltin") : command.source,
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

function scopeOf(t: TFunc, skill: SkillPreview): { cls: "global" | "builtin" | "project"; label: string } {
  if (skill.scope === "global") return { cls: "global", label: t("capabilities.scopeGlobal") };
  if (skill.scope === "builtin") return { cls: "builtin", label: t("capabilities.scopeBuiltin") };
  return { cls: "project", label: t("capabilities.scopeProject") };
}

function Switch({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`switch${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      data-tip={disabled ? t("common.writing") : undefined}
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
  const { t } = useI18n();
  const seg = (on: boolean, label: string) => (
    <span className={`cap-step ${on ? "on" : "off"}`}>
      <Icon name={on ? "check" : "x"} extra="xs" />
      <span>{label}</span>
    </span>
  );
  return (
    <span className="cap-stepper" role="group" aria-label={t("capabilities.stepperAria")}>
      {seg(true, t("capabilities.configured"))}
      {seg(configuredOnly ? false : loaded, configuredOnly ? t("capabilities.loadedUnknown") : t("capabilities.loaded"))}
      {seg(configuredOnly ? false : session, configuredOnly ? t("capabilities.sessionUnknown") : t("capabilities.sessionAvailable"))}
    </span>
  );
}

function Provide({ icon, label, count, items }: { icon: string; label: string; count: number; items: string[] }) {
  const { t } = useI18n();
  return (
    <div className="cap-provide">
      <div className="cap-provide-head">
        <Icon name={icon} extra="xs" />
        <span>{label}</span>
        <span className="cap-provide-count">{count}</span>
      </div>
      {items.length
        ? <div className="cap-provide-items">{items.map((item) => <span key={item} className="cap-provide-item">{item}</span>)}</div>
        : <div className="cap-provide-empty">{t("common.none")}</div>}
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
  const { t } = useI18n();
  return (
    <div className="cap-summary">
      <span className="cap-sum-stat">
        <Icon name="layers" extra="xs" />
        <strong>{total}</strong>
        <span className="muted">{t("capabilities.items")}</span>
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


function formatMcpSourceLabel(label: string | undefined, t: (k: string) => string): string {
  if (!label) return "";
  if (label === "用户" || label === "User") return t("subagents.scopeUser");
  if (label === "项目" || label === "Project") return t("subagents.scopeProject");
  if (label === "OMP" || label === "内置") return t("skills.scopeBuiltin");
  return label;
}

export function CapabilitiesPage({
  client,
  onRunSlash,
  onPinCompleted,
}: {
  client: StudioClient;
  onRunSlash?: (command: StudioSlashCommand, args: string) => Promise<boolean>;
  /** Called after App has received the authoritative `/pin` receipt. */
  onPinCompleted?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const { preview } = usePreviewMode();
  const [tab, setTab] = useState<CapTab>("skills");
  const [skills, setSkills] = useState<SkillPreview[]>(() => preview ? previewSkills() : []);
  const [plugins, setPlugins] = useState<PluginPreview[]>(() => preview ? previewPlugins() : []);
  const [mcp, setMcp] = useState<PreviewMcp[]>(() => preview ? createPreviewMcp() : []);
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  const [commandManifest, setCommandManifest] = useState<OperatorCommandManifest | undefined>();
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

  /** Tooltips / hints for placeholder controls; resolved at render time. */
  const CONTRACT = {
    create: t("capabilities.createNotImplemented"),
    view: t("capabilities.viewNotImplemented"),
    remove: t("capabilities.removeNotImplemented"),
    plugin: t("capabilities.pluginNotImplemented"),
    builtinDir: t("capabilities.builtinNoDir"),
    shadowed: t("capabilities.shadowedTip"),
    slashComposer: t("composer.paramPlaceholder"),
  };

  const slashCatalog = useMemo(
    () => (preview ? [] : mergeSlashCatalogWithManifest(commandManifest)),
    [commandManifest, preview],
  );
  const slash = useMemo(
    () => (preview ? createPreviewSlashCommands() : slashCatalog.map((command) => slashToPreview(t, command))),
    [preview, slashCatalog, t],
  );

  const refresh = useCallback(async () => {
    if (preview) {
      setSkills(previewSkills());
      setPlugins(previewPlugins());
      setMcp(createPreviewMcp());
      setMcpServers([]);
      setCommandManifest(undefined);
      setLoadError(null);
      return;
    }
    const [skillsResult, mcpResult, manifestResult] = await Promise.allSettled([
      client.query("skills.get", {}),
      client.query("mcp.get", {}),
      client.query("commands.getManifest", {}),
    ]);
    if (skillsResult.status === "fulfilled") {
      setSkills(skillsResult.value.skills.map(skillToPreview));
      setPlugins(skillsResult.value.plugins.map(pluginToPreview));
    } else {
      setSkills([]);
      setPlugins([]);
    }
    if (mcpResult.status === "fulfilled") {
      setMcp([]);
      setMcpServers([...mcpResult.value.servers]);
    } else {
      setMcp([]);
      setMcpServers([]);
    }
    setCommandManifest(manifestResult.status === "fulfilled" ? manifestResult.value : undefined);
    const loadError = skillsResult.status === "rejected"
      ? (skillsResult.reason instanceof Error ? skillsResult.reason.message : "skills.get failed")
      : mcpResult.status === "rejected"
        ? (mcpResult.reason instanceof Error ? mcpResult.reason.message : "mcp.get failed")
        : skillsResult.value.unavailableReason ?? mcpResult.value.unavailableReason ?? null;
    setLoadError(loadError);
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
      toast(t("capabilities.demoOpenedDir"));
      return;
    }
    try {
      const handle = await client.command("skills.reveal", { name: skill.name });
      const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
      toast(receipt.message ?? t("capabilities.openedSkillDir", { name: skill.name }));
    } catch (error) {
      toast(hostErrorMessage(error, t("capabilities.openDirFailed")));
    }
  };

  const revealSkillRoot = async () => {
    if (preview) {
      toast(t("capabilities.demoOpenedDir"));
      return;
    }
    try {
      const handle = await client.command("skills.revealRoot", { scope: "user" });
      const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
      toast(receipt.message ?? t("capabilities.openedUserSkillDir"));
    } catch (error) {
      toast(hostErrorMessage(error, t("capabilities.openDirFailed")));
    }
  };

  const refreshMcp = async (item: McpServerRecord | PreviewMcp) => {
    if (preview) {
      toast(t("capabilities.demoRefreshed"));
      return;
    }
    if ("status" in item && item.status === "shadowed") return;
    await withMcpBusy(item.name, async () => {
      try {
        const handle = await client.command("mcp.refresh", { name: item.name });
        const receipt = await waitReceipt<ConfigWriteResult>(client, handle.requestId);
        toast(receipt.message ?? t("capabilities.refreshedConfig"));
        await refresh();
      } catch (error) {
        toast(hostErrorMessage(error, t("capabilities.refreshFailed")));
      }
    });
  };

  const testMcp = async (item: McpServerRecord | PreviewMcp) => {
    if (preview) {
      const tools = "tools" in item && typeof item.tools === "number" ? item.tools : 0;
      toast(t("capabilities.demoConnected", { count: tools }));
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
        toast(result.ok ? (result.detail || t("capabilities.connectedTools", { count: result.toolCount ?? 0 })) : result.detail);
        await refresh();
      } catch (error) {
        toast(hostErrorMessage(error, t("capabilities.testConnectionFailed")));
      }
    }, true);
  };

  const openMcpLogs = async (item: McpServerRecord | PreviewMcp) => {
    if (preview) {
      setMcpLogs({ name: item.name, lines: [], emptyReason: t("capabilities.noLogsYet") });
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
      toast(hostErrorMessage(error, t("capabilities.readLogsFailed")));
    }
  };

  const runSlash = async (row: PreviewSlash) => {
    if (preview) {
      toast(t("capabilities.demoRanSlash", { name: row.name }));
      return;
    }
    const command = lookupSlashCommand(slashBareName(row.name), slashCatalog);
    if (command === undefined || onRunSlash === undefined) return;
    if (slashNeedsArgs(command, "")) return;
    try {
      const ok = await onRunSlash(command, "");
      if (ok && command.name === "pin") await onPinCompleted?.();
    } catch (error) {
      toast(hostErrorMessage(error, t("capabilities.runSlashFailed", { name: row.name })));
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
      toast(receipt.message ?? (next ? t("common.enabled") : t("common.disabled")));
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : t("capabilities.skillToggleFailed"));
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
      toast(receipt.message ?? (next ? t("common.enabled") : t("common.disabled")));
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : t("capabilities.pluginToggleFailed"));
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
      toast(receipt.message ?? (next ? t("common.enabled") : t("common.disabled")));
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : t("capabilities.mcpToggleFailed"));
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
            { cls: "green", n: ok, label: preview ? t("capabilities.available") : t("capabilities.configured") },
            { cls: "gray", n: disabled, label: t("common.disabled") },
            { cls: "red", n: fail, label: t("common.failed") },
          ]}
        />
        {withUniqueDrawerKeys(skills).map(({ item: skill, key }) => {
          const scope = scopeOf(t, skill);
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
                      label={t("capabilities.toggleSkillAria", { name: skill.name })}
                      onToggle={() => void toggleSkill(skill)}
                    />
                  ) : skill.scope === "builtin" ? (
                    <Disabled className="switch" tip={t("capabilities.scopeBuiltin")}>
                      <span className="sr-only">{t("capabilities.toggleSkillAria", { name: skill.name })}</span>
                    </Disabled>
                  ) : (
                    <Switch
                      on={skill.enabled}
                      label={t("capabilities.toggleSkillAria", { name: skill.name })}
                      disabled={skillBusy.has(skill.name)}
                      onToggle={() => void toggleSkill(skill)}
                    />
                  )}
                  <Disabled className="btn small outline" tip={CONTRACT.view}>{t("capabilities.viewDetails")}</Disabled>
                  {skill.scope === "builtin" ? (
                    <Disabled className="icon-btn small" tip={CONTRACT.builtinDir}><Icon name="folder-open" extra="sm" /></Disabled>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn small"
                      data-tip={t("capabilities.openSourceDir")}
                      aria-label={t("capabilities.openSourceDirAria", { name: skill.name })}
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
            { cls: "green", n: ok, label: t("capabilities.statusEnabled") },
            { cls: "gray", n: off, label: t("capabilities.statusDisabled") },
            { cls: "red", n: fail, label: t("capabilities.statusFailed") },
          ]}
        />
        {withUniqueDrawerKeys(plugins).map(({ item: plugin, key }) => {
          const err = Boolean(plugin.err);
          const enabled = plugin.enabled ?? plugin.status === "loaded";
          const chip = err
            ? { text: t("capabilities.statusLoadFailed"), cls: "red" }
            : enabled
              ? { text: t("capabilities.statusLoaded"), cls: "green" }
              : { text: t("capabilities.statusDisabled"), cls: "gray" };
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
                    label={t("capabilities.togglePluginAria", { name: plugin.name })}
                    disabled={pluginBusy.has(plugin.name)}
                    onToggle={() => void togglePlugin(plugin)}
                  />
                  <Disabled className="btn small outline" tip={CONTRACT.plugin}>{err ? t("capabilities.viewError") : t("capabilities.details")}</Disabled>
                  <Disabled className="icon-btn small" tip={CONTRACT.plugin}><Icon name="more" extra="sm" /></Disabled>
                </div>
              </div>
              <div className="cap-item-provides">
                <Provide icon="terminal" label={t("capabilities.toolsProvided")} count={plugin.tools} items={plugin.toolItems ?? []} />
                <Provide icon="slash" label={t("capabilities.commandsProvided")} count={plugin.commands} items={plugin.commandItems ?? []} />
                <Provide icon="zap" label="Hook" count={plugin.hooks} items={plugin.hookItems ?? []} />
                <Provide
                  icon="monitor"
                  label={t("capabilities.uiProvided")}
                  count={plugin.uiItems?.length ?? (plugin.ui ? 1 : 0)}
                  items={plugin.uiItems ?? (plugin.ui ? [t("capabilities.provideUi")] : [])}
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
              { cls: "green", n: ok, label: t("capabilities.statusConnected") },
              { cls: "red", n: fail, label: t("capabilities.statusFailed") },
              { cls: "gray", n: off, label: t("capabilities.statusDisconnected") },
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
                    <button type="button" className="btn small outline" aria-label={t("capabilities.testMcpAria", { name: item.name })} onClick={() => void testMcp(item)}>
                      {t("capabilities.testConnectionBtn")}
                    </button>
                    <button type="button" className="btn small outline" aria-label={t("capabilities.mcpLogsAria", { name: item.name })} onClick={() => void openMcpLogs(item)}>
                      {t("capabilities.logsBtn")}
                    </button>
                    <button
                      type="button"
                      className="icon-btn small"
                      data-tip={t("common.refresh")}
                      aria-label={t("capabilities.refreshMcpAria", { name: item.name })}
                      onClick={() => void refreshMcp(item)}
                    >
                      <Icon name="refresh" extra="sm" />
                    </button>
                    <Switch
                      on={isOn}
                      label={t("capabilities.toggleMcpAria", { name: item.name })}
                      onToggle={() => setMcp((current) => current.map((entry) => entry.name === item.name ? togglePreviewMcp(entry) : entry))}
                    />
                  </div>
                </div>
                <div className="cap-item-body">
                  <div className="cap-item-meta">
                    <span>Tools {item.tools}</span>
                    <span>Resources {item.resources}</span>
                    <span>Prompts {item.prompts}</span>
                    <span className="mono">{t("capabilities.recentCall", { time: item.last })}</span>
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
            { cls: "green", n: on, label: t("capabilities.statusEnabled") },
            { cls: "gray", n: off, label: t("capabilities.statusDisabled") },
            { cls: "amber", n: shadowed, label: t("capabilities.statusShadowed") },
          ]}
        />
        {mcpServers.length === 0 ? (
          <p className="muted small">{t("capabilities.noMcpConfigFound")}</p>
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
                    <span className="chip outline xs">{formatMcpSourceLabel(item.sourceLabel, t)}</span>
                  </div>
                </div>
                <div className="cap-item-actions">
                  {item.status === "shadowed" ? (
                    <>
                      <button type="button" className="btn small outline" disabled data-tip={CONTRACT.shadowed} aria-label={t("capabilities.testMcpAria", { name: item.name })}>{t("capabilities.testConnectionBtn")}</button>
                      <button type="button" className="btn small outline" aria-label={t("capabilities.mcpLogsAria", { name: item.name })} onClick={() => void openMcpLogs(item)}>
                        {t("capabilities.logsBtn")}
                      </button>
                      <Disabled className="icon-btn small" tip={CONTRACT.shadowed}><Icon name="refresh" extra="sm" /></Disabled>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn small outline"
                        aria-label={t("capabilities.testMcpAria", { name: item.name })}
                        disabled={mcpBusy.has(item.name)}
                        onClick={() => void testMcp(item)}
                      >
                        {t("capabilities.testConnectionBtn")}
                      </button>
                      <button type="button" className="btn small outline" aria-label={t("capabilities.mcpLogsAria", { name: item.name })} onClick={() => void openMcpLogs(item)}>
                        {t("capabilities.logsBtn")}
                      </button>
                      <button
                        type="button"
                        className="icon-btn small"
                        data-tip={t("common.refresh")}
                        aria-label={t("capabilities.refreshMcpAria", { name: item.name })}
                        disabled={mcpBusy.has(item.name)}
                        onClick={() => void refreshMcp(item)}
                      >
                        <Icon name="refresh" extra="sm" />
                      </button>
                    </>
                  )}
                  <Switch
                    on={item.enabled}
                    label={t("capabilities.toggleMcpAria", { name: item.name })}
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
                      ? (item.lastProbe.ok ? item.lastProbe.detail : t("capabilities.probeFailedDetail", { detail: item.lastProbe.detail }))
                      : t("capabilities.configInventoryNonConnected")}
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
            { cls: "green", n: ok, label: t("capabilities.statusAvailable") },
            { cls: "gray", n: slash.length - ok, label: t("capabilities.statusUnavailable") },
          ]}
        />
        <div className="cap-slash-list">
          {slash.map((command) => {
            const catalog = preview ? undefined : lookupSlashCommand(slashBareName(command.name), slashCatalog);
            const needsArgs = catalog !== undefined && slashNeedsArgs(catalog, "");
            const canRun = preview
              ? command.ok
              : command.ok && catalog !== undefined && onRunSlash !== undefined && !needsArgs;
            const tip = preview
              ? undefined
              : !command.ok
                ? (catalog?.disabledReason ?? t("capabilities.disabledInSession"))
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
                <span className={`chip ${command.ok ? "green" : "gray"} sm`}>{command.ok ? t("capabilities.statusAvailable") : t("capabilities.statusUnavailable")}</span>
                {canRun ? (
                  <button className="btn small primary" type="button" onClick={() => void runSlash(command)}>
                    {t("capabilities.runBtn")}
                  </button>
                ) : (
                  <Disabled className="btn small primary" tip={tip ?? t("capabilities.cannotRunTip")}>{t("capabilities.runBtn")}</Disabled>
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
          <h1 style={{ fontSize: 18 }}>{t("capabilities.pageTitle")}</h1>
          <p className="muted small">{t("capabilities.pageSubtitle")}</p>
          {preview || loadError ? (
            <p className="tiny muted">{preview ? t("capabilities.previewSubtitle") : loadError}</p>
          ) : null}
        </div>
        <span className="spacer" />
        <button type="button" className="btn outline" onClick={() => void revealSkillRoot()}>
          <Icon name="folder" extra="sm" />{t("capabilities.openSourceDir")}
        </button>
        <Disabled className="btn primary" tip={CONTRACT.create}><Icon name="plus" extra="sm" />{t("capabilities.createSkill")}</Disabled>
      </div>
      <ToastHost
        message={mcpTesting.size === 0 ? flash : t("capabilities.mcpTesting", { name: [...mcpTesting].join(", ") })}
        sticky={mcpTesting.size > 0}
        onDismiss={() => setFlash(null)}
      />
      <div className="cap-layout">
        <SlidingTabs
          id="capSide"
          ariaLabel={t("capabilities.catAria")}
          value={tab}
          onChange={setTab}
          syncKey={TABS.map(([id]) => String(counts[id])).join(",")}
          items={TABS.map(([id, icon]) => ({
            id,
            icon,
            label: t(TAB_LABELS[id]),
            buttonId: `capTab-${id}`,
            panelId: `cap-${id}`,
            badge: <span className="cnt">{counts[id]}<span className="sr-only"> {t("capabilities.catItemCount", { count: counts[id] })}</span></span>,
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
                <h2 id="capMcpLogTitle">{t("capabilities.mcpLogTitle", { name: mcpLogs.name })}</h2>
              </div>
              <button type="button" className="icon-btn" aria-label={t("capabilities.closeLog")} onClick={() => setMcpLogs(null)}>
                <Icon name="x" />
              </button>
            </div>
            <div className="create-project-body">
              {mcpLogs.lines.length === 0 ? (
                <p className="muted">{mcpLogs.emptyReason ?? t("capabilities.noLogsYet")}</p>
              ) : (
                <pre className="cap-log-body mono">{mcpLogs.lines.join("\n")}</pre>
              )}
            </div>
            <div className="create-project-foot">
              <button type="button" className="btn outline" onClick={() => setMcpLogs(null)}>{t("capabilities.closeLog")}</button>
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
