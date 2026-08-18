import { describe, expect, it } from "vitest";

import {
  beginQueueEdit,
  cancelQueueEdit,
  commitQueueEdit,
  parkQueueEdit,
  snapshotOfQueued,
  switchQueueEdit,
  type EditableQueued,
} from "./queueEdit";
import { snapshotFromDoc } from "./serialize";
import { emptySnapshot, type ComposerSnapshot } from "./types";

const png = { type: "image" as const, mimeType: "image/png" as const, data: "aaa" };

function row(id: number, text: string, sessionId = "sess-a"): EditableQueued {
  return { id, text, sessionId, doc: { nodes: [{ type: "text", value: text }] } };
}

function stashWithChips(): ComposerSnapshot {
  return snapshotFromDoc({
    nodes: [
      { type: "text", value: "keep " },
      { type: "chip", chip: { id: "sk", kind: "skill", label: "foo", name: "foo" } },
      { type: "text", value: " " },
      { type: "chip", chip: { id: "img", kind: "image", label: "图1", image: png } },
      { type: "chip", chip: { id: "file", kind: "file", label: "a.ts", path: "src/a.ts" } },
    ],
  });
}

describe("queueEdit", () => {
  it("begin leaves the row in place and loads it into composer while stashing the draft", () => {
    const stashed = stashWithChips();
    const queue = [row(1, "first"), row(2, "second")];
    const result = beginQueueEdit({ queue, composer: stashed, entry: queue[1]! });
    expect(result.queue.map((item) => item.id)).toEqual([1, 2]);
    expect(result.queue[1]?.text).toBe("second");
    expect(result.editing).toEqual({ entryId: 2, stashed });
    expect(result.composer.text).toBe("second");
    expect(result.editing?.stashed.doc.nodes.some((node) => node.type === "chip" && node.chip.kind === "skill")).toBe(true);
    expect(result.editing?.stashed.images).toEqual([png]);
  });

  it("commit writes the edited snapshot back to the same index and restores the stash", () => {
    const stashed = stashWithChips();
    const queue = [row(1, "first"), row(2, "second"), row(3, "third")];
    const started = beginQueueEdit({ queue, composer: stashed, entry: queue[1]! });
    const edited = snapshotFromDoc({
      nodes: [
        { type: "text", value: "second+" },
        { type: "chip", chip: { id: "sk2", kind: "skill", label: "bar", name: "bar" } },
      ],
    });
    const result = commitQueueEdit({
      queue: started.queue,
      editing: started.editing!,
      composer: edited,
    });
    expect(result.editing).toBeUndefined();
    expect(result.queue.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(result.queue[1]?.text).toContain("second+");
    expect(result.queue[1]?.text).toContain("/skill:bar");
    expect(result.queue[1]?.doc?.nodes).toEqual(edited.doc.nodes);
    expect(result.composer).toEqual(stashed);
    expect(result.composer.images).toEqual([png]);
  });

  it("commit with an empty composer removes that row and still restores the stash", () => {
    const stashed = stashWithChips();
    const queue = [row(1, "first"), row(2, "second")];
    const started = beginQueueEdit({ queue, composer: stashed, entry: queue[0]! });
    const result = commitQueueEdit({
      queue: started.queue,
      editing: started.editing!,
      composer: emptySnapshot(),
    });
    expect(result.queue.map((item) => item.id)).toEqual([2]);
    expect(result.composer).toEqual(stashed);
  });

  it("cancel leaves the queue untouched and restores the stash", () => {
    const stashed = stashWithChips();
    const queue = [row(1, "first"), row(2, "second")];
    const started = beginQueueEdit({ queue, composer: stashed, entry: queue[0]! });
    const result = cancelQueueEdit({
      queue: started.queue,
      editing: started.editing!,
    });
    expect(result.queue).toEqual(queue);
    expect(result.editing).toBeUndefined();
    expect(result.composer).toEqual(stashed);
  });

  it("switch writes the previous row in place and keeps the original stash", () => {
    const stashed = stashWithChips();
    const queue = [row(1, "first"), row(2, "second"), row(3, "third")];
    const started = beginQueueEdit({ queue, composer: stashed, entry: queue[0]! });
    const mid = snapshotFromDoc({ nodes: [{ type: "text", value: "first-edited" }] });
    const result = switchQueueEdit({
      queue: started.queue,
      editing: started.editing!,
      composer: mid,
      entry: queue[2]!,
    });
    expect(result.editing?.entryId).toBe(3);
    expect(result.editing?.stashed).toEqual(stashed);
    expect(result.queue.map((item) => item.text)).toEqual(["first-edited", "second", "third"]);
    expect(result.composer.text).toBe("third");
  });

  it("park writes a non-empty snapshot back without deleting, and restores the stash", () => {
    const stashed = stashWithChips();
    const queue = [row(1, "first"), row(2, "second")];
    const started = beginQueueEdit({ queue, composer: stashed, entry: queue[0]! });
    const parked = parkQueueEdit({
      queue: started.queue,
      editing: started.editing!,
      composer: snapshotFromDoc({ nodes: [{ type: "text", value: "first-parked" }] }),
    });
    expect(parked.editing).toBeUndefined();
    expect(parked.queue.map((item) => item.text)).toEqual(["first-parked", "second"]);
    expect(parked.composer).toEqual(stashed);

    const startedAgain = beginQueueEdit({ queue, composer: stashed, entry: queue[0]! });
    const emptyPark = parkQueueEdit({
      queue: startedAgain.queue,
      editing: startedAgain.editing!,
      composer: emptySnapshot(),
    });
    expect(emptyPark.queue.map((item) => item.text)).toEqual(["first", "second"]);
  });

  it("snapshotOfQueued round-trips chips and clipboard images", () => {
    const snapshot = stashWithChips();
    const entry: EditableQueued = {
      id: 9,
      text: snapshot.text,
      images: snapshot.images,
      doc: snapshot.doc,
      sessionId: "sess-a",
    };
    expect(snapshotOfQueued(entry)).toEqual(snapshot);
  });
});
