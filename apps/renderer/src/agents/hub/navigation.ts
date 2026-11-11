import { isRealSubagentId } from "../../conversation/toolMeta";
import { HUB_INTENT_KEY, type HubTab } from "../../pageIntents";
import { type HubIntent, type Persisted } from "./types";

const HUB_STATE_KEY = "omp.agentHub.state";

function parseHubTab(value: unknown): HubTab | undefined {
  if (value === "btw") return value;
  if (
    value === "overview" ||
    value === "transcript" ||
    value === "jobs" ||
    value === "messages"
  )
    return value;
  return undefined;
}

function parseHubIntent(raw: string): HubIntent | null {
  try {
    const parsed = JSON.parse(raw) as {
      agentId?: unknown;
      tab?: unknown;
      chat?: unknown;
    };
    if (typeof parsed.agentId !== "string" || !isRealSubagentId(parsed.agentId))
      return null;
    const tab = parseHubTab(parsed.tab);
    return {
      agentId: parsed.agentId,
      ...(tab !== undefined ? { tab } : {}),
      ...(parsed.chat === true ? { chat: true } : {}),
    };
  } catch {
    return null;
  }
}

export function readHubIntent(): HubIntent | null {
  try {
    const raw = sessionStorage.getItem(HUB_INTENT_KEY);
    if (!raw) return null;
    const parsed = parseHubIntent(raw);
    if (!parsed) sessionStorage.removeItem(HUB_INTENT_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export function clearHubIntent(): void {
  try {
    sessionStorage.removeItem(HUB_INTENT_KEY);
  } catch {
    /* sessionStorage may be blocked. */
  }
}

function parseSelectedMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const next: Record<string, string> = {};
  for (const [key, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id === "string" && isRealSubagentId(id)) next[key] = id;
  }
  return next;
}

export function loadPersisted(): Persisted {
  try {
    const saved = JSON.parse(localStorage.getItem(HUB_STATE_KEY) || "{}") as {
      selected?: unknown;
      selectedBySession?: unknown;
      tab?: unknown;
      view?: unknown;
    };
    const selectedBySession = parseSelectedMap(saved.selectedBySession);
    if (
      typeof saved.selected === "string" &&
      isRealSubagentId(saved.selected) &&
      selectedBySession[""] === undefined
    ) {
      selectedBySession[""] = saved.selected;
    }
    return {
      selectedBySession,
      tab: parseHubTab(saved.tab) ?? "overview",
      view: saved.view === "tree" ? "tree" : "flat",
    };
  } catch {
    return { selectedBySession: {}, tab: "overview", view: "flat" };
  }
}

export function persist(state: Persisted): void {
  try {
    localStorage.setItem(HUB_STATE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage may be blocked; UI state stays in-memory. */
  }
}
