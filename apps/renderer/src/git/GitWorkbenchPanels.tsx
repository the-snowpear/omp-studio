import type { CapabilityManifest } from "@omp-studio/studio-protocol";
import type { WorkspaceRecord } from "@omp-studio/client-contract";
import type { GitOpenIntent } from "./GitWorkbench";
import { GitQuickCard } from "./GitQuickCard";
import { GitDockMeter } from "./GitDockMeter";
import { GitWorkspaceProvider } from "./GitWorkspaceContext";
import { githubReferenceSnapshot } from "../composer/githubReference";
import { gitCommitReferenceLabel } from "../composer/gitCommitReference";
import { PanelRegistration } from "../dock/PanelRegistration";
import { revealMainWindow } from "../dock/SurfaceContext";
import { lazyPanel } from "../DeferredPanel";
import { SessionWorktreesPane } from "../workspaces/SessionWorktreesPane";
import { useRef, useState } from "react";
import type { SessionId, WorkspaceId } from "@omp-studio/client-contract";
import { type ChipComposerHandle } from "../composer/ChipComposer";
import { type ClientStateSource, type Route } from "../workbench/types";

const GitWorkbench = lazyPanel(() => import("./GitWorkbench").then(module => ({ default: module.GitWorkbench })));

interface GitWorkbenchPanelsProps {
  gitScope: string;
  client: ClientStateSource;
  gitSharedWorkspaceId: WorkspaceId | undefined;
  composerOwner: SessionId | undefined;
  activeWorkspace: WorkspaceRecord | undefined;
  onOpenWorktree: ((workspaceId: string) => Promise<void>) | undefined;
  sessionId: SessionId | undefined;
  available: boolean;
  capabilities: CapabilityManifest | undefined;
  onRoute: (route: Route) => void;
  composerInputRef: { current: ChipComposerHandle | null; };
  onOpenGit: () => void;
}

export function GitWorkbenchPanels({ gitScope, client, gitSharedWorkspaceId, composerOwner, activeWorkspace, onOpenWorktree, sessionId, available, capabilities, onRoute, composerInputRef, onOpenGit }: GitWorkbenchPanelsProps) {
  const [gitIntent, setGitIntent] = useState<{ scope: string; intent: GitOpenIntent }>();
  const gitIntentSequence = useRef(0);
  return (<GitWorkspaceProvider key={gitScope} client={client} workspaceId={gitSharedWorkspaceId}>
        <GitDockMeter />
        <PanelRegistration panels={{
        git: visibility => <GitWorkbench key={composerOwner ?? "draft"} client={client} {...(activeWorkspace ? { workspaceId: activeWorkspace.workspaceId, workspaceName: activeWorkspace.name } : {})} visible={visibility.visible}
          {...(gitIntent?.scope === gitScope ? { intent: gitIntent.intent } : {})}
          worktrees={<SessionWorktreesPane launcher launcherLabel="Worktree" onOpenWorkspace={onOpenWorktree} client={client} context={{ sessionId, available, capabilities }} visible={visibility.visible} />}
          onReference={reference => {
            revealMainWindow(); onRoute("workbench");
            const captured = githubReferenceSnapshot(reference);
            composerInputRef.current?.insertChip({ kind: "github", label: `${captured.kind === "pr" ? "PR" : "Issue"} #${captured.number} ${captured.title}`, reference: captured });
            composerInputRef.current?.focus();
          }} />,
        "git-quick": visibility => <GitQuickCard client={client} workspaceId={gitSharedWorkspaceId} workspaceName={activeWorkspace?.name} visible={visibility.visible}
          worktrees={<SessionWorktreesPane launcher launcherLabel="Worktree" onOpenWorkspace={onOpenWorktree} client={client} context={{ sessionId, available, capabilities }} visible={visibility.visible} />}
          onOpen={intent => { setGitIntent({ scope: gitScope, intent: { ...intent, key: ++gitIntentSequence.current } }); revealMainWindow(); onRoute("workbench"); onOpenGit(); }}
          onReference={reference => { revealMainWindow(); onRoute("workbench"); const captured = githubReferenceSnapshot(reference); composerInputRef.current?.insertChip({ kind: "github", label: `${captured.kind === "pr" ? "PR" : "Issue"} #${captured.number} ${captured.title}`, reference: captured }); composerInputRef.current?.focus(); }}
          onCommitReference={reference => { revealMainWindow(); onRoute("workbench"); composerInputRef.current?.insertChip({ kind: "git-commit", label: gitCommitReferenceLabel(reference), reference }); composerInputRef.current?.focus(); }} />,
        }} />
      </GitWorkspaceProvider>);
}
