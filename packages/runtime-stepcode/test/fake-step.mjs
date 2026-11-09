import { createInterface } from "node:readline";

// Mirrors the real `step --mode rpc --include-live-events` event shapes so the
// adapter's mapping is exercised against upstream's protocol, not an invented one.
const rl = createInterface({ input: process.stdin });
const write = value => process.stdout.write(JSON.stringify(value) + "\n");
const userMessage = text => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "get_state") {
    write({
      type: "response",
      command: "get_state",
      id: message.id,
      success: true,
      data: { sessionId: "fake-session", isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    });
  }
  if (message.type === "prompt") {
    const text = String(message.message ?? "");
    write({ type: "agent_start" });
    write({ type: "message_start", message: userMessage(text) });
    write({ type: "message_end", message: userMessage(text) });
    write({
      type: "message_start",
      message: { role: "assistant", content: [], stopReason: "pending", timestamp: Date.now() },
    });
    for (const delta of ["he", "llo", "!"]) {
      setTimeout(
        () =>
          write({
            type: "message_update",
            usage: {},
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
          }),
        10,
      );
    }
    setTimeout(
      () =>
        write({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello!" }],
            stopReason: "stop",
            timestamp: Date.now(),
          },
        }),
      60,
    );
    setTimeout(() => {
      write({ type: "turn_end", messageRole: "assistant", toolResultCount: 0 });
      write({ type: "agent_end", willRetry: false, messageCount: 3 });
      write({ type: "agent_settled" });
    }, 70);
  }
  if (message.type === "abort") {
    write({ type: "agent_settled", aborted: true });
  }
});
