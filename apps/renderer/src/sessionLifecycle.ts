import type {
  ClientInteraction,
  CommandReceipt,
  CommandRequestId,
  CommandState,
  SessionHistoryEntry,
  SessionId,
  StudioClient,
  ThreadId,
} from "@omp-studio/client-contract";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";
import { waitReceipt } from "./hostError";

export const NEW_CONVERSATION_UNAVAILABLE_REASON =
  "Host 未提供 session.create，无法创建新的 Runtime 会话。";

export function isNewConversationAvailable(): true {
  return true;
}

/** The single Host pending interaction, if exactly one command is waiting. */
export function selectPendingInteraction(
  commands: Readonly<Record<string, CommandState>>,
): ClientInteraction | null {
  const pending: ClientInteraction[] = [];
  for (const command of Object.values(commands)) {
    if (command.status === "interaction_required") {
      pending.push(command.interaction);
    }
  }
  if (pending.length === 0) return null;
  return pending[pending.length - 1] ?? null;
}

export type ResumeGenerationGate = {
  next(): number;
  isCurrent(generation: number): boolean;
};

export function createResumeGenerationGate(): ResumeGenerationGate {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(generation: number) {
      return generation === current;
    },
  };
}

export type CommandWaitClient = {
  subscribe(
    scope: { scope: "command"; requestId: CommandRequestId },
    listener: (event: { kind: string; receipt?: CommandReceipt }) => void,
  ): () => void;
  getState?: () => { readonly commands?: Readonly<Record<string, CommandState>> };
};

function terminalFromState(client: CommandWaitClient, requestId: CommandRequestId): CommandReceipt | undefined {
  const entry = client.getState?.()?.commands?.[requestId];
  if (entry === undefined) return undefined;
  if (entry.status === "completed" || entry.status === "failed" || entry.status === "rejected" || entry.status === "outcome_unknown") {
    return entry;
  }
  return undefined;
}

export function waitForCommandReceipt(
  client: CommandWaitClient,
  requestId: CommandRequestId,
): Promise<CommandReceipt> {
  const existing = terminalFromState(client, requestId);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const unsubscribe = client.subscribe({ scope: "command", requestId }, (event) => {
      if (event.kind !== "command.receipt" || event.receipt === undefined) return;
      unsubscribe();
      resolve(event.receipt);
    });
    const raced = terminalFromState(client, requestId);
    if (raced !== undefined) {
      unsubscribe();
      resolve(raced);
    }
  });
}

export async function resumeHistoryEntry(
  client: {
    command(name: "session.resume", input: { threadId: SessionHistoryEntry["threadId"] }): Promise<{ requestId: CommandRequestId }>;
    subscribe: CommandWaitClient["subscribe"];
  },
  entry: SessionHistoryEntry,
  gate: ResumeGenerationGate,
): Promise<{ generation: number; receipt: CommandReceipt }> {
  const generation = gate.next();
  const handle = await client.command("session.resume", { threadId: entry.threadId });
  const receipt = await waitForCommandReceipt(client, handle.requestId);
  return { generation, receipt };
}

export async function ensureSelectedSessionActive(
  client: StudioClient,
  target: {
    readonly activeSessionId?: SessionId;
    readonly selectedSessionId?: SessionId;
    readonly selectedThreadId?: ThreadId;
  },
): Promise<void> {
  if (target.selectedSessionId === undefined || target.activeSessionId === target.selectedSessionId) return;
  if (target.selectedThreadId === undefined) {
    throw { code: "INVALID_ARGUMENT", message: "当前历史会话缺少 threadId，无法自动恢复后发送。" };
  }
  const handle = await client.command("session.resume", { threadId: target.selectedThreadId });
  const snapshot = await waitReceipt<OperatorStateSnapshot>(client, handle.requestId, 30_000);
  if (snapshot.sessionId !== target.selectedSessionId) {
    throw {
      code: "STATE_VERSION_CONFLICT",
      message: `恢复后的会话与发送目标不一致：期望 ${target.selectedSessionId}，实际 ${snapshot.sessionId}。`,
    };
  }
}
