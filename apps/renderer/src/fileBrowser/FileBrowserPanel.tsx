import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { PLATFORM } from "../platform";
import { usePreviewMode } from "../preview/PreviewContext";
import { useWidthTier } from "../layout/useWidthTier";
import { baseName, COMPUTER, effectiveView, parentPath, samePath, VIEW_STEPS, type FileBrowserSource, type FsDirectory, type FsEntry, type FsPeek } from "./model";
import { useFileBrowser } from "./useFileBrowser";
import { ColumnsView, ListView, PreviewCard, TreeView, type RowActions } from "./FileBrowserViews";
import { MenuEntries, PlacesList, PlacesSidebar, Popover, StatusBar, Toolbar, TrashDialog, type MenuEntry } from "./FileBrowserChrome";
import "./fileBrowser.css";

export type FileBrowserSystemAction = "openSystem" | "reveal" | "openAsProject";

export interface FileBrowserPanelProps {
  /** Dock 实例 id（`file-browser` / `file-browser@2`），每个实例各自记住位置与视图。 */
  panelId: string;
  /** null = 当前没有可用的数据来源（真实模式下 Host 尚未提供全机文件读模型）。 */
  source: FileBrowserSource | null;
  /** 记忆与固定文件夹的作用域：预览 / 真实、本机 / 哪台 SSH 分开记。 */
  scope: string;
  /** 没有来源时显示的原因。 */
  unavailable?: { title: string; detail: string } | undefined;
  /** 打开文件：交给现有文件窗口。没有接上时菜单项置灰。 */
  onOpenFile?: ((entry: FsEntry, folder: FsDirectory | undefined) => void) | undefined;
  /** 把文件 / 文件夹作为引用插入当前对话的输入框。 */
  onAddContext?: ((entry: FsEntry) => void) | undefined;
  /** 系统程序打开、在资源管理器中显示、设为项目；没有接上时预览里给演示提示，真实里置灰。 */
  onSystemAction?: ((action: FileBrowserSystemAction, entry: FsEntry) => void) | undefined;
}

type MenuState = { kind: "context"; entry: FsEntry | null; point: { x: number; y: number } } | { kind: "places" | "more"; anchor: HTMLElement };

export function FileBrowserPanel({ panelId, source, scope, unavailable, onOpenFile, onAddContext, onSystemAction }: FileBrowserPanelProps) {
  const { resolvedLanguage } = useI18n();
  const language = resolvedLanguage === "zh" ? "zh" : "en";
  const copy = useCallback((zh: string, en: string) => language === "zh" ? zh : en, [language]);
  const { preview, marks } = usePreviewMode();
  const demo = preview && marks;
  const state = useFileBrowser(source, `${scope}:${panelId}`, scope);
  const [ref, tier] = useWidthTier<HTMLElement>(VIEW_STEPS);
  const view = effectiveView(tier, state.explicitView);
  const places = state.places;
  const [menu, setMenu] = useState<MenuState>();
  const [peeks, setPeeks] = useState<ReadonlyMap<string, FsPeek | "loading">>(() => new Map());
  const root = useRef<HTMLElement | null>(null);
  const sep = places?.separator ?? (PLATFORM === "darwin" ? "/" : "\\");
  const fileManager = places?.platform === "darwin" ? "Finder" : places?.platform === "linux" ? copy("文件管理器", "file manager") : copy("资源管理器", "File Explorer");
  const bin = places?.platform === "darwin" ? copy("废纸篓", "Trash") : copy("回收站", "Recycle Bin");

  const say = useCallback((text: string) => state.notify("ok", text), [state.notify]);
  /** 没接上的系统动作：预览给演示提示（marks 关闭时不提示），真实直接置灰。 */
  const systemReason = (action: FileBrowserSystemAction): string | undefined => {
    if (onSystemAction) return action !== "openAsProject" && source && !source.local ? copy("远端文件不在本机，无法用本机程序处理", "Remote files aren't on this computer") : undefined;
    return preview ? undefined : copy("此版本尚未接入", "Not available in this build");
  };
  const runSystem = (action: FileBrowserSystemAction, entry: FsEntry) => {
    if (onSystemAction) { onSystemAction(action, entry); return; }
    if (demo) say(action === "openSystem" ? copy(`演示：用系统程序打开「${entry.name}」`, `Demo: open "${entry.name}" with the system app`) : action === "reveal" ? copy(`演示：在${fileManager}中显示「${entry.name}」`, `Demo: reveal "${entry.name}" in ${fileManager}`) : copy(`演示：把「${entry.name}」设为项目`, `Demo: open "${entry.name}" as a project`));
  };
  const copyPath = (path: string) => { void navigator.clipboard?.writeText(path).then(() => say(copy("已复制路径", "Path copied")), () => state.notify("error", copy("无法写入剪贴板", "Couldn't copy"))); };
  const addContext = (entry: FsEntry) => {
    if (onAddContext) { onAddContext(entry); say(copy(`已把「${entry.name}」加入对话`, `Added "${entry.name}" to the chat`)); }
    else if (demo) say(copy(`演示：把「${entry.name}」加入对话`, `Demo: add "${entry.name}" to the chat`));
  };
  const openFile = (entry: FsEntry) => {
    if (onOpenFile) onOpenFile(entry, state.currentState?.dir);
    else if (demo) say(copy(`演示：在文件窗口打开「${entry.name}」`, `Demo: open "${entry.name}"`));
  };
  const isVolume = (entry: FsEntry) => !!places?.drives.some(drive => samePath(drive.path, entry.path, sep)) || entry.path === "/";
  const writeReason = (entry?: FsEntry) => !source ? copy("没有可用的数据来源", "No source") : entry && isVolume(entry) ? copy("磁盘与卷不能在这里重命名或删除", "Drives can't be changed here") : state.current === COMPUTER ? copy(`在${places?.computerLabel ?? "此电脑"}层不能新建或修改`, "Not at the computer level") : undefined;

  const startRename = (entry: FsEntry) => { if (!writeReason(entry)) state.setEdit({ kind: "rename", path: entry.path, draft: entry.name }); };
  const startNewFolder = () => { if (state.current !== undefined && !writeReason()) state.setEdit({ kind: "new", parent: state.current, draft: copy("新建文件夹", "New folder") }); };
  const askTrash = (items: readonly FsEntry[]) => {
    const blocked = items.map(writeReason).find(Boolean);
    if (blocked) { state.notify("error", blocked); return; }
    if (!source?.trash) { state.notify("error", copy("远端暂不支持回收站", "No recycle bin on the remote")); return; }
    if (items.length) state.setConfirmTrash(items);
  };
  const selectedEntries = () => state.entries.filter(entry => state.selection.includes(entry.path));

  const actions: RowActions = {
    select(entry, event, list) {
      if (view === "tree") {
        // 树里点选让面包屑跟上：目录就是当前位置，文件则是它所在的目录。
        state.go(entry.type === "dir" ? entry.path : parentPath(entry.path, sep), { select: entry.path, record: false, reveal: false });
        return;
      }
      if (event.ctrl) state.setSelection(state.selection.includes(entry.path) ? state.selection.filter(path => path !== entry.path) : [...state.selection, entry.path]);
      else if (event.shift && state.selection.length) {
        const anchor = list.findIndex(item => item.path === state.selection[0]), index = list.indexOf(entry);
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
        state.setSelection([state.selection[0]!, ...list.slice(Math.max(0, from), to + 1).map(item => item.path).filter(path => path !== state.selection[0])]);
      } else state.setSelection([entry.path]);
    },
    activate(entry) {
      if (entry.type === "dir") { if (entry.denied && state.current !== COMPUTER) state.notify("error", copy("没有权限打开此文件夹", "Access denied")); else state.go(entry.path); return; }
      if (entry.denied) { state.notify("error", copy("没有权限读取此文件", "Access denied")); return; }
      openFile(entry);
    },
    context(entry, point) { setMenu({ kind: "context", entry, point }); },
    addContext: onAddContext || preview ? (entry: FsEntry) => addContext(entry) : undefined,
  };

  /* ---------- 菜单内容 ---------- */
  const entryMenu = (entry: FsEntry): (MenuEntry | "sep")[] => {
    const many = state.selection.length > 1 && state.selection.includes(entry.path) ? selectedEntries() : [entry];
    const dir = entry.type === "dir";
    const pinned = state.isPinned(entry.path);
    return [
      { icon: dir ? "folder-open" : "file", label: dir ? copy("打开", "Open") : copy("在文件窗口打开", "Open in file window"), kbd: "Enter", disabled: !dir && !onOpenFile && !preview ? copy("此版本尚未接入", "Not available") : undefined, run: () => actions.activate(entry) },
      ...(!dir ? [{ icon: "external" as const, label: copy("用系统程序打开", "Open with system app"), disabled: systemReason("openSystem"), run: () => runSystem("openSystem", entry) }] : []),
      { icon: "folder-open", label: copy(`在${fileManager}中显示`, `Reveal in ${fileManager}`), disabled: systemReason("reveal"), run: () => runSystem("reveal", entry) },
      "sep",
      { icon: "copy", label: copy("复制路径", "Copy path"), run: () => copyPath(many.map(item => item.path).join("\n")) },
      { icon: "at", label: copy("添加到对话", "Add to chat"), disabled: !onAddContext && !preview ? copy("此窗口没有关联的对话", "No chat for this window") : undefined, run: () => many.forEach(addContext) },
      ...(dir ? ["sep" as const,
        { icon: "pin" as const, label: pinned ? copy("从位置栏取消固定", "Unpin") : copy("固定到位置栏", "Pin to places"), run: () => state.togglePin(entry.path) },
        { icon: "diamond" as const, label: copy("设为项目并新建对话", "Open as project"), disabled: systemReason("openAsProject"), run: () => runSystem("openAsProject", entry) }] : []),
      "sep",
      { icon: "pencil", label: copy("重命名", "Rename"), kbd: "F2", disabled: many.length > 1 ? copy("一次只能重命名一项", "Rename one item at a time") : writeReason(entry), run: () => startRename(entry) },
      { icon: "trash", label: copy(`移到${bin}`, `Move to ${bin}`), kbd: "Del", danger: true, disabled: writeReason(entry) ?? (source?.trash ? undefined : copy("远端暂不支持回收站", "No recycle bin on the remote")), run: () => askTrash(many) },
    ];
  };
  const folderMenu = (): (MenuEntry | "sep")[] => {
    const current = state.current ?? COMPUTER;
    const here: FsEntry = { name: current === COMPUTER ? places?.computerLabel ?? "" : baseName(current, sep), path: current, type: "dir" };
    return [
      { icon: "plus", label: copy("新建文件夹", "New folder"), kbd: `${PLATFORM === "darwin" ? "⌘" : "Ctrl"} Shift N`, disabled: writeReason(), run: startNewFolder },
      { icon: "refresh", label: copy("刷新", "Refresh"), kbd: "F5", run: state.refresh },
      { icon: state.showHidden ? "eye-off" : "eye", label: state.showHidden ? copy("不显示隐藏文件", "Hide hidden files") : copy("显示隐藏文件", "Show hidden files"), kbd: `${PLATFORM === "darwin" ? "⌘" : "Ctrl"} Shift .`, run: state.toggleHidden },
      "sep",
      { icon: "copy", label: copy("复制当前路径", "Copy current path"), disabled: current === COMPUTER ? copy("这一层没有路径", "No path here") : undefined, run: () => copyPath(current) },
      { icon: "pin", label: state.isPinned(current) ? copy("取消固定当前文件夹", "Unpin this folder") : copy("固定当前文件夹", "Pin this folder"), disabled: current === COMPUTER ? copy("这一层不能固定", "Can't pin here") : undefined, run: () => state.togglePin(current) },
      { icon: "folder-open", label: copy(`在${fileManager}中打开`, `Open in ${fileManager}`), disabled: current === COMPUTER ? copy("这一层不能打开", "Not here") : systemReason("reveal"), run: () => runSystem("reveal", here) },
    ];
  };

  /* ---------- 预览卡：分栏末列选中文件时取文件开头 ---------- */
  const picked = state.selection.length === 1 ? state.entries.find(entry => entry.path === state.selection[0]) : undefined;
  useEffect(() => {
    if (view !== "columns" || !source || picked?.type !== "file" || peeks.has(picked.path)) return;
    const entry = picked;
    setPeeks(previous => new Map(previous).set(entry.path, "loading"));
    source.peek(entry).then(value => setPeeks(previous => new Map(previous).set(entry.path, value)), () => setPeeks(previous => new Map(previous).set(entry.path, {})));
  }, [view, source, picked?.path]);
  useEffect(() => { setPeeks(new Map()); }, [source]);

  /* ---------- 全局快捷键（焦点在输入框时不接管） ---------- */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const typing = (event.target as HTMLElement).closest("input, textarea, [contenteditable]");
    const mod = event.ctrlKey || event.metaKey;
    if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); state.goBack(); return; }
    if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); state.goForward(); return; }
    if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); state.goUp(); return; }
    if (event.key === "F5") { event.preventDefault(); state.refresh(); return; }
    if (mod && event.key.toLowerCase() === "l") { event.preventDefault(); root.current?.querySelector<HTMLElement>(".fb-crumb.is-current")?.click(); return; }
    if (mod && event.key.toLowerCase() === "f") { event.preventDefault(); const input = root.current?.querySelector<HTMLInputElement>(".fb-filter input"); if (input) input.focus(); else root.current?.querySelector<HTMLElement>('[aria-label="筛选"], [aria-label="Filter"]')?.click(); return; }
    if (typing) return;
    if (mod && event.shiftKey && event.key.toLowerCase() === "n") { event.preventDefault(); startNewFolder(); return; }
    if (mod && event.shiftKey && (event.key === "." || event.key === ">")) { event.preventDefault(); state.toggleHidden(); return; }
    const items = selectedEntries();
    if (event.key === "F2" && items.length === 1) { event.preventDefault(); startRename(items[0]!); return; }
    if ((event.key === "Delete" || PLATFORM === "darwin" && mod && event.key === "Backspace") && items.length) { event.preventDefault(); askTrash(items); }
  };

  const setRoot = useCallback((element: HTMLElement | null) => { root.current = element; ref(element); }, [ref]);
  const body = useMemo(() => {
    if (!source) return <div className="fb-state fb-unavailable"><span className="fb-unavailable-ico"><Icon name="drive" /></span><strong>{unavailable?.title ?? copy("文件浏览器暂不可用", "File browser unavailable")}</strong><span>{unavailable?.detail ?? copy("当前没有可浏览的文件来源。", "Nothing to browse yet.")}</span></div>;
    if (state.placesError) return <div className="fb-state" role="alert"><Icon name="alert-c" /><strong>{state.placesError}</strong></div>;
    if (!places) return <div className="fb-skeleton fb-skeleton-page" aria-busy="true" aria-label={copy("正在读取", "Loading")}>{Array.from({ length: 9 }, (_, index) => <span key={index} />)}</div>;
    return null;
  }, [source, unavailable, state.placesError, places, copy]);

  return <section ref={setRoot} className="fb" data-tier={tier} data-view={view} aria-label={copy("文件浏览器", "File browser")} onKeyDown={onKeyDown}>
    <Toolbar state={state} places={places} tier={tier} view={view} copy={copy} disabled={!source || !places}
      onPlacesMenu={anchor => setMenu({ kind: "places", anchor })} onMore={anchor => setMenu({ kind: "more", anchor })} />
    <div className="fb-body">
      {body ?? <>
        {tier >= 1 && places ? <PlacesSidebar state={state} places={places} copy={copy} /> : null}
        <main className="fb-main" key={view}>
          {view === "tree" ? <TreeView state={state} places={places!} actions={actions} copy={copy} language={language} />
            : view === "list" ? <ListView state={state} places={places!} actions={actions} copy={copy} language={language} />
            : <ColumnsView state={state} places={places!} actions={actions} copy={copy} language={language} preview={entry => <PreviewCard entry={entry} peek={peeks.get(entry.path)} copy={copy} language={language} actions={[
              { icon: "file", label: copy("打开", "Open"), primary: true, disabled: !onOpenFile && !preview ? copy("此版本尚未接入", "Not available") : undefined, run: () => openFile(entry) },
              { icon: "at", label: copy("加入对话", "Add to chat"), disabled: !onAddContext && !preview ? copy("此窗口没有关联的对话", "No chat for this window") : undefined, run: () => addContext(entry) },
              { icon: "copy", label: copy("复制路径", "Copy path"), run: () => copyPath(entry.path) },
            ]} />} />}
        </main>
      </>}
    </div>
    <StatusBar state={state} copy={copy} sourceLabel={source?.label} demo={demo} />
    {state.notice ? <div key={state.notice.key} className="fb-notice" data-tone={state.notice.tone} role={state.notice.tone === "error" ? "alert" : "status"}><Icon name={state.notice.tone === "error" ? "alert-c" : "check"} extra="sm" />{state.notice.text}</div> : null}
    {menu?.kind === "context" ? <Popover point={menu.point} label={copy("文件操作", "File actions")} onClose={() => setMenu(undefined)}>
      <MenuEntries entries={menu.entry ? entryMenu(menu.entry) : folderMenu()} onClose={() => setMenu(undefined)} />
    </Popover> : null}
    {menu?.kind === "more" ? <Popover anchor={menu.anchor} label={copy("更多操作", "More actions")} onClose={() => setMenu(undefined)}>
      <MenuEntries entries={folderMenu()} onClose={() => setMenu(undefined)} />
    </Popover> : null}
    {menu?.kind === "places" && places ? <Popover anchor={menu.anchor} label={copy("位置", "Places")} className="fb-places-popover" onClose={() => setMenu(undefined)}>
      <PlacesList state={state} places={places} copy={copy} compact onPick={() => setMenu(undefined)} />
    </Popover> : null}
    {state.confirmTrash && places ? <TrashDialog items={state.confirmTrash} places={places} copy={copy} demo={demo} onCancel={() => state.setConfirmTrash(undefined)} onConfirm={() => void state.runTrash()} /> : null}
  </section>;
}
