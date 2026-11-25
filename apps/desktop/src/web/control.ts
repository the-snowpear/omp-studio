import { randomUUID } from "node:crypto";
import { desktopText } from "../desktop-language-shared.js";

export class HostControlRequired extends Error {
  readonly code = "control_required";
  constructor() {
    super(
      desktopText(
        "请先接管工作台，再执行此操作",
        "Take control of the workbench before performing this action",
      ),
    );
  }
}

export interface ControlState {
  authorizationUrl?: string;
  owner?: { id: string; name: string };
  version: string;
}

/** All client writes pass this check immediately before reaching their service. */
export class HostControl {
  #state: ControlState = { version: randomUUID() };
  readonly #listeners = new Set<(state: ControlState) => void>();

  get state(): ControlState {
    return this.#state;
  }

  take(id: string, name: string): ControlState {
    this.#state = { owner: { id, name }, version: randomUUID() };
    for (const listener of this.#listeners) listener(this.#state);
    return this.#state;
  }

  release(id: string): void {
    if (this.#state.owner?.id !== id) return;
    this.#state = { version: randomUUID() };
    for (const listener of this.#listeners) listener(this.#state);
  }
  authorizeUrl(url: string): void {
    if (!/^https?:\/\//iu.test(url))
      throw new Error("Unsupported authorization URL");
    this.#state = { ...this.#state, authorizationUrl: url };
    for (const listener of this.#listeners) listener(this.#state);
  }

  assert(id: string, version: unknown): void {
    if (this.#state.owner?.id !== id || this.#state.version !== version) {
      throw new HostControlRequired();
    }
  }

  subscribe(listener: (state: ControlState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** These commands only select the view's context; they cannot change project content. */
export function isViewCommand(name: string, input?: unknown): boolean {
  if (name === "session.resume")
    return !(input && typeof input === "object" && "model" in input && input.model !== undefined);
  if (VIEW_OPERATIONS.has(name)) return true;
  return (
    name === "runtime.ensure" &&
    !(
      input &&
      typeof input === "object" &&
      "force" in input &&
      input.force === true
    )
  );
}

// Some Runtime read surfaces still use command receipts. Their concurrency
// classification also includes mutations, so authorize only actual reads here.
const VIEW_OPERATIONS = new Set([
  "workspace.open",
  "session.titles.inspect",
  "runtime.settings.get",
  "session.tree.get",
  "search.credentials.list",
  "session.lease.inspect",
  "jobs.inspect",
  "agent.model.inspect",
  "agent.spawn.options",
  "session.restore.inspect",
  "session.queue.get",
  "session.queue.list",
  "session.compaction.get",
  "session.compaction.status",
  "preferences.native.get",
  "preferences.features.get",
  "accounts.pool.options",
  "accounts.pool.get",
  "models.compaction.preview",
  "session.portability.status",
  "maintenance.compression.status",
  "worktrees.session.list",
  "worktrees.session.startPolicy",
  "worktrees.session.resume.list",
  "mode.plan.review.details",
  "dictation.inspect",
  "prediction.status",
  "resource.read",
  "agent.btw.read",
  "session.tier.get",
  "session.skills.list",
  "ratchet.list",
  "ratchet.read",
  "computer.status",
  "browser.tabs.get",
  "disassembler.status",
  "disassembler.metadata.read",
  "session.speed.get",
  "session.budget.get",
  "session.warming.get",
  "models.presets.list",
  "live.audio.status",
  "media.models",
  "media.list",
  "media.read",
  "benchmarks.accounts.read",
  "benchmarks.list",
  "benchmarks.read",
  "judgments.list",
  "judgments.read",
  "accounts.status",
  "accounts.status.details",
  "services.list",
  "services.logs",
  "tokens.count",
  "runtime.models.list",
  "runtime.models.describe",
  "evaluation.runtime.read",
  "evaluation.runtime.rows",
  "evaluation.runtime.report",
  "evaluation.runtime.patch",
]);
