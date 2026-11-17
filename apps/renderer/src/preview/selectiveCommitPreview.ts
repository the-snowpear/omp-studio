import type {
  SelectiveCommitDraft,
  SelectiveCommitOutcome,
  SelectiveCommitPath,
  SelectiveCommitPreview,
  SelectiveCommitRead,
  SelectiveCommitSelection,
  SelectiveCommitSelectionState,
  SelectiveCommitUnit,
} from "@omp-studio/studio-protocol";

/**
 * Selective-commit demo. The draft below is a static story; the helpers only
 * move its local selection so the panel can be exercised. Nothing here is
 * native ownership logic: the real panel always renders what the Runtime sends.
 */
const DEMO_HEAD = "3f2a91c7d0b54e1aa6c2e8f90b7d41c2e95a7710";
const PREVIEW_TTL_MS = 5 * 60_000;

const DIFFS: Record<string, string> = {
  "apps/renderer/src/conversation/SessionChanges.tsx": [
    "diff --git a/apps/renderer/src/conversation/SessionChanges.tsx b/apps/renderer/src/conversation/SessionChanges.tsx",
    "--- a/apps/renderer/src/conversation/SessionChanges.tsx",
    "+++ b/apps/renderer/src/conversation/SessionChanges.tsx",
    "@@ -42,7 +42,11 @@ export function SessionChanges({ rows, focusPath }: Props) {",
    "   const turns = useMemo(() => collectTurns(rows), [rows]);",
    "-  const [open, setOpen] = useState<string | null>(null);",
    "+  const [open, setOpen] = useState<string | null>(focusPath ?? null);",
    "+  useEffect(() => {",
    "+    if (focusPath) setOpen(focusPath);",
    "+  }, [focusPath]);",
    "   if (turns.length === 0) return <ChangesEmpty />;",
    "   return (",
    "     <section className=\"session-changes\">",
    "@@ -118,6 +122,9 @@ function TurnHeader({ turn }: { turn: TurnView }) {",
    "   return (",
    "     <header className=\"turn-head\">",
    "       <span className=\"turn-index\">{turn.index}</span>",
    "+      {turn.partial ? (",
    "+        <span className=\"chip amber xs\">partial</span>",
    "+      ) : null}",
    "     </header>",
    "   );",
    " }",
  ].join("\n"),
  "docs/UPSTREAM-SYNC.md": [
    "diff --git a/docs/UPSTREAM-SYNC.md b/docs/UPSTREAM-SYNC.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/docs/UPSTREAM-SYNC.md",
    "@@ -0,0 +1,9 @@",
    "+# Upstream Sync Notes · v0.8.1",
    "+",
    "+## Sync Scope",
    "+- Align dependencies and lockfile.",
    "+- Preserve Studio Bridge and session directory.",
    "+",
    "+## Verification Log",
    "+- [x] Windows typecheck",
    "+- [ ] macOS interaction review",
  ].join("\n"),
  "README.md": [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -44,6 +44,7 @@",
    " ",
    " ## Documentation",
    "-- [Old sync notes](docs/sync-notes.md)",
    "+- [Upstream sync](docs/UPSTREAM-SYNC.md)",
    "+- [Verification log](docs/verification.md)",
    " - [Contributing](CONTRIBUTING.md)",
  ].join("\n"),
  "packages/client/src/reducer.ts": [
    "diff --git a/packages/client/src/reducer.ts b/packages/client/src/reducer.ts",
    "--- a/packages/client/src/reducer.ts",
    "+++ b/packages/client/src/reducer.ts",
    "@@ -171,6 +171,8 @@ export function createInitialClientState(ui: ClientUiState = EMPTY_UI): ClientSt",
    "  const SENSITIVE_COMMANDS: Readonly<Record<CommandName, boolean>> = {",
    "+  \"commit.draft.select\": true,",
    "+  \"commit.draft.execute\": true,",
    "   \"timeTravel.settings.set\": true,",
  ].join("\n"),
};

function unit(id: string, actor: string | null, ownership: SelectiveCommitUnit["ownership"], selected: SelectiveCommitSelectionState, added: number, removed: number, extra: Partial<SelectiveCommitUnit> = {}): SelectiveCommitUnit {
  return { id, actor, opIds: [], ownership, selected, added, removed, likely: false, reasons: [{ kind: "hunk" }], ...extra };
}

function demoPaths(): SelectiveCommitPath[] {
  return [
    {
      path: "apps/renderer/src/conversation/SessionChanges.tsx", kind: "text", change: "modified", beforeMode: "100644", afterMode: "100644",
      workBytes: 18_204, staged: false, selected: "partial", ownership: ["own", "other"],
      hunks: [
        { id: "1", headStart: 42, headCount: 7, workStart: 42, workCount: 11, units: [unit("1a", "Main", ["own"], "all", 4, 1, { opIds: [12, 13], likely: true })] },
        { id: "2", headStart: 118, headCount: 6, workStart: 122, workCount: 9, units: [unit("2a", null, ["other"], "none", 3, 0, { reasons: [{ kind: "rewritten", by: "editor" }] })] },
      ],
    },
    {
      path: "docs/UPSTREAM-SYNC.md", kind: "text", change: "added", beforeMode: null, afterMode: "100644",
      workBytes: 2_316, staged: false, selected: "all", ownership: ["own"],
      hunks: [{ id: "1", headStart: 0, headCount: 0, workStart: 1, workCount: 9, units: [unit("1a", "explore-2", ["own"], "all", 9, 0, { opIds: [21] })] }],
    },
    {
      path: "README.md", kind: "text", change: "modified", beforeMode: "100644", afterMode: "100644",
      workBytes: 6_902, staged: false, selected: "none", ownership: ["review"],
      hunks: [{ id: "1", headStart: 44, headCount: 6, workStart: 44, workCount: 7, units: [unit("1a", "Main", ["own", "other"], "none", 2, 1, { reasons: [{ kind: "entangled", with: ["user edit"] }] })] }],
    },
    {
      path: "apps/renderer/public/omp-mark.png", kind: "binary", change: "modified", beforeMode: "100644", afterMode: "100644",
      workBytes: 48_120, staged: false, selected: "none", ownership: ["other"],
      hunks: [{ id: "1", headStart: 0, headCount: 0, workStart: 0, workCount: 0, units: [unit("1a", null, ["other"], "none", 0, 0, { reasons: [{ kind: "whole", reason: "binary", editors: [] }] })] }],
    },
    {
      path: "scripts/release-plan.sh", kind: "mode", change: "modified", beforeMode: "100644", afterMode: "100755",
      workBytes: 912, staged: false, selected: "all", ownership: ["own"],
      hunks: [{ id: "1", headStart: 0, headCount: 0, workStart: 0, workCount: 0, units: [unit("1a", "Main", ["own"], "all", 0, 0, { reasons: [{ kind: "whole", reason: "mode", editors: ["Main"] }] })] }],
    },
  ];
}

export function createPreviewCommitDraft(now = Date.now()): SelectiveCommitDraft {
  return {
    sessionId: "preview",
    runtimeEpoch: 1,
    expiresAt: now + PREVIEW_TTL_MS,
    view: {
      id: "draft-demo", revision: 1, head: DEMO_HEAD, branch: "feat/session-changes", caller: "Main",
      scope: [], state: "open",
      agents: [
        { id: "Main", inScope: true, running: false },
        { id: "explore-2", parent: "Main", inScope: true, running: true },
        { id: "review-1", parent: "Main", inScope: false, running: false },
      ],
      paths: demoPaths(),
      staged: ["packages/client/src/reducer.ts"],
      skipped: [],
    },
  };
}

function aggregate(states: readonly SelectiveCommitSelectionState[]): SelectiveCommitSelectionState {
  if (states.length === 0 || states.every(state => state === "none")) return "none";
  return states.every(state => state === "all") ? "all" : "partial";
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") { source += ".*"; index += 1; } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}(?:/.*)?$`, "u");
}

function setPath(path: SelectiveCommitPath, decide: (unit: SelectiveCommitUnit) => SelectiveCommitSelectionState): SelectiveCommitPath {
  const hunks = path.hunks.map(hunk => ({ ...hunk, units: hunk.units.map(entry => ({ ...entry, selected: decide(entry) })) }));
  return { ...path, hunks, selected: aggregate(hunks.flatMap(hunk => hunk.units.map(entry => entry.selected))) };
}

/** Local demo only: moves the fixture selection and bumps the revision. */
export function selectPreviewCommitDraft(draft: SelectiveCommitDraft, selection: SelectiveCommitSelection): SelectiveCommitDraft {
  const paths = draft.view.paths.map(path => {
    if (selection.action === "only") {
      const keep = selection.paths.some(glob => globToRegExp(glob).test(path.path));
      return keep ? path : setPath(path, () => "none");
    }
    if (path.path !== selection.path) return path;
    const target = selection.action === "take" ? "all" : "none";
    if (!selection.units?.length || path.kind !== "text") return setPath(path, () => target);
    return setPath(path, entry => selection.units!.includes(entry.id) ? target : entry.selected);
  });
  return { ...draft, view: { ...draft.view, revision: draft.view.revision + 1, paths } };
}

export function previewCommitPreview(draft: SelectiveCommitDraft, now = Date.now()): SelectiveCommitPreview {
  const paths = draft.view.paths.filter(path => path.selected !== "none").map(path => path.path);
  return {
    draftId: draft.view.id, revision: draft.view.revision, previewId: `preview-${draft.view.revision}`,
    head: draft.view.head, tree: "9c41e0b2a7f3d58e6b1c0a4f72d9e3b8c5a61f04",
    bytes: paths.reduce((sum, path) => sum + (DIFFS[path]?.length ?? 320), 0), paths,
    expiresAt: Math.max(draft.expiresAt, now + PREVIEW_TTL_MS),
  };
}

export function previewCommitRead(draft: SelectiveCommitDraft, target: { kind: "file"; path: string; offset?: number } | { kind: "preview"; previewId: string; offset?: number }): SelectiveCommitRead {
  let text: string | null;
  if (target.kind === "file") {
    const path = draft.view.paths.find(entry => entry.path === target.path);
    text = path && path.kind !== "text" ? null : DIFFS[target.path] ?? "";
  } else {
    text = draft.view.paths.filter(path => path.selected !== "none" && path.kind === "text").map(path => DIFFS[path.path] ?? "").join("\n");
  }
  const offset = target.offset ?? 0;
  return { draft, body: { kind: target.kind, text: text === null ? null : text.slice(offset), offset, totalChars: text?.length ?? 0 } };
}

export function previewCommitOutcome(preview: SelectiveCommitPreview, subject: string): SelectiveCommitOutcome {
  return {
    sha: "a17c3e9f02b4d6e8c1a3f5b7d9e0c2a4b6d8f0e1", subject, paths: preview.paths, parent: preview.head,
    indexNotes: ["packages/client/src/reducer.ts stays staged; it was not part of this commit."],
  };
}
