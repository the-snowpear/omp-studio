/** Manual browser QA for the real dock host and the two Git surfaces. */
import { useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { GitHubReference, StudioClient } from "@omp-studio/client-contract";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import { AgentRosterPanel } from "../agents/AgentRosterPanel";
import { ContextCard } from "../conversation/ContextCard";
import "../agents/agents.css";
import { githubReferenceSnapshot } from "../composer/githubReference";
import { gitCommitReferenceLabel } from "../composer/gitCommitReference";
import { DockProvider, useDock } from "../dock/DockContext";
import { DockGroupRegion, DockRail } from "../dock/DockRegions";
import { PanelRegistration } from "../dock/PanelRegistration";
import { DockStore } from "../dock/store";
import { createDefaultLayout } from "../dock/model";
import { GitQuickCard } from "../git/GitQuickCard";
import { GitWorkbench, type GitOpenIntent } from "../git/GitWorkbench";
import { GitWorkspaceProvider } from "../git/GitWorkspaceContext";
import { I18nProvider } from "../i18n";
import { WORKBENCH_PANELS } from "../panels/registry";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_DOCK_AGENTS } from "../preview/agentDockPreview";
import { PREVIEW_CONTEXT_CARD } from "../preview/contextCardPreview";
import { SessionWorktreesPane } from "../workspaces/SessionWorktreesPane";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/sidebar.css";
import "../styles/workbench.css";
import "../styles/typography.css";
import "../styles/tabs.css";
import "../App.css";
import "../dock/dock.css";
import "../dock/integration.css";

const unavailable = () => { throw new Error("Preview must not call the Host"); };
const client = { query: unavailable, command: unavailable } as unknown as StudioClient;
function makeStore() {
  const params = new URLSearchParams(location.search);
  if (params.has("savedGitRail")) {
    // Reproduce the previously shipped layout: Git in the rail with the
    // git-quick preferences already present but the quick card still hidden.
    const saved = createDefaultLayout();
    saved.right.groups[0]!.panels = saved.right.groups[0]!.panels.filter(id => id !== "git");
    saved.rail = { ...saved.rail, mode: "expanded", panels: ["git"] };
    saved.cards.git = { collapsed: false, height: 380 };
    const scope = { target: "local", project: "preview", session: "saved-git-rail" };
    const key = JSON.stringify([scope.target, scope.project, scope.session, false]);
    const storage = new Map([["omp.dock.v1", JSON.stringify({ version: 1, migrated: true, sessions: { [key]: saved } })]]);
    const adapter = {
      get length() { return storage.size; }, clear: () => storage.clear(), getItem: (name: string) => storage.get(name) ?? null,
      key: (index: number) => [...storage.keys()][index] ?? null, removeItem: (name: string) => { storage.delete(name); },
      setItem: (name: string, value: string) => { storage.set(name, value); },
    } satisfies Storage;
    const restored = new DockStore(adapter);
    restored.switchScope(scope, false);
    return restored;
  }
  const fresh = new DockStore(null);
  if (params.has("dragGit")) {
    fresh.dispatch({ type: "hide", panels: ["context", "agents"] });
    fresh.dispatch({ type: "railMode", mode: "expanded" });
    fresh.dispatch({ type: "open", panel: "git" });
    return fresh;
  }
  fresh.dispatch({ type: "hide", panels: ["environment", ...(params.has("spacingCards") ? [] : ["context" as const]), ...(params.has("cornerCards") ? [] : ["agents" as const])] });
  fresh.dispatch({ type: "move", panels: ["git-quick"], target: { region: "rail" } });
  if (params.has("spacingCards")) fresh.dispatch({ type: "move", panels: ["context"], target: { region: "rail" } });
  fresh.dispatch({ type: "railMode", mode: "expanded" });
  return fresh;
}
const store = makeStore();

function Surface() {
  const { layout, store: dock } = useDock();
  const [intent, setIntent] = useState<GitOpenIntent>();
  const sequence = useRef(0);
  const composer = useRef<ChipComposerHandle>(null);
  const addReference = (reference: GitHubReference) => {
    const captured = githubReferenceSnapshot(reference);
    composer.current?.insertChip({ kind: "github", label: `${captured.kind === "pr" ? "PR" : "Issue"} #${captured.number} ${captured.title}`, reference: captured });
    composer.current?.focus();
  };
  return <GitWorkspaceProvider client={client}>
    <div style={{ padding: 10, display: "flex", gap: 8 }}>
      {[280, 320, 480].map(width => <button key={width} className="btn small outline" onClick={() => dock.dispatch({ type: "resize", region: "rail", size: width })}>{width}px</button>)}
      <button className="btn small outline" onClick={() => dock.dispatch({ type: "region", region: "right", visible: false })}>关闭侧栏</button>
    </div>
    <main className="adaptive-workbench" style={{ display: "flex", position: "relative", height: "calc(100vh - 60px)", "--dock-rail-w": `${layout.rail.width}px` } as CSSProperties}>
      <div className="convo-wrap" style={{ flex: 1, position: "relative", minWidth: 0, height: "100%" }}>
        <div className="convo-scroll"><div className="convo-doc" style={{ padding: 30 }}>对话区域</div></div>
        <div className="composer-region" style={{ padding: 12 }}><ChipComposer ref={composer} ariaLabel="对话输入框" placeholder="输入要求…" /></div>
        <DockRail mode={layout.rail.mode} />
      </div>
      <aside className="side-panel open" style={{ position: "relative", width: layout.right.visible ? 480 : 0, flex: "none", overflow: "hidden" }}>
        <DockGroupRegion region="right" visible={layout.right.visible} />
      </aside>
    </main>
    <PanelRegistration panels={{
      agents: visibility => <AgentRosterPanel agents={PREVIEW_DOCK_AGENTS} visible={visibility.visible} ready onMain={() => {}} onOpen={() => {}} />,
      context: () => <ContextCard context={PREVIEW_CONTEXT_CARD} onOpenDetails={() => {}} />,
      "git-quick": visibility => <GitQuickCard client={client} workspaceName="omp-web" visible={visibility.visible} worktrees={<SessionWorktreesPane client={client} visible launcher launcherLabel="Worktree" />} onReference={addReference} onCommitReference={reference => { composer.current?.insertChip({ kind: "git-commit", label: gitCommitReferenceLabel(reference), reference }); composer.current?.focus(); }} onOpen={next => { setIntent({ ...next, key: ++sequence.current }); dock.dispatch({ type: "open", panel: "git" }); }} />,
      git: visibility => <GitWorkbench client={client} visible={visibility.visible} workspaceName="omp-studio" intent={intent} worktrees={<SessionWorktreesPane client={client} visible launcher launcherLabel="Worktree" />} onReference={addReference} />,
    }} />
  </GitWorkspaceProvider>;
}
createRoot(document.getElementById("root")!).render(<PreviewModeProvider><I18nProvider><DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface /></DockProvider></I18nProvider></PreviewModeProvider>);
