import type { HostTimeTravelService } from "@omp-studio/host-client-api";
import type { SessionArchiveReaderPort } from "@omp-studio/studio-host";
import type { SessionId } from "@omp-studio/client-contract";
import type { TimeTravelService } from "./time-travel-service.js";

export function createTimeTravelPort(options: {
  service: TimeTravelService;
  workspace(): string;
  reader(): SessionArchiveReaderPort;
  assertIdle(): void;
  prepareSession(
    sessionId: SessionId,
  ): Promise<{ leafId: string | null; supportsExactRestore?: boolean }>;
  navigate(leafId: string | null): Promise<{ cancelled?: boolean }>;
}): HostTimeTravelService {
  const { service } = options;
  return {
    isRestoring: () => service.isRestoring(),
    settings: () => service.settings(),
    storage: () => service.storage(),
    cleanup: (scope) => service.cleanup(scope),
    updateSettings: (input) => service.updateSettings(input),
    timeline: async (input) => {
      const [archive, snapshots] = await Promise.all([
        options.reader().readTimeTravel(input),
        service.list(options.workspace(), input.sessionId),
      ]);
      const ancestors = new Set(archive.ancestors);
      return {
        sessionId: input.sessionId,
        activeLeafId: archive.activeLeafId,
        selectedLeafId: archive.selectedLeafId,
        branches: archive.branches,
        events: archive.events,
        points: snapshots
          .filter(
            (row) =>
              row.phase === "restore-backup" ||
              row.leafId === null ||
              ancestors.has(row.leafId),
          )
          .map((row) => ({
            id: row.id,
            leafId: row.leafId,
            phase: row.phase,
            createdAt: row.createdAt,
            fileCount: row.entries.length,
            ...(row.changes ? { changes: row.changes } : {}),
          })),
        ...(archive.olderCursor ? { olderCursor: archive.olderCursor } : {}),
      };
    },
    preview: async (input) => {
      await options.reader().readRevision(input.sessionId);
      return await service.preview(
        options.workspace(),
        input.sessionId,
        input.snapshotId,
      );
    },
    restore: (input) =>
      service.withRestore(async (store, settings) => {
        const workspace = options.workspace();
        const archive = await options
          .reader()
          .readTimeTravel({
            sessionId: input.sessionId,
            ...(input.leafId === null ? {} : { branchLeafId: input.leafId }),
          });
        options.assertIdle();
        let backupId: string | undefined;
        let codeRestored = false;
        let conversationRestored = false;
        let currentLeafId = archive.activeLeafId;
        if (input.mode !== "code") {
          const tree = await options.prepareSession(input.sessionId);
          if (!tree.supportsExactRestore)
            throw new Error(
              "Update Runtime to restore conversations with Time Travel",
            );
          currentLeafId = tree.leafId;
        }
        if (input.mode !== "conversation") {
          if (!input.snapshotId || !input.expectedRevision)
            throw new Error("Review the code restore first");
          const point = (await store.list(workspace, input.sessionId)).find(
            (row) => row.id === input.snapshotId,
          );
          if (!point || point.leafId !== input.leafId)
            throw new Error(
              "The snapshot does not match this session position",
            );
          options.assertIdle();
          const result = await store.restore({
            workspace,
            sessionId: input.sessionId,
            snapshotId: input.snapshotId,
            expectedRevision: input.expectedRevision,
            leafId: currentLeafId,
            exclusions: settings.exclusions,
          });
          backupId = result.backup.id;
          if (!result.restored)
            return {
              codeRestored: false,
              conversationRestored: false,
              backupId,
              error: result.error ?? "Code restore failed",
            };
          codeRestored = true;
        }
        if (input.mode !== "code") {
          try {
            const outcome = await options.navigate(input.leafId);
            if (!outcome.cancelled) conversationRestored = true;
            else if (!codeRestored)
              throw new Error("Conversation restore was cancelled");
          } catch (error) {
            if (!codeRestored) throw error;
          }
        }
        return {
          codeRestored,
          conversationRestored,
          ...(backupId ? { backupId } : {}),
        };
      }),
  };
}
