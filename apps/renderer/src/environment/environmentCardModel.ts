import type { GitRepositoryReadModel } from "@omp-studio/client-contract";

/** Translation call shape: the card derives copy, so it takes `t` instead of a locale. */
export type EnvironmentTranslate = (key: string, params?: Record<string, string | number>) => string;

/** `useGitRepository` snapshot, narrowed to what the card reads. */
export type EnvironmentRepository = {
  readonly repository?: GitRepositoryReadModel | undefined;
  readonly loading: boolean;
  readonly error?: string | undefined;
};

/** Where the session actually runs: this computer, or an SSH execution target. */
export type EnvironmentTarget = {
  readonly name?: string | undefined;
  readonly remote: boolean;
};

export type EnvironmentRuntimeStatus = "connected" | "connecting" | "disconnected" | "unavailable";

export type EnvironmentCardInput = {
  readonly target: EnvironmentTarget;
  readonly runtimeStatus: EnvironmentRuntimeStatus;
  readonly version?: string | undefined;
  readonly project?: { readonly name: string; readonly root?: string | undefined } | undefined;
  readonly repository: EnvironmentRepository;
};

/** Dot tone for the environment axis; mirrors `RuntimeConnectionStatus`. */
export type EnvironmentDotState = "connected" | "connecting" | "disconnected" | "unknown";

export type EnvironmentSync = {
  readonly ahead: number;
  readonly behind: number;
};

/**
 * The card is two axes, not four rows: the left axis names the project, the
 * right axis names the environment it runs in. The changes row underneath is
 * the one action. This view keeps that split explicit.
 */
export type EnvironmentCardView = {
  /** Right axis, first line: the machine, with its live runtime tone. */
  readonly machine: { readonly label: string; readonly dot: EnvironmentDotState; readonly tip?: string | undefined };
  /** Right axis, second line: runtime version, if the Host reports one. */
  readonly version?: string | undefined;
  readonly project: {
    readonly name: string;
    /** Parent folder of the workspace root, shown as the project's address. */
    readonly address?: string | undefined;
    readonly empty: boolean;
    readonly tip?: string | undefined;
  };
  readonly branch: {
    readonly name: string;
    /** Branch names are identifiers: mono. Fallback sentences stay in the UI face. */
    readonly machine: boolean;
    readonly empty: boolean;
    readonly pending: boolean;
    readonly sync: EnvironmentSync;
    readonly operation?: string | undefined;
    readonly tip?: string | undefined;
  };
  readonly changes: {
    readonly label: string;
    readonly empty: boolean;
    readonly pending: boolean;
    readonly insertions: number;
    readonly deletions: number;
    readonly tip?: string | undefined;
    /** False when there is no repository behind the working tree to open. */
    readonly actionable: boolean;
  };
};

function runtimeDot(status: EnvironmentRuntimeStatus): EnvironmentDotState {
  if (status === "connected") return "connected";
  if (status === "connecting") return "connecting";
  if (status === "disconnected") return "disconnected";
  return "unknown";
}

/** Only a runtime that is not up needs words; a connected one speaks for itself. */
function runtimeTipKey(status: EnvironmentRuntimeStatus): string | undefined {
  if (status === "connecting") return "environment.runtimeConnecting";
  if (status === "disconnected") return "environment.runtimeOffline";
  if (status === "unavailable") return "environment.runtimeUnavailable";
  return undefined;
}

/**
 * Parent folder of a workspace root, for the address beside the project name.
 * The name is the leaf, so the address stays complementary instead of
 * repeating it: `D:/Project/omp-web` -> `D:/Project`, `/home/me/app` ->
 * `/home/me`, `D:/app` -> `D:/`, `/app` -> `/`.
 */
export function parentAddress(root: string): string | undefined {
  const trimmed = root.replace(/[\\/]+$/u, "");
  if (trimmed === "") return undefined;
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (cut < 0) return undefined;
  const parent = trimmed.slice(0, cut);
  if (parent === "") return trimmed.slice(0, 1);
  if (/^[A-Za-z]:$/u.test(parent)) return `${parent}\\`;
  return parent;
}

/**
 * The card's view, derived from Host read models only. Anything the Host does
 * not publish stays an honest empty state — the card never substitutes a guess
 * (no invented workspace path, no fabricated branch).
 */
export function buildEnvironmentCard(input: EnvironmentCardInput, t: EnvironmentTranslate): EnvironmentCardView {
  const { target, repository, project } = input;
  const repo = repository.repository;
  const isRepo = repo?.isRepository === true;
  const reading = repository.loading && !isRepo;
  const failed = repository.error !== undefined && !isRepo && !repository.loading;
  const environmentTip = runtimeTipKey(input.runtimeStatus);

  const machine: EnvironmentCardView["machine"] = {
    label: target.remote ? t("environment.remote", { name: target.name ?? "SSH" }) : t("environment.local"),
    dot: runtimeDot(input.runtimeStatus),
    ...(environmentTip === undefined ? {} : { tip: t(environmentTip) }),
  };

  const address = project?.root === undefined ? undefined : parentAddress(project.root);
  const projectView: EnvironmentCardView["project"] = project === undefined
    ? { name: t("environment.noProject"), empty: true }
    : {
        name: project.name,
        empty: false,
        ...(address === undefined ? {} : { address }),
        tip: project.root ?? t("environment.openProject"),
      };

  let branch: EnvironmentCardView["branch"];
  if (reading) {
    branch = { name: "", machine: true, empty: false, pending: true, sync: { ahead: 0, behind: 0 } };
  } else if (failed) {
    branch = { name: t("environment.unavailable"), machine: false, empty: true, pending: false, sync: { ahead: 0, behind: 0 }, tip: repository.error };
  } else if (!isRepo) {
    branch = {
      name: repo === undefined ? t("environment.unavailable") : t("environment.noRepository"),
      machine: false, empty: true, pending: false, sync: { ahead: 0, behind: 0 },
      ...(repo?.unavailableReason === undefined ? {} : { tip: repo.unavailableReason }),
    };
  } else {
    const name = repo.branch ?? (repo.detached ? t("environment.detached") : repo.unborn ? t("environment.unborn") : t("environment.unavailable"));
    branch = {
      name,
      machine: repo.branch !== undefined,
      empty: repo.branch === undefined,
      pending: false,
      // A Git operation in flight explains the working tree better than the
      // ahead/behind count it interrupted.
      sync: repo.operation === undefined ? { ahead: repo.ahead, behind: repo.behind } : { ahead: 0, behind: 0 },
      ...(repo.operation === undefined ? {} : { operation: repo.operation }),
      tip: repo.upstream === undefined ? t("environment.openGit") : t("environment.upstream", { upstream: repo.upstream }),
    };
  }

  let changes: EnvironmentCardView["changes"];
  if (reading) {
    changes = { label: "", empty: false, pending: true, insertions: 0, deletions: 0, actionable: false };
  } else if (failed) {
    changes = { label: t("environment.unavailable"), empty: true, pending: false, insertions: 0, deletions: 0, tip: repository.error, actionable: false };
  } else if (!isRepo) {
    changes = { label: t("environment.unavailable"), empty: true, pending: false, insertions: 0, deletions: 0, actionable: false };
  } else {
    const count = repo.changes.length;
    const insertions = repo.insertions ?? 0;
    const deletions = repo.deletions ?? 0;
    changes = {
      label: count === 0 ? t("environment.clean") : t("environment.files", { count }),
      empty: count === 0,
      pending: false,
      insertions: insertions > 0 ? insertions : 0,
      deletions: deletions > 0 ? deletions : 0,
      tip: t("environment.openChanges"),
      actionable: true,
    };
  }

  return {
    machine,
    ...(input.version === undefined ? {} : { version: input.version }),
    project: projectView,
    branch,
    changes,
  };
}
