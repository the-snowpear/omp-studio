import type { WorkspaceRoute } from "../conversationWorkspace/model";
import { type CapTab } from "../pageIntents";
import type { ClientBootstrap, ClientError, ClientEvent, SessionHistoryEntry, SessionId, StudioClient, Unsubscribe, WorkspaceId } from "@omp-studio/client-contract";
import { type ClientState } from "@omp-studio/client";
import { type ShellEventLogEntry } from "../shellMemory";
import { type FileMenuAction, type FileMenuTarget, type FileOpenerOption } from "../menus";
import { type ShellModel as Model } from "../shellModelLoader";
import { type ProvisionalProjectThread } from "../sidebar/provisionalThread";
import { type ThreadWaitKind } from "../sidebar/threadWait";
import { type ProjectHistoryCache } from "../sidebar/useProjectHistories";
import { type SelectedProject } from "./sessionSelection";

export type ClientStateSource = StudioClient & {
  getState?: () => ClientState;
  onState?: (listener: (state: ClientState) => void) => Unsubscribe;
};

export type Route = WorkspaceRoute;

export type SecondaryRoute = Exclude<Route, "workbench">;

export type ViewState = {
  loading: boolean;
  bootstrap?: ClientBootstrap;
  clientState?: ClientState;
  model: Model;
  error?: ClientError;
  hostError?: ClientError;
  events: ShellEventLogEntry[];
  route: Route;
};

export type Action =
  | { type: "ready"; bootstrap: ClientBootstrap; clientState?: ClientState; hostError?: ClientError }
  | { type: "state"; clientState: ClientState }
  | { type: "model"; model: Model }
  | { type: "error"; error: ClientError }
  | { type: "event"; event: ClientEvent };

export type ShellDialog = "about" | "shortcuts";

export type ArchivePending =
  | { kind: "preview"; threadId: string; title: string; streaming: boolean }
  | { kind: "real"; entry: SessionHistoryEntry; streaming: boolean; workspaceId?: WorkspaceId };

/** 侧栏会话行 ⋯ 菜单可执行的会话动作（与顶栏「对话选项」同一套）。 */
export type ThreadRowActionKind = "rename" | "pin" | "fork" | "handoff" | "compact" | "export";

export type ShellChrome = {
  collapsed: boolean;
  skillsOpen: boolean;
  explorerOpen: boolean;
  /** 当前选中项目的会话列表是否展开（项目头 chevron 可收起，ver1/ver2 语义）。 */
  projectListExpanded: boolean;
  /** Real-mode project rows keep independent expansion state. */
  expandedProjects: ReadonlySet<string>;
  /** Real-mode active history, keyed by opaque workspace id. */
  projectHistories: ProjectHistoryCache;
  /** Real mode: the project list is still being fetched. */
  projectsLoading: boolean;
  /** Renderer-only rows for fresh sessions with a draft or accepted prompt. */
  provisionalThreads: ReadonlyArray<ProvisionalProjectThread>;
  /** Current blank-history workbench, used only for active-row styling. */
  activeProvisionalSessionId?: SessionId;
  theme: "light" | "dark";
  sidebarWidth: number;
  splitRatio: number;
  selectedHistoryId: string | null;
  selectedProject: SelectedProject | null;
  skillsEnabledCount: number;
  previewProjectId: string;
  previewThreadId: string;
  /** PreviewDeck 当前卡（t3）对应的侧栏胶囊；undefined = 队列已空。 */
  previewDeckWait?: ThreadWaitKind;
  onToggleSidebar: () => void;
  onToggleSkills: () => void;
  onSkillsEnabledCount: (count: number) => void;
  onToggleExplorer: () => void;
  onToggleTheme: () => void;
  onResizeSidebar: (width: number) => void;
  onResizeSplit: (ratio: number) => void;
  onSelectProject: (project: SelectedProject) => void;
  /** 项目头点击：已展开的项目收起会话列表（保持选中），否则选中并展开。 */
  onToggleProject: (project: SelectedProject) => void;
  /** Lazy-load one project's active history when its row is expanded. */
  onLoadProjectHistory: (workspaceId: string) => void;
  onSelectThread: (entry: SessionHistoryEntry, workspaceId?: WorkspaceId) => void;
  /** Select a submitted session before its persisted history row has replaced the provisional row. */
  onSelectProvisionalThread: (thread: ProvisionalProjectThread) => void;
  onSelectPreviewProject: (id: string) => void;
  onSelectPreviewThread: (id: string) => void;
  onPickProject: () => void;
  /** 左上应用菜单「新建项目」：打开工作台已有的创建项目对话框。 */
  onCreateProject: () => void;
  onStartNewChat: () => void;
  /** 项目行悬停「＋」：切换到该项目（必要时 workspace.open）并新建会话。 */
  onStartChatInProject: (project: SelectedProject) => void;
  /** 会话行悬停「归档」：打开确认弹窗；确认后仅预览模式本地隐藏。 */
  onArchivePreviewThread: (threadId: string) => void;
  /** 真实模式「归档」：打开确认弹窗；确认后 session.archive，会话物理移入 OMP 冷归档（gzip）。 */
  onArchiveThread: (entry: SessionHistoryEntry, workspaceId?: WorkspaceId) => void;
  /** Resolve and archive a submitted session whose sidebar row is still provisional. */
  onArchiveProvisionalThread: (thread: ProvisionalProjectThread) => void;
  /** 历史页「取消归档」：session.unarchive，恢复到进行中列表。 */
  onUnarchiveThread: (entry: SessionHistoryEntry) => void;
  /** 历史页「删除会话」：session.delete，永久删除本地文件与相关残留。 */
  onDeleteSessionThread: (entry: SessionHistoryEntry, deleteManagedArtifacts?: boolean) => Promise<boolean>;
  /** 顶栏「对话选项」：打开重命名对话框（builtin.rename，标题持久化到会话槽）。 */
  onRenameThread: () => void;
  /** 顶栏「对话选项」：Fork 当前会话（session.fork，Runtime 身份切换）。 */
  onForkThread: () => void;
  /** 顶栏「对话选项」：Handoff 到新会话（session.handoff，LLM 摘要 + 新会话）。 */
  onHandoffThread: () => void;
  /** 顶栏「对话选项」：Compact 当前上下文（builtin.compact，默认模式）。 */
  onCompactThread: () => void;
  /** 用户已点 Compact / 输入 /compact，命令尚未结束。 */
  compactPending: boolean;
  /** 压缩进行中：取消当前压缩（core.abort，与原生 Esc 同语义）。 */
  onCancelCompact: () => void;
  /** 顶栏「对话选项」：导出对话 HTML（builtin.export，路径来自命令输出）。 */
  onExportThread: () => void;
  /** 侧栏会话行 ⋯ 菜单：先打开（必要时 resume）所在行会话，再执行顶栏同款动作。 */
  onThreadRowAction: (entry: SessionHistoryEntry, workspaceId: WorkspaceId | undefined, action: ThreadRowActionKind) => void;
  /** 顶栏「归档」的目标会话；undefined = 不可用（原因见 archiveTargetReason）。 */
  archiveTarget: SessionHistoryEntry | undefined;
  archiveTargetReason: string | undefined;
  /** 驻留 Runtime 正在使用的 sessionId；归档该会话时 Host 会先停止再移走文件。 */
  residentSessionId: string | undefined;
  /** 「展开更多」：该项目已展开的会话数 +10，必要时重查 history.list。 */
  onLoadMoreThreads: (projectId: string) => void;
  /** 各项目当前展开的会话条数（缺省 = PROJECT_THREADS_INITIAL）。 */
  projectThreadLimits: Record<string, number>;
  /** 预览模式被「归档」隐藏的演示会话 id。 */
  hiddenPreviewThreads: ReadonlySet<string>;
  onOpenCapabilities: (tab?: CapTab, name?: string) => void;
  onOpenPalette: () => void;
  paletteOpen: boolean;
  onToggleOmpMenu: () => void;
  ompMenuOpen: boolean;
  /** 左上应用菜单：打开 shortcuts / about 对话框。 */
  onOpenDialog: (dialog: ShellDialog) => void;
  /** 左上应用菜单「打开终端」：切到终端页签并展开底部面板（Ctrl J 同款语义）。 */
  onOpenTerminalPanel: () => void;
  /** 项目 shell 动作（AppShell 统一实现，顶栏面包屑菜单与侧栏应用菜单共用）。 */
  onOpenProjectInEditor: () => void;
  onOpenProjectDirectory: () => void;
  /** undefined = 可用；否则为禁用原因（无真实 workspace / 非桌面端）。 */
  projectShellUnavailable: string | undefined;
  /** 进行中的 shell 动作类型；null = 空闲。 */
  projectShellAction: "editor" | "directory" | null;
  onAddComposerContext: (chip: { kind: "file" | "dir"; path: string; label: string }) => void;
  /** Explorer 文件「更多」菜单：本机已安装编辑器（「打开方式」子菜单数据）。 */
  fileOpeners: ReadonlyArray<FileOpenerOption>;
  /** undefined = 可用；否则为文件级桌面动作的禁用原因（非桌面端）。 */
  fileShellUnavailable: string | undefined;
  /** Explorer 文件「更多」菜单动作分发（打开 / 打开方式 / 资源管理器 / 复制路径）。 */
  onFileShellAction: (workspaceId: string, action: FileMenuAction, target: FileMenuTarget) => void;
  onInsertSkill: (skill: { name: string; desc?: string }) => void;
  onRemoveComposerSkill: (name: string) => void;
  draftSkills: ReadonlySet<string>;
  usedSkills: ReadonlySet<string>;
};

export type ProjectShellActionResult =
  | { readonly status: "opened"; readonly editorName?: string }
  | { readonly status: "cancelled" };
