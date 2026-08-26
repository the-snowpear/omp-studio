import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversationState, reduceConversationState } from "@omp-studio/client";
import type {
  ClientError,
  ClientEvent,
  ConversationItem,
  ConversationTranscriptReadPage,
  OpaqueCursor,
  QueryInput,
  QueryName,
  QueryResult,
  SessionId,
  SubscriptionScope,
  Unsubscribe,
} from "@omp-studio/client-contract";
import type { ConversationClient, ConversationIdentity } from "./conversationHost";
import { clearSessionRowsCache } from "./sessionRowsCache";
import { useConversation } from "./useConversation";

const sessionA = "session-a" as SessionId;
const sessionB = "session-b" as SessionId;

function userItem(itemId: string, text: string): Extract<ConversationItem, { kind: "message" }> {
  return {
    kind: "message",
    itemId,
    parentId: null,
    createdAt: "2026-08-25T00:00:01.000Z",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function archivePage(sessionId: SessionId, items: readonly ConversationItem[]): ConversationTranscriptReadPage {
  return {
    sessionId,
    transcriptRevision: `revision-${sessionId}`,
    branchLeafId: "leaf-archive",
    headCursor: "head-archive" as OpaqueCursor,
    hasMoreBefore: false,
    items,
  };
}

let frames: FrameRequestCallback[] = [];

/** 手动放行动画帧：不依赖真实时钟。 */
async function flushFrames(rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const batch = frames;
    frames = [];
    if (batch.length === 0) return;
    await act(async () => {
      for (const callback of batch) callback(0);
      await Promise.resolve();
    });
  }
}

/** 只实现 engine 真正用到的那几个方法，reducer 用的是产品代码里的那一份。 */
class SwitchClient implements ConversationClient {
  conversation = createInitialConversationState();
  reads: string[] = [];
  #pending: Array<(page: ConversationTranscriptReadPage) => void> = [];
  #stateListeners = new Set<(state: ReturnType<SwitchClient["getState"]>) => void>();

  getState() {
    return { conversation: this.conversation, commands: {} };
  }

  onState(listener: (state: ReturnType<SwitchClient["getState"]>) => void): Unsubscribe {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  subscribe(scope: SubscriptionScope, _listener: (event: ClientEvent) => void): Unsubscribe {
    void scope;
    return () => {};
  }

  beginTranscriptHydrate(identity: ConversationIdentity): number {
    this.conversation = reduceConversationState(this.conversation, { type: "beginHydrate", identity });
    this.#emit();
    return this.conversation.hydrateGeneration;
  }

  hydrateArchiveTranscript(page: ConversationTranscriptReadPage, generation: number): void {
    this.conversation = reduceConversationState(this.conversation, { type: "hydrateArchive", page, generation });
    this.#emit();
  }

  hydrateTranscript(): void {
    throw new Error("the switch test only exercises the archive plane");
  }

  prependTranscript(): void {}

  prependArchiveTranscript(): void {}

  failTranscriptHydrate(error: ClientError, generation: number): void {
    this.conversation = reduceConversationState(this.conversation, { type: "error", error, generation });
    this.#emit();
  }

  async query<TName extends QueryName>(name: TName, input: QueryInput<TName>): Promise<QueryResult<TName>> {
    void input;
    this.reads.push(name);
    const { promise, resolve } = Promise.withResolvers<ConversationTranscriptReadPage>();
    this.#pending.push(resolve);
    return (await promise) as QueryResult<TName>;
  }

  async settle(page: ConversationTranscriptReadPage): Promise<void> {
    const resolve = this.#pending.shift();
    if (resolve === undefined) throw new Error("no transcript read is in flight");
    await act(async () => {
      resolve(page);
      await Promise.resolve();
    });
    /* engine 的通知按帧合并：把排队的帧放掉，帧尾那次渲染才会发生。 */
    await flushFrames();
  }

  get inFlight(): number {
    return this.#pending.length;
  }

  #emit(): void {
    const state = this.getState();
    for (const listener of this.#stateListeners) listener(state);
  }
}

beforeEach(() => {
  clearSessionRowsCache();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useConversation session switching", () => {
  it("paints the last rows of a revisited session while its page is still loading", async () => {
    const client = new SwitchClient();
    const { result, rerender } = renderHook(
      ({ identity }) =>
        useConversation({ preview: false, client, identity, canRead: true, runtimeConnected: true }),
      { initialProps: { identity: { sessionId: sessionA } as ConversationIdentity } },
    );
    await client.settle(archivePage(sessionA, [userItem("a1", "第一条")]));
    expect(result.current.rows.map((row) => row.type)).toEqual(["user"]);

    // 切到另一条会话：没有缓存，诚实空壳。
    rerender({ identity: { sessionId: sessionB } as ConversationIdentity });
    expect(result.current.rows).toEqual([]);
    expect(result.current.state.hydrateStatus).toBe("loading");
    await client.settle(archivePage(sessionB, [userItem("b1", "另一条")]));

    // 切回来：页还没落地就先画出上次的行，顶部仍然是「正在加载」。
    rerender({ identity: { sessionId: sessionA } as ConversationIdentity });
    expect(result.current.state.hydrateStatus).toBe("loading");
    expect(result.current.rows).toHaveLength(1);
    await client.settle(archivePage(sessionA, [userItem("a1", "第一条")]));
    expect(result.current.rows).toHaveLength(1);
  });

  it("skips the archive read while the session is being activated", async () => {
    const client = new SwitchClient();
    const { result, rerender } = renderHook(
      ({ activating }) =>
        useConversation({
          preview: false,
          client,
          identity: { sessionId: sessionA } as ConversationIdentity,
          canRead: true,
          runtimeConnected: true,
          activating,
        }),
      { initialProps: { activating: true } },
    );
    expect(client.reads).toEqual([]);
    expect(result.current.state.hydrateStatus).toBe("loading");

    // 激活结束仍然没有 epoch：兜底补一次读取。
    rerender({ activating: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.reads).toEqual(["session.transcript.readPage"]);
    await client.settle(archivePage(sessionA, [userItem("a1", "第一条")]));
    expect(result.current.rows).toHaveLength(1);
  });
});
