/** Test-only real-browser fixtures. Imported exclusively by perf-harness-entry. */
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MarkdownText } from "./conversation/markdown";
import { highlightPool } from "./highlight/service";
import { mermaidQueue } from "./conversation/LazyMermaid";
import { performanceOptions } from "./performanceOptions";
import { createConversationEngine } from "./conversation/conversationEngine";
import { createSubagentConversationEngine } from "./conversation/subagentConversationEngine";
import { collectRendererResources } from "./rendererResources";
import { ConversationPane } from "./conversation/ConversationPane";
import { ConversationStore } from "./conversation/conversationStore";
import type { ConversationIdentity } from "./conversation/conversationHost";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let input: HTMLButtonElement | undefined;
const latencies: number[] = [];
let backgroundStore: ConversationStore | undefined;

function mount() {
  if (host !== undefined) return host;
  host = document.createElement("div");
  host.id = "render-work-harness";
  Object.assign(host.style, { position: "fixed", inset: "50px 0 0", overflow: "auto", zIndex: "9999", background: "white" });
  document.body.appendChild(host); root = createRoot(host);
  input = document.createElement("button"); input.id = "perf-input-probe"; input.textContent = "Input probe";
  Object.assign(input.style, { position: "fixed", top: "0", left: "0", width: "200px", height: "40px", zIndex: "10000" });
  input.addEventListener("pointerdown", (event) => {
    const stamp = event.timeStamp;
    requestAnimationFrame(() => setTimeout(() => latencies.push(performance.now() - stamp), 0));
  });
  document.body.appendChild(input);
  return host;
}
const fixture = (index: number, lines: number) => Array.from({ length: lines }, (_, line) =>
  `export function item${index}_${line}(value: number): string { return "结果" + (value + ${line}); }`).join("\n");

export const renderWorkHarness = {
  options: performanceOptions,
  counters: () => ({ highlight: highlightPool.getDiagnostics(), mermaid: mermaidQueue.getDiagnostics() }),
  async highlight(count = 100, lines = 40) {
    const element = mount(); latencies.length = 0;
    let immediatelyFramed = 0, colored = 0, remounts = 0, textMismatches = 0, maxHeightShift = 0, syncRenderMs = 0;
    for (let index = 0; index < count; index++) {
      const code = fixture(index, lines);
      // Browser-owned tasks (not a CDP evaluation continuation) are included
      // in Performance.ScriptDuration. Time the synchronous part separately.
      await new Promise<void>((resolve) => setTimeout(() => {
        const start = performance.now();
        flushSync(() => root!.render(<MarkdownText key={index} text={`\`\`\`ts\n${code}\n\`\`\``} />));
        syncRenderMs += performance.now() - start; resolve();
      }, 0));
      const outer = element.querySelector<HTMLElement>(".md-code")!;
      if (outer !== null) immediatelyFramed++;
      const height = outer.getBoundingClientRect().height;
      const deadline = performance.now() + 6500;
      if (performanceOptions.highlightWorker) {
        while (element.querySelector('[data-highlight-state="pending"]') !== null && performance.now() < deadline) await frame();
      }
      if (element.querySelector(".hljs-keyword") !== null) colored++;
      if (element.querySelector(".md-code") !== outer) remounts++;
      if (element.querySelector("pre code")?.textContent !== code + "\n") textMismatches++;
      maxHeightShift = Math.max(maxHeightShift, Math.abs(height - outer.getBoundingClientRect().height));
      await frame();
    }
    flushSync(() => root!.render(null));
    return { count, lines, immediatelyFramed, colored, remounts, textMismatches, maxHeightShift, syncRenderMs,
      inputPaintLatencies: [...latencies], counters: this.counters() };
  },
  async fences() {
    const element = mount();
    flushSync(() => root!.render(<MarkdownText text={'```ts\nconst a ='} streaming />));
    const result = { framed: element.querySelector(".md-code") !== null, text: element.querySelector("pre code")?.textContent };
    flushSync(() => root!.render(null));
    return result;
  },
  async mermaid() {
    const element = mount();
    flushSync(() => root!.render(<MarkdownText text={'```mermaid\ngraph TD; A-->B\n```'} />));
    const deadline = performance.now() + 15000;
    while (element.querySelector("svg") === null && performance.now() < deadline) await frame();
    const rendered = element.querySelector("svg") !== null;
    flushSync(() => root!.render(null));
    return { rendered, counters: this.counters() };
  },
  async mermaidPressure() {
    const element = mount();
    flushSync(() => root!.render(<>{Array.from({ length: 12 }, (_, i) => <MarkdownText key={i} text={`\`\`\`mermaid\ngraph TD; A${i}-->B${i}\n\`\`\``} />)}</>));
    await frame(); await frame();
    const during = this.counters().mermaid;
    flushSync(() => root!.render(null));
    const deadline = performance.now() + 15000;
    while (this.counters().mermaid.running !== 0 && performance.now() < deadline) await frame();
    flushSync(() => root!.render(<MarkdownText text={'```mermaid\n' + 'x'.repeat(20001) + '\n```'} />));
    const oversizedSource = element.querySelector("pre code")?.textContent?.length === 20001;
    const noOversizedSvg = element.querySelector("svg") === null;
    flushSync(() => root!.render(null));
    return { during, after: this.counters().mermaid, oversizedSource, noOversizedSvg };
  },
  async lifecycles() {
    mount();
    const before = collectRendererResources();
    for (let i = 0; i < 50; i++) {
      const main = createConversationEngine({ preview: true, client: null, identity: null, canRead: true, runtimeConnected: false,
        previewItems: [{ kind: "message", itemId: `a${i}`, parentId: null, role: "assistant", createdAt: "now", content: [{ type: "text", text: "Synthetic lifecycle fixture" }] }] });
      const child = createSubagentConversationEngine({ preview: true, client: null, target: { agentId: "child", toolCallId: "tool" }, runtimeConnected: false,
        previewItems: [{ kind: "message", itemId: `child${i}`, parentId: null, role: "assistant", createdAt: "now", content: [{ type: "text", text: "Synthetic child fixture" }] }] });
      main.start(); child.start();
      flushSync(() => root!.render(<ConversationPane liveEngine={main} onLoadOlder={() => {}} />));
      await frame();
      flushSync(() => root!.render(<ConversationPane snapshot={child.getSnapshot()} onLoadOlder={() => {}} />));
      await frame();
      flushSync(() => root!.render(null)); main.dispose(); child.dispose();
      if (main.getSnapshot().rows.length !== 0 || child.getSnapshot().rows.length !== 0) throw new Error("disposed engine retained rows");
    }
    return { before, after: collectRendererResources() };
  },
  background(action: "start" | "feed" | "read" | "stop") {
    if (action === "start") {
      backgroundStore?.dispose();
      const identity = { sessionId: "background-harness", runtimeEpoch: 1 } as ConversationIdentity;
      backgroundStore = new ConversationStore({ identity, target: { sessionId: identity.sessionId }, generation: 1, backgroundPublishing: true });
      backgroundStore.applyEvent({ kind: "conversation.message.started", sessionId: identity.sessionId, turnId: "t", messageId: "m", role: "assistant", createdAt: "now" }, 1);
    }
    if (action === "feed") for (let i = 0; i < 10000; i++) backgroundStore!.applyEvent({
      kind: "conversation.message.delta", sessionId: "background-harness" as ConversationIdentity["sessionId"],
      turnId: "t", messageId: "m", blockId: "b", blockType: "text", delta: "x",
    }, i + 2);
    const result = { hidden: document.hidden, counters: backgroundStore?.getDiagnostics(),
      length: backgroundStore?.getSnapshot().state.liveMessages.m?.blocks[0]?.text.length ?? 0 };
    if (action === "stop") { backgroundStore?.dispose(); backgroundStore = undefined; }
    return result;
  },
  unmount() { root?.unmount(); root = undefined; host?.remove(); host = undefined; input?.remove(); input = undefined; },
};
