import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Profiler, useSyncExternalStore } from "react";
import type { ConversationMessageItem, ConversationRuntimeEvent, SessionId } from "@omp-studio/client-contract";
import { ConversationStore } from "./conversationStore";
import { ConvoTranscript } from "./ConvoTranscript";

afterEach(cleanup);

const BASH_OUTPUT = Array.from({ length: 200 }, (_, index) => `line ${index} — output row referencing src/module/file${index}.ts`).join("\n");
const PROSE = "这是一段说明文本。\n\n下面是一段代码：\n\n```ts\nconst value = compute();\n```\n\n然后继续解释。";

function userItem(id: string): ConversationMessageItem {
  return { kind: "message", itemId: id, parentId: null, createdAt: id, role: "user", content: [{ type: "text", text: `第 ${id} 个请求` }] };
}

function assistantItem(id: string, tools: number): ConversationMessageItem {
  const content: ConversationMessageItem["content"][number][] = [{ type: "text", text: PROSE }];
  for (let index = 0; index < tools; index += 1) {
    content.push({ type: "toolCall", toolCallId: `${id}-t${index}`, toolName: "bash", arguments: { command: `npm test -- ${index}` } } as never);
    content.push({ type: "toolResult", toolCallId: `${id}-t${index}`, toolName: "bash", isError: false, output: BASH_OUTPUT } as never);
  }
  return { kind: "message", itemId: id, parentId: null, createdAt: id, role: "assistant", content };
}

function scheduler() {
  let next = 1;
  const callbacks = new Map<number, () => void>();
  return {
    frame: {
      request(callback: () => void) { const id = next++; callbacks.set(id, callback); return id; },
      cancel(id: number | ReturnType<typeof setTimeout>) { callbacks.delete(id as number); },
    },
    flush() { const queued = [...callbacks.values()]; callbacks.clear(); for (const callback of queued) callback(); },
  };
}

function Harness({ store, onCommit }: { store: ConversationStore; onCommit: (duration: number) => void }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <Profiler id="transcript" onRender={(_id, _phase, actual) => onCommit(actual)}>
      <ConvoTranscript rows={snapshot.rows} />
    </Profiler>
  );
}

/** Sum of React's own commit durations for `frames` published streaming frames. */
function commitCostOfGrowingToolOutput(baseLines: number, frames: number): number {
  const frameScheduler = scheduler();
  const sessionId = "session" as SessionId;
  const store = new ConversationStore({ target: { sessionId }, identity: { sessionId }, generation: 1, scheduler: frameScheduler.frame });
  const items: ConversationMessageItem[] = [];
  for (let turn = 0; turn < 8; turn += 1) items.push(userItem(`u${turn}`), assistantItem(`a${turn}`, 2));
  store.hydrate({ items, headCursor: "head" as never, hasMoreBefore: false });
  store.applyEvent({ kind: "conversation.message.started", sessionId, turnId: "live-turn", messageId: "live", role: "assistant", createdAt: "live" }, 1);
  store.applyEvent({ kind: "conversation.tool.started", sessionId, turnId: "live-turn", messageId: "live", toolCallId: "live-tool", toolName: "bash", startedAt: "now", arguments: { command: "npm run build" } } as ConversationRuntimeEvent, 2);
  const base = Array.from({ length: baseLines }, (_, index) => `[build] step ${index} finished in ${index * 3}ms`).join("\n");
  store.applyEvent({ kind: "conversation.tool.updated", sessionId, turnId: "live-turn", toolCallId: "live-tool", updateMode: "replace", output: base } as ConversationRuntimeEvent, 3);
  frameScheduler.flush();

  let total = 0;
  const view = render(<Harness store={store} onCommit={(duration) => { total += duration; }} />);
  total = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    store.applyEvent(
      { kind: "conversation.tool.updated", sessionId, turnId: "live-turn", toolCallId: "live-tool", updateMode: "append", output: `\n[build] extra line ${frame}` } as ConversationRuntimeEvent,
      frame + 4,
    );
    act(() => { frameScheduler.flush(); });
  }
  view.unmount();
  store.dispose();
  return total;
}

describe("streaming frame cost", () => {
  it("keeps a published frame independent of how much output the live tool has produced", () => {
    // The regression: `bashDisplay` used to emit one row per line and `BashBody`
    // rebuilt every one of them per published frame, so a running command with a
    // long log spent the whole frame budget in React before the browser had laid
    // anything out — which is why an expand/collapse animation only stuttered
    // while a turn was streaming. Same-class line runs now collapse into one
    // node, so the cost is bounded by the retained tail, not by the line count.
    const frames = 20;
    const short = commitCostOfGrowingToolOutput(40, frames);
    const long = commitCostOfGrowingToolOutput(1200, frames);
    expect(short).toBeGreaterThan(0);
    expect(long).toBeLessThan(short * 2.5);
  });
});
