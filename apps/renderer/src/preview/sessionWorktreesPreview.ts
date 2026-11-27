import type { SessionWorktreeRow, WorktreeHookStatus } from "@omp-studio/studio-protocol";
export const previewWorktreeHook = (zh: boolean): WorktreeHookStatus => ({
  state: "succeeded", branch: "wt/queue-recovery", durationMs: 1280, warnings: [],
  refreshed: { skillsCount: 3, commandsCount: 2, addedSkills: [{ name: "project-checks", source: ".agents/skills/project-checks/SKILL.md", description: zh ? "工作区检查" : "Workspace checks", location: "worktree" }], addedCommands: [{ name: "verify", source: ".omp/commands/verify.md", description: zh ? "验证当前修改" : "Verify current changes", location: "worktree" }], removedSkills: [], removedCommands: [] },
});
export const PREVIEW_SESSION_WORKTREES: SessionWorktreeRow[] = [
  { id: "00000000-0000-4000-8000-000000000011", backend: "ovnfs", sourceDirectory: "~/omp-studio", branch: "wt/queue-recovery", directory: "~/omp-studio/queue-recovery", sessionId: "sess-7c2e91", current: false, dirty: false, hasCommits: true, detached: false, missing: false },
  { id: "00000000-0000-4000-8000-000000000012", branch: "wt/browser-observation", directory: "~/omp-studio/browser-observation", sessionId: "sess-4a8f20", current: false, dirty: true, hasCommits: false, detached: false, missing: false },
];
