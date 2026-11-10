import { useOpenFile } from "../files/fileLinks";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent as ReactFormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type { StudioClient, WorkspaceId, WorkspaceFileNode, WorkspaceFileTreeReadModel } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { fileTypeOf, iconNameFor, isNoiseDir, isSensitive } from "../explorer-types";
import { FileRowMenu, type FileMenuAction, type FileMenuController, type FileMenuTarget, type FileOpenerOption } from "../menus";
import { useI18n } from "../i18n";
import { hostErrorMessage } from "../hostError";
import { explorerRowActivity, EMPTY_EXPLORER_FILE_ACTIVITY, type ExplorerFileActivity } from "../conversation/explorerFileActivity";
import { readExplorerExpansion, writeExplorerExpansion } from "./expandMemory";
import { GIT_STATUS_META, type TreeGitStatus } from "../git/treeStatus";

export type WorkspaceCreationKind = "file" | "directory";

function filterWorkspaceNodes(nodes: ReadonlyArray<WorkspaceFileNode>, query: string): ReadonlyArray<WorkspaceFileNode> {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((node) => {
    const children = node.children ? filterWorkspaceNodes(node.children, query) : [];
    return node.name.toLowerCase().includes(needle) || children.length > 0
      ? [{ ...node, ...(node.type === "dir" ? { children } : {}) }]
      : [];
  });
}

function findWorkspaceNode(nodes: ReadonlyArray<WorkspaceFileNode>, path: string): WorkspaceFileNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = node.children ? findWorkspaceNode(node.children, path) : undefined;
    if (found) return found;
  }
  return undefined;
}

function replaceWorkspaceChildren(nodes: ReadonlyArray<WorkspaceFileNode>, path: string, children: ReadonlyArray<WorkspaceFileNode>): ReadonlyArray<WorkspaceFileNode> {
  return nodes.map((node) => {
    if (node.path === path) return { ...node, children };
    return node.children ? { ...node, children: replaceWorkspaceChildren(node.children, path, children) } : node;
  });
}

type VisibleWorkspaceNode = {
  readonly node: WorkspaceFileNode;
  readonly parentPath?: string;
};

function flattenVisibleWorkspaceNodes(
  nodes: ReadonlyArray<WorkspaceFileNode>,
  expanded: ReadonlySet<string>,
  parentPath?: string,
): ReadonlyArray<VisibleWorkspaceNode> {
  const visible: VisibleWorkspaceNode[] = [];
  for (const node of nodes) {
    visible.push({ node, ...(parentPath ? { parentPath } : {}) });
    if (node.type === "dir" && expanded.has(node.path) && node.children) {
      visible.push(...flattenVisibleWorkspaceNodes(node.children, expanded, node.path));
    }
  }
  return visible;
}

function expandedWorkspacePathsForSearch(nodes: ReadonlyArray<WorkspaceFileNode>, expanded: ReadonlySet<string>, search: string): Set<string> {
  const next = new Set(expanded);
  if (!search.trim()) return next;
  const visit = (items: ReadonlyArray<WorkspaceFileNode>): void => {
    for (const item of items) {
      if (item.type === "dir" && item.children && item.children.length > 0) {
        next.add(item.path);
        visit(item.children);
      }
    }
  };
  visit(nodes);
  return next;
}

/** Explorer 行内 git 状态徽章：行尾彩色字母 + 文件名着色双通道，目录显示聚合后的后代状态。 */
function GitTreeBadge({ status }: { status?: TreeGitStatus | undefined }) {
  if (status === undefined) return null;
  const meta = GIT_STATUS_META[status];
  return (
    <span className={`fstat ${meta.className}`}>
      <span aria-hidden="true">{meta.letter}</span>
      <span className="sr-only"> {meta.label}</span>
    </span>
  );
}

/** Agent 正在读/写该路径时才出现；平时不占位。红 = Read，绿 = Write/Edit。 */
function TreeLiveDots({ reading, writing }: { reading: boolean; writing: boolean }) {
  const { t } = useI18n();
  if (!reading && !writing) return null;
  return (
    <span className="live">
      {reading ? <span className="dot red pulse" role="img" aria-label={t("common.reading")} data-tip={t("common.reading")} /> : null}
      {writing ? <span className="dot green pulse" role="img" aria-label={t("common.writing")} data-tip={t("common.writing")} /> : null}
    </span>
  );
}

/** Explorer 行「⋯ 更多」菜单的下发束见 menus.tsx 的 FileMenuController。 */
type TreeFileMenu = FileMenuController;

function WorkspaceTreeNodes({
  nodes,
  depth,
  parentPath,
  expanded,
  loadingPaths,
  activePath,
  registerNode,
  createKind,
  createParentPath,
  createName,
  createBusy,
  createError,
  createInputRef,
  onCreateNameChange,
  onCreateSubmit,
  onCreateCancel,
  onSelect,
  onKeyDown,
  onToggle,
  onFile,
  onContext,
  fileMenu,
  gitStatus,
  fileActivity = EMPTY_EXPLORER_FILE_ACTIVITY,
}: {
  nodes: ReadonlyArray<WorkspaceFileNode>;
  depth: number;
  parentPath?: string;
  expanded: Set<string>;
  loadingPaths: Set<string>;
  activePath: string | null;
  registerNode: (path: string, element: HTMLDivElement | null) => void;
  createKind: WorkspaceCreationKind | null;
  createParentPath: string | undefined;
  createName: string;
  createBusy: boolean;
  createError: string | undefined;
  createInputRef: { current: HTMLInputElement | null };
  onCreateNameChange: (value: string) => void;
  onCreateSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  onCreateCancel: () => void;
  onSelect: (path: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, node: WorkspaceFileNode, parentPath?: string) => void;
  onToggle: (path: string) => void;
  onFile: (path: string) => void;
  onContext: (path: string, kind: "file" | "dir") => void;
  fileMenu: TreeFileMenu;
  gitStatus?: ReadonlyMap<string, TreeGitStatus> | undefined;
  fileActivity?: ExplorerFileActivity;
}) {
  const { t } = useI18n();
  const showCreate = createKind !== null && createParentPath === parentPath;
  const createPad = { ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties;
  useEffect(() => {
    if (!showCreate) return;
    const input = createInputRef.current;
    input?.focus();
    input?.scrollIntoView?.({ block: "nearest" });
  }, [createInputRef, createParentPath, showCreate]);
  return <>
    {nodes.map((node, index) => {
      const pad = { ["--depth-pad" as string]: `${depth * 14 + 6}px` } as CSSProperties;
      const gitStat = gitStatus?.get(node.path);
      const gitClass = gitStat === undefined ? undefined : GIT_STATUS_META[gitStat].className;
      const live = explorerRowActivity(node.path, node.type === "dir", fileActivity);
      if (node.type === "dir") {
        const open = expanded.has(node.path);
        return <div key={node.path}>
          <div
            ref={(element) => registerNode(node.path, element)}
            className={`tree-row${open ? " open" : ""}`}
            data-dir={node.path}
            data-git={gitClass}
            data-noise={isNoiseDir(node.name) || undefined}
            role="treeitem"
            aria-expanded={open}
            aria-selected={activePath === node.path}
            aria-busy={loadingPaths.has(node.path) || undefined}
            aria-level={depth + 1}
            aria-posinset={index + 1}
            aria-setsize={nodes.length}
            aria-label={`${node.name} ${t("nav.folder")}`}
            tabIndex={activePath === node.path ? 0 : -1}
            style={pad}
            onFocus={() => onSelect(node.path)}
            onClick={() => { onSelect(node.path); onToggle(node.path); }}
            onContextMenu={(event) => fileMenu.onContext(event, node.path)}
            onKeyDown={(event) => onKeyDown(event, node, parentPath)}
          >
            <span className="tw"><Icon name="chevron-r" extra="sm" /></span>
            <span className="fi"><Icon name={open ? "folder-open" : "folder"} /></span>
            <span className="fname ellipsis">{node.name}</span>
            <TreeLiveDots reading={live.reading} writing={live.writing} />
            <GitTreeBadge status={gitStat} />
            <span className="fop">
              <button type="button" className="icon-btn" data-tip={t("shell.addContext")} aria-label={`${t("shell.addContext")} ${node.path}`} onClick={(event) => { event.stopPropagation(); onContext(node.path, "dir"); }}><Icon name="at" /></button>
              <FileRowMenu
                id={node.path}
                openId={fileMenu.openId}
                onToggle={fileMenu.onToggle}
                contextPoint={fileMenu.openId === node.path ? fileMenu.point : null}
                target={{ path: node.path, name: node.name, kind: "dir" }}
                openers={fileMenu.openers}
                desktopActionsReason={fileMenu.desktopReason}
                onAction={fileMenu.onAction}
              />
            </span>
          </div>
          <div className="tree-children" role="group">
            {loadingPaths.has(node.path) ? (
              <div className="tree-row muted" style={{ ["--depth-pad" as string]: `${(depth + 1) * 14 + 6}px` } as CSSProperties} role="status">
                <span className="tw" />
                <span className="fi"><span className="spinner" aria-hidden="true" /></span>
                <span className="fname ellipsis">{t("common.reading")}</span>
              </div>
            ) : node.children ? <WorkspaceTreeNodes nodes={node.children} depth={depth + 1} parentPath={node.path} expanded={expanded} loadingPaths={loadingPaths} activePath={activePath} registerNode={registerNode} createKind={createKind} createParentPath={createParentPath} createName={createName} createBusy={createBusy} createError={createError} createInputRef={createInputRef} onCreateNameChange={onCreateNameChange} onCreateSubmit={onCreateSubmit} onCreateCancel={onCreateCancel} onSelect={onSelect} onKeyDown={onKeyDown} onToggle={onToggle} onFile={onFile} onContext={onContext} fileMenu={fileMenu} fileActivity={fileActivity} {...(gitStatus !== undefined ? { gitStatus } : {})} /> : null}
          </div>
        </div>;
      }
      // 色与形是两个正交轴：ftype 只决定颜色（CSS 从 data-ftype 派生），
      // 形状交给 iconNameFor() —— README.md 因此能既是「中性文档」又是「书」。
      const ftype = fileTypeOf(node.name);
      return <div
        ref={(element) => registerNode(node.path, element)}
        key={node.path}
        className="tree-row"
        data-file={node.path}
        data-git={gitClass}
        data-ftype={ftype ?? undefined}
        data-secret={isSensitive(node.name) || undefined}
        data-noise={isNoiseDir(node.name) || undefined}
        role="treeitem"
        aria-selected={activePath === node.path}
        aria-label={`${node.name} ${t("nav.file")}`}
        aria-level={depth + 1}
        aria-posinset={index + 1}
        aria-setsize={nodes.length}
        tabIndex={activePath === node.path ? 0 : -1}
        style={pad}
        onFocus={() => onSelect(node.path)}
        onClick={() => { onSelect(node.path); onFile(node.path); }}
        onContextMenu={(event) => fileMenu.onContext(event, node.path)}
        onKeyDown={(event) => onKeyDown(event, node, parentPath)}
      >
        <span className="tw" />
        <span className="fi"><Icon name={iconNameFor(ftype, node.name)} /></span>
        <span className="fname ellipsis">{node.name}</span>
        <TreeLiveDots reading={live.reading} writing={live.writing} />
        <GitTreeBadge status={gitStat} />
        <span className="fop">
          <button type="button" className="icon-btn" data-tip={t("shell.addContext")} aria-label={`${t("shell.addContext")} ${node.path}`} onClick={(event) => { event.stopPropagation(); onContext(node.path, "file"); }}><Icon name="at" /></button>
          <FileRowMenu
            id={node.path}
            openId={fileMenu.openId}
            onToggle={fileMenu.onToggle}
            contextPoint={fileMenu.openId === node.path ? fileMenu.point : null}
            target={{ path: node.path, name: node.name, kind: "file" }}
            openers={fileMenu.openers}
            desktopActionsReason={fileMenu.desktopReason}
            onAction={fileMenu.onAction}
          />
        </span>
      </div>;
    })}
    {showCreate ? (
      <>
        <form className="tree-new-row" style={createPad} onSubmit={onCreateSubmit}>
          <span className="tw" />
          <span className="fi"><Icon name={createKind === "file" ? "file" : "folder"} /></span>
          <input
            ref={(element) => { createInputRef.current = element; }}
            className="input"
            value={createName}
            onChange={(event) => onCreateNameChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCreateCancel(); } }}
            placeholder={createKind === "file" ? t("shell.fileName") : t("shell.folderName")}
            aria-label={createKind === "file" ? t("shell.newFileName") : t("shell.newFolderName")}
            disabled={createBusy}
            autoFocus
          />
          <button type="submit" className="icon-btn" data-tip={t("common.create")} aria-label={t("common.create")} disabled={createBusy}><Icon name="check" extra="sm" /></button>
          <button type="button" className="icon-btn" data-tip={t("common.cancel")} aria-label={t("common.cancel")} disabled={createBusy} onClick={onCreateCancel}><Icon name="x" extra="sm" /></button>
        </form>
        {createBusy ? <div className="tree-new-status muted tiny" style={createPad} role="status">{t("common.loading")}</div> : null}
        {createError ? <div className="tree-new-status error tiny" style={createPad} role="alert">{createError}</div> : null}
      </>
    ) : null}
  </>;
}

const EMPTY_FILE_OPENERS: ReadonlyArray<FileOpenerOption> = [];

export function RealFileTree({ client, workspaceId, label, refreshToken, search, gitStatus, fileActivity = EMPTY_EXPLORER_FILE_ACTIVITY, createKind, createParentPath, createName, createBusy, createError, createInputRef, onCreateNameChange, onCreateSubmit, onCreateCancel, onSelectionChange, onAddContext, fileOpeners = EMPTY_FILE_OPENERS, fileShellUnavailable, onFileAction }: {
  client: StudioClient;
  workspaceId: WorkspaceId;
  label: string;
  refreshToken: number;
  search: string;
  gitStatus?: ReadonlyMap<string, TreeGitStatus> | undefined;
  fileActivity?: ExplorerFileActivity;
  createKind: WorkspaceCreationKind | null;
  createParentPath: string | undefined;
  createName: string;
  createBusy: boolean;
  createError: string | undefined;
  createInputRef: { current: HTMLInputElement | null };
  onCreateNameChange: (value: string) => void;
  onCreateSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  onCreateCancel: () => void;
  onSelectionChange?: (node: WorkspaceFileNode | undefined) => void;
  onAddContext?: (path: string, kind: "file" | "dir") => void;
  /** 「打开方式」子菜单的已安装编辑器清单（App 侧拉取）。 */
  fileOpeners?: ReadonlyArray<FileOpenerOption>;
  /** undefined = 文件级桌面动作可用；否则为禁用原因（非桌面端）。 */
  fileShellUnavailable?: string | undefined;
  /** 除「目录展开 / 添加上下文」外的菜单动作分发（App 侧统一 toast 与桌面调用）。 */
  onFileAction?: (action: FileMenuAction, target: FileMenuTarget) => void;
}) {
  const openInViewer = useOpenFile();
  const executionTarget = useExecutionTarget();
  const [model, setModel] = useState<WorkspaceFileTreeReadModel | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const expandedRef = useRef(new Set<string>());
  /* 待恢复的记忆展开路径（相对 workspaceId）；null = 无恢复在进行。 */
  const pendingRestoreRef = useRef<ReadonlySet<string> | null>(null);
  const loadingPathsRef = useRef(new Set<string>());
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const typeaheadRef = useRef<{ value: string; timeout?: ReturnType<typeof setTimeout> }>({ value: "" });
  const generationRef = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const next = await client.query("workspace.fileTree", { workspaceId });
      if (generation !== generationRef.current) return;
      setModel(next);
      expandedRef.current = new Set();
      setExpanded(expandedRef.current);
      const remembered = readExplorerExpansion(String(workspaceId));
      pendingRestoreRef.current = remembered.size > 0 ? remembered : null;
      setActivePath(next.nodes[0]?.path ?? null);
      onSelectionChange?.(undefined);
      loadingPathsRef.current.clear();
      setLoadingPaths(new Set());
      setMessage(undefined);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setModel(null);
      setMessage(hostErrorMessage(error, "文件树加载失败"));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [client, onSelectionChange, workspaceId]);
  useEffect(() => { void refresh(); }, [refresh, refreshToken, executionTarget.syncRevision]);
  const visible = useMemo(() => filterWorkspaceNodes(model?.nodes ?? [], search), [model?.nodes, search]);
  const displayExpanded = useMemo(() => expandedWorkspacePathsForSearch(visible, expanded, search), [expanded, search, visible]);
  const visibleItems = useMemo(() => flattenVisibleWorkspaceNodes(visible, displayExpanded), [displayExpanded, visible]);
  useEffect(() => {
    if (activePath === null || visibleItems.some(({ node }) => node.path === activePath)) return;
    setActivePath(visibleItems[0]?.node.path ?? null);
  }, [activePath, visibleItems]);
  useEffect(() => () => {
    if (typeaheadRef.current.timeout !== undefined) clearTimeout(typeaheadRef.current.timeout);
  }, []);
  const loadDirectory = useCallback(async (path: string) => {
    if (loadingPathsRef.current.has(path)) return;
    const generation = generationRef.current;
    loadingPathsRef.current.add(path);
    setLoadingPaths(new Set(loadingPathsRef.current));
    try {
      const next = await client.query("workspace.fileTree", { workspaceId, path });
      if (generation !== generationRef.current) return;
      setModel((current) => current === null ? current : { ...current, nodes: replaceWorkspaceChildren(current.nodes, path, next.nodes) });
      setMessage(undefined);
    } catch (error) {
      if (generation === generationRef.current) {
        const next = new Set(expandedRef.current);
        next.delete(path);
        expandedRef.current = next;
        setExpanded(next);
        setMessage(hostErrorMessage(error, `无法展开 ${path}`));
      }
    } finally {
      loadingPathsRef.current.delete(path);
      if (generation === generationRef.current) setLoadingPaths(new Set(loadingPathsRef.current));
    }
  }, [client, workspaceId]);
  /* 启动 / 刷新后恢复记忆的目录展开：目录 children 懒加载，路径逐级可见，
     每次模型更新推进一层，直到全部落地或没有更多可加载的目录。 */
  useEffect(() => {
    if (model === null) return;
    const pending = pendingRestoreRef.current;
    if (pending === null) return;
    let next: Set<string> | undefined;
    for (const path of pending) {
      if (findWorkspaceNode(model.nodes, path)?.type !== "dir") continue;
      if (!expandedRef.current.has(path)) {
        next ??= new Set(expandedRef.current);
        next.add(path);
      }
    }
    if (next) {
      expandedRef.current = next;
      setExpanded(next);
    }
    let loading = false;
    for (const path of pending) {
      const node = findWorkspaceNode(model.nodes, path);
      if (node?.type === "dir" && node.children === undefined) {
        void loadDirectory(path);
        loading = true;
      }
    }
    if (!loading) pendingRestoreRef.current = null;
  }, [loadDirectory, model]);
  useEffect(() => {
    if (createKind === null || createParentPath === undefined || model === null) return;
    const target = findWorkspaceNode(model.nodes, createParentPath);
    if (target?.type !== "dir") return;
    if (!expandedRef.current.has(createParentPath)) {
      const next = new Set(expandedRef.current);
      next.add(createParentPath);
      expandedRef.current = next;
      setExpanded(next);
    }
    if (target.children === undefined) void loadDirectory(createParentPath);
  }, [createKind, createParentPath, loadDirectory, model]);
  const toggle = useCallback((path: string) => {
    /* 用户手动切换后剩余恢复让位于当前操作，并按现状更新记忆。 */
    pendingRestoreRef.current = null;
    const open = expandedRef.current.has(path);
    const next = new Set(expandedRef.current);
    if (open) next.delete(path); else next.add(path);
    expandedRef.current = next;
    setExpanded(next);
    writeExplorerExpansion(String(workspaceId), next);
    if (!open && model && findWorkspaceNode(model.nodes, path)?.children === undefined) void loadDirectory(path);
  }, [loadDirectory, model, workspaceId]);
  const registerNode = useCallback((path: string, element: HTMLDivElement | null) => {
    if (element) nodeRefs.current.set(path, element);
    else nodeRefs.current.delete(path);
  }, []);
  const focusNode = useCallback((path: string) => {
    setActivePath(path);
    nodeRefs.current.get(path)?.focus();
  }, []);
  const openFile = useCallback((path: string) => {
    setActivePath(path);
    openInViewer({ workspaceId: String(workspaceId), path });
  }, [workspaceId, openInViewer]);
  const selectPath = useCallback((path: string) => {
    setActivePath(path);
    const node = model === null ? undefined : findWorkspaceNode(model.nodes, path);
    onSelectionChange?.(node);
  }, [model, onSelectionChange]);
  const clearBlankSelection = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("[role=\"treeitem\"], form, input, button")) return;
    setActivePath(null);
    onSelectionChange?.(undefined);
  }, [onSelectionChange]);
  const handleTreeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>, node: WorkspaceFileNode, parentPath?: string) => {
    if (event.target !== event.currentTarget) return;
    const index = visibleItems.findIndex((item) => item.node.path === node.path);
    if (index < 0) return;
    const focusAt = (nextIndex: number): void => {
      const item = visibleItems[nextIndex];
      if (item) focusNode(item.node.path);
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(Math.min(visibleItems.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(Math.max(0, index - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusAt(visibleItems.length - 1);
      return;
    }
    if (event.key === "ArrowRight" && node.type === "dir") {
      event.preventDefault();
      if (!displayExpanded.has(node.path)) toggle(node.path);
      else focusAt(index + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (node.type === "dir" && displayExpanded.has(node.path) && !search.trim()) toggle(node.path);
      else if (parentPath) focusNode(parentPath);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (node.type === "dir") toggle(node.path);
      else openFile(node.path);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) return;
    const typed = event.key.toLocaleLowerCase();
    const previous = typeaheadRef.current.value;
    const findMatch = (needle: string): VisibleWorkspaceNode | undefined => {
      for (let offset = 1; offset <= visibleItems.length; offset += 1) {
        const candidate = visibleItems[(index + offset) % visibleItems.length];
        if (candidate?.node.name.toLocaleLowerCase().startsWith(needle)) return candidate;
      }
      return undefined;
    };
    let value = `${previous}${typed}`;
    let match = findMatch(value);
    if (!match && previous) {
      value = typed;
      match = findMatch(value);
    }
    if (!match) return;
    event.preventDefault();
    if (typeaheadRef.current.timeout !== undefined) clearTimeout(typeaheadRef.current.timeout);
    typeaheadRef.current.value = value;
    typeaheadRef.current.timeout = setTimeout(() => { typeaheadRef.current.value = ""; }, 700);
    focusNode(match.node.path);
  }, [displayExpanded, focusNode, openFile, search, toggle, visibleItems]);
  const { t } = useI18n();
  // 行「⋯ 更多」菜单：同一时刻至多一个弹层；Escape / 点外部关闭（会话行菜单同款）。
  const [fileMenuOpenId, setFileMenuOpenId] = useState<string | null>(null);
  /** 非 null = 当前弹层由行右键打开，贴该光标点；null = 由 ⋯ 按钮打开。 */
  const [fileMenuPoint, setFileMenuPoint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (fileMenuOpenId === null) return;
    const close = () => setFileMenuOpenId(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [fileMenuOpenId]);
  const toggleFileMenu = useCallback((id: string | null) => {
    // 按钮打开一律锚定按钮，清掉旧右键点。
    setFileMenuPoint(null);
    setFileMenuOpenId(id);
  }, []);
  const openFileMenuAtCursor = useCallback((event: { clientX: number; clientY: number; preventDefault(): void }, path: string) => {
    event.preventDefault();
    setFileMenuPoint({ x: event.clientX, y: event.clientY });
    setFileMenuOpenId(path);
  }, []);
  const handleMenuAction = useCallback((action: FileMenuAction, target: FileMenuTarget) => {
    if (action.type === "addContext") {
      onAddContext?.(target.path, target.kind);
      return;
    }
    // 目录的「打开」= 树内展开/收起（与点击目录行同一条 toggle 链）。
    if (action.type === "open" && target.kind === "dir") {
      toggle(target.path);
      return;
    }
    if (action.type === "open") { openFile(target.path); return; }
    onFileAction?.(action, target);
  }, [onAddContext, onFileAction, toggle, openFile]);
  const fileMenu = useMemo<TreeFileMenu>(() => ({
    openId: fileMenuOpenId,
    point: fileMenuPoint,
    openers: fileOpeners,
    desktopReason: fileShellUnavailable ?? (onFileAction === undefined ? t("shell.fileDesktopOnly") : undefined),
    onToggle: toggleFileMenu,
    onContext: openFileMenuAtCursor,
    onAction: handleMenuAction,
  }), [fileMenuOpenId, fileMenuPoint, fileOpeners, fileShellUnavailable, handleMenuAction, onFileAction, openFileMenuAtCursor, t, toggleFileMenu]);
  if (loading && model === null) return <div className="empty"><p className="muted small">{t("common.reading")}</p></div>;
  if (model === null) return <div className="empty"><p className="muted small">{message ?? t("common.unavailable")}</p></div>;
  return <>
    {message ? <div className="muted tiny" role="status" style={{ padding: "2px 12px 6px" }}>{message}</div> : null}
    <div className="tree" role="tree" aria-label={label} onClick={clearBlankSelection}>
      <WorkspaceTreeNodes
        nodes={visible}
        depth={0}
        expanded={displayExpanded}
        loadingPaths={loadingPaths}
        activePath={activePath}
        registerNode={registerNode}
        createKind={createKind}
        createParentPath={createParentPath}
        createName={createName}
        createBusy={createBusy}
        createError={createError}
        createInputRef={createInputRef}
        onCreateNameChange={onCreateNameChange}
        onCreateSubmit={onCreateSubmit}
        onCreateCancel={onCreateCancel}
        onSelect={selectPath}
        onKeyDown={handleTreeKeyDown}
        onToggle={toggle}
        onFile={openFile}
        onContext={(path, kind) => {
          onAddContext?.(path, kind);
        }}
        fileMenu={fileMenu}
        gitStatus={gitStatus}
        fileActivity={fileActivity}
      />
    </div>
    <div className="sr-only" aria-live="polite">{loading ? t("common.loading") : ""}</div>
    <span className="sr-only">{model.nodes.length}</span>
  </>;
}
