import { useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./icons";
import type { PageRoute } from "./HomePage";
import { setModelConfigIntent, type McTab } from "./ModelConfigPage";
import { tabPaneClass, tabPaneRole, useOverlappingTabs } from "./pageTransition";
import { SlidingTabs } from "./SlidingTabs";

export const SETTINGS_INTENT_KEY = "omp.settingsIntent";

export type SettingsGroupId = "general" | "models" | "permissions" | "sessions" | "preview" | "advanced";

type GroupId = SettingsGroupId;

const GROUP_IDS: ReadonlyArray<SettingsGroupId> = ["general", "models", "permissions", "sessions", "preview", "advanced"];

export function setSettingsIntent(group: SettingsGroupId): void {
  try {
    sessionStorage.setItem(SETTINGS_INTENT_KEY, JSON.stringify({ group }));
  } catch {
    /* sessionStorage may be blocked; navigation still opens the page. */
  }
}

function takeSettingsIntent(): SettingsGroupId | null {
  try {
    const raw = sessionStorage.getItem(SETTINGS_INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SETTINGS_INTENT_KEY);
    const value = JSON.parse(raw) as { group?: unknown };
    return GROUP_IDS.some((id) => id === value.group) ? value.group as SettingsGroupId : null;
  } catch {
    return null;
  }
}

const GROUPS: ReadonlyArray<readonly [GroupId, string, string]> = [
  ["general", "settings", "General"],
  ["models", "cpu", "Models and Providers"],
  ["permissions", "shield", "Permissions"],
  ["sessions", "history", "Sessions"],
  ["preview", "globe", "Preview"],
  ["advanced", "wrench", "Advanced"],
];

const CONTRACT = {
  rules: "「始终允许」规则读写不在公共 contract 中",
  clearRules: "清除授权规则不在公共 contract 中",
  cleanup: "历史清理（不可恢复）不在公共 contract 中",
  configDir: "配置目录路径不在公共 contract 中（read model 已脱敏）",
} as const;

/** Local visual toggle — mirrors ver1 `.switch`; no persistence contract yet. */
function Toggle({ defaultOn, label }: { defaultOn?: boolean; label: string }) {
  const [on, setOn] = useState(Boolean(defaultOn));
  return (
    <button
      type="button"
      className={`switch${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => setOn((value) => !value)}
    />
  );
}

function Row({ label, desc, style, children }: { label: string; desc: string; style?: React.CSSProperties; children: ReactNode }) {
  return (
    <div className="set-row" style={style}>
      <div><div className="sr-label">{label}</div><div className="sr-desc">{desc}</div></div>
      <div className="sr-control">{children}</div>
    </div>
  );
}

function PermCard({ icon, name, desc, defaultOn, note }: { icon: string; name: string; desc: string; defaultOn?: boolean; note: string }) {
  return (
    <div className="perm-card">
      <div className="pm-head"><Icon name={icon} extra="sm" />{name}</div>
      <div className="sr-desc">{desc}</div>
      <div className="sr-control" style={{ marginTop: 8, display: "flex" }}>
        <Toggle defaultOn={defaultOn ?? false} label={name} />
        <span className="small muted" style={{ marginLeft: 8 }}>{note}</span>
      </div>
    </div>
  );
}

export function SettingsPage({
  theme,
  onSetTheme,
  onRoute,
}: {
  theme: "light" | "dark";
  onSetTheme: (theme: "light" | "dark") => void;
  onRoute: (route: PageRoute) => void;
}) {
  const [group, setGroup] = useState<GroupId>(() => takeSettingsIntent() ?? "general");
  const groupIndex = GROUPS.findIndex(([id]) => id === group);
  const { incoming, outgoing, dir, live, stageRef } = useOverlappingTabs(group, groupIndex);
  const pane = (id: GroupId) => ({
    className: `set-group ${tabPaneClass(tabPaneRole(id, incoming, outgoing, live), dir)}`,
    hidden: id !== incoming && id !== outgoing,
    "data-tab-pane": id,
    inert: id === outgoing ? true : undefined,
  });

  const openModelConfig = (tab: McTab) => {
    setModelConfigIntent({ tab });
    onRoute("model-config");
  };

  return (
    <div className="page-wide set-layout">
      <SlidingTabs
        id="setSide"
        ariaLabel="设置分组"
        value={group}
        onChange={setGroup}
        items={GROUPS.map(([id, icon, label]) => ({
          id,
          icon,
          label,
          buttonId: `setTab-${id}`,
          panelId: `set-${id}`,
        }))}
      />

      <div className="cap-main" id="setMain">
        <div className="cap-pane-stage" ref={stageRef}>
        {/* General */}
        <div {...pane("general")} id="set-general" role="tabpanel" aria-labelledby="setTab-general" tabIndex={0}>
          <h3>General</h3>
          <p className="desc">界面语言、主题与布局记忆。</p>
          <Row label="界面语言" desc="界面文案语言（概念术语保留英文）">
            <select className="select" defaultValue="中文"><option>中文</option><option>English</option></select>
          </Row>
          <Row label="主题" desc="Light / Dark（应用实时生效）">
            <select className="select" value={theme} onChange={(event) => onSetTheme(event.target.value as "light" | "dark")}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Row>
          <Row label="布局记忆" desc="侧栏宽度、上下区比例、面板状态按项目持久化">
            <Toggle defaultOn label="布局记忆" />
          </Row>
          <Row label="启动时恢复" desc="打开应用时恢复最近项目与对话">
            <Toggle defaultOn label="启动时恢复最近项目与对话" />
          </Row>
        </div>

        {/* Models and Providers */}
        <div {...pane("models")} id="set-models" role="tabpanel" aria-labelledby="setTab-models" tabIndex={0}>
          <h3>Models and Providers</h3>
          <p className="desc">Provider 认证、Endpoint、模型与角色路由都在「模型配置」页——这里只保留入口。</p>
          <button type="button" className="proj-card set-entry" onClick={() => openModelConfig("providers")}>
            <span className="a-ic purple" aria-hidden="true"><Icon name="server" extra="sm" /></span>
            <span className="se-main">
              <span className="pc-name">模型配置 · 供应商</span>
              <span className="sr-desc">Provider · 认证 · Endpoint · API 类型 · 模型 · Discovery · models.yml 实时预览</span>
            </span>
            <Icon name="chevron-r" extra="sm" />
          </button>
          <button type="button" className="proj-card set-entry" onClick={() => openModelConfig("roles")}>
            <span className="a-ic blue" aria-hidden="true"><Icon name="steering" extra="sm" /></span>
            <span className="se-main">
              <span className="pc-name">模型配置 · 角色</span>
              <span className="sr-desc">@default · @smol · @slow · @vision … 角色 → 模型路由 · Fallback · Global / Project 覆盖 · config.yml 预览</span>
            </span>
            <Icon name="chevron-r" extra="sm" />
          </button>
          <button type="button" className="proj-card set-entry" onClick={() => openModelConfig("subagents")}>
            <span className="a-ic green" aria-hidden="true"><Icon name="bot" extra="sm" /></span>
            <span className="se-main">
              <span className="pc-name">模型配置 · 子代理</span>
              <span className="sr-desc">task agent 定义 · 项目 / 用户 / 内置 · 工具与模型 · 系统提示 · config.yml 会话覆盖</span>
            </span>
            <Icon name="chevron-r" extra="sm" />
          </button>
          <Row label="默认模型" desc="新对话使用的模型（即 @default 角色的当前生效值）" style={{ marginTop: 14 }}>
            <button type="button" className="btn small outline" onClick={() => openModelConfig("roles")}>在「模型配置 · 角色」中管理</button>
          </Row>
        </div>

        {/* Permissions */}
        <div {...pane("permissions")} id="set-permissions" role="tabpanel" aria-labelledby="setTab-permissions" tabIndex={0}>
          <h3>Permissions</h3>
          <p className="desc">三种模式：<b>Review</b>（所有写操作需审批）· <b>Workspace</b>（工作区内自动允许）· <b>Full Access</b>（完全信任）。各能力对应 OMP capability 协商结果。</p>
          <Row label="权限模式" desc="OMP 授权粒度的整体默认">
            <select className="select" defaultValue="Workspace"><option>Review</option><option>Workspace</option><option>Full Access</option></select>
          </Row>
          <div className="perm-grid" style={{ marginTop: 12 }}>
            <PermCard icon="file" name="文件读取" desc="工作区内文件自动允许" defaultOn note="工作区内 · 自动" />
            <PermCard icon="pencil" name="文件写入" desc="写入工作区文件" defaultOn note="工作区内 · 自动" />
            <PermCard icon="unlock" name="工作区外访问" desc="读写工作区以外的路径" note="每次询问" />
            <PermCard icon="terminal" name="Bash" desc="执行 Shell 命令" note="每次询问" />
            <PermCard icon="network" name="网络访问" desc="发起 HTTP 请求" defaultOn note="域名白名单 · 3 条规则" />
            <PermCard icon="globe" name="Browser / Preview" desc="受控浏览器与 Preview 操作" defaultOn note="自动" />
            <PermCard icon="plug" name="MCP / Plugins" desc="第三方工具调用" note="每次询问" />
            <PermCard icon="monitor" name="桌面操作" desc="系统集成与外部编辑器" note="每次询问" />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="btn outline" disabled title={CONTRACT.rules}><Icon name="book" extra="sm" />管理「始终允许」规则</button>
            <button className="btn outline danger" disabled title={CONTRACT.clearRules}><Icon name="trash" extra="sm" />清除全部授权规则</button>
          </div>
        </div>

        {/* Sessions */}
        <div {...pane("sessions")} id="set-sessions" role="tabpanel" aria-labelledby="setTab-sessions" tabIndex={0}>
          <h3>Sessions</h3>
          <p className="desc">会话保存、自动命名、Checkpoint 与 Compact 策略。</p>
          <Row label="自动保存会话" desc="每个 Turn 结束后持久化到本地"><Toggle defaultOn label="自动保存会话" /></Row>
          <Row label="自动命名" desc="根据首条消息生成对话标题"><Toggle defaultOn label="自动命名" /></Row>
          <Row label="自动归档" desc="30 天未活跃的对话移入归档"><Toggle label="自动归档" /></Row>
          <Row label="Checkpoint" desc="关键节点自动创建（代码 + 对话）">
            <select className="select" defaultValue="每个 Turn 结束"><option>每个 Turn 结束</option><option>仅手动</option></select>
          </Row>
          <Row label="Compact 阈值" desc="Context 使用达到该比例时自动压缩">
            <select className="select" defaultValue="80%"><option>80%</option><option>70%</option><option>90%</option></select>
          </Row>
          <Row label="历史清理" desc="删除 90 天前的归档对话（不可恢复）">
            <button className="btn small danger" disabled title={CONTRACT.cleanup}>立即清理</button>
          </Row>
        </div>

        {/* Preview */}
        <div {...pane("preview")} id="set-preview" role="tabpanel" aria-labelledby="setTab-preview" tabIndex={0}>
          <h3>Preview</h3>
          <p className="desc">本地开发服务器与受控浏览器行为。</p>
          <Row label="启动命令" desc="留空则自动检测（package.json scripts）"><input className="input mono" defaultValue="npm run dev" /></Row>
          <Row label="包管理器" desc="安装依赖时优先使用">
            <select className="select" defaultValue="npm"><option>npm</option><option>pnpm</option><option>bun</option></select>
          </Row>
          <Row label="默认端口" desc="端口冲突时自动 +1"><input className="input mono" defaultValue="30141" /></Row>
          <Row label="自动启动" desc="打开项目时自动启动 Dev Server"><Toggle defaultOn label="自动启动" /></Row>
          <Row label="自动刷新" desc="文件变化后热更新页面"><Toggle defaultOn label="自动刷新" /></Row>
          <Row label="浏览器隔离" desc="受控浏览器使用独立 Profile"><Toggle defaultOn label="浏览器隔离" /></Row>
          <Row label="Console / Network 采集" desc="供 OMP 读取页面错误与请求">
            <select className="select" defaultValue="错误与失败请求"><option>错误与失败请求</option><option>全部</option><option>关闭</option></select>
          </Row>
        </div>

        {/* Advanced */}
        <div {...pane("advanced")} id="set-advanced" role="tabpanel" aria-labelledby="setTab-advanced" tabIndex={0}>
          <h3>Advanced</h3>
          <p className="desc">OMP 路径、RPC / Bridge 与实验性能力。修改前请确认你了解其影响。</p>
          <Row label="OMP 路径" desc="留空则自动检测"><input className="input mono" defaultValue="自动检测（omp）" /></Row>
          <Row label="配置目录" desc="OMP 配置与会话存储位置">
            <span className="mono small muted">不可用（路径已脱敏）</span>
            <button className="btn small outline" disabled title={CONTRACT.configDir}>打开</button>
          </Row>
          <Row label="日志级别" desc="OMP Logs 输出详细程度">
            <select className="select" defaultValue="info"><option>info</option><option>debug</option><option>warn</option></select>
          </Row>
          <Row label="RPC 超时" desc="单次调用超时时间（毫秒）"><input className="input mono" defaultValue="30000" /></Row>
          <Row label="Bridge 自动重启" desc="连接中断后自动重启 Bridge 进程"><Toggle defaultOn label="Bridge 自动重启" /></Row>
          <Row label="实验性能力" desc="启用 preview.dom v3、多 Preview 实例"><Toggle label="实验性能力" /></Row>
        </div>
        </div>
      </div>
    </div>
  );
}
