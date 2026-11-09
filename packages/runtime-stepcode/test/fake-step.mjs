import { createInterface } from "node:readline";

// Mirrors the real `step --mode rpc --include-live-events` event shapes so the
// adapter's mapping is exercised against upstream's protocol, not an invented one.
const rl = createInterface({ input: process.stdin });
const write = value => process.stdout.write(JSON.stringify(value) + "\n");
const userMessage = text => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

// A catalog with two providers so selector resolution has something to resolve.
const CATALOG = {
  models: [
    { id: "stepfun-cn/step-3.7-flash", name: "Step 3.7 Flash", provider: "local-gateway" },
    { id: "zed/claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "local-gateway" },
  ],
};

const state = {
  sessionId: "fake-session",
  model: "stepfun-cn/step-3.7-flash",
  thinkingLevel: "off",
  entries: [],
};

function appendEntry(type, extra) {
  const entry = { id: `e${state.entries.length + 1}`, parentId: state.entries.at(-1)?.id ?? null, timestamp: Date.now(), type, ...extra };
  state.entries.push(entry);
  return entry;
}

rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "get_state") {
    write({
      type: "response",
      command: "get_state",
      id: message.id,
      success: true,
      data: {
        sessionId: state.sessionId,
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        model: { id: state.model, provider: "local-gateway" },
        thinkingLevel: state.thinkingLevel,
      },
    });
  }
  if (message.type === "get_available_models") {
    write({ type: "response", command: "get_available_models", id: message.id, success: true, data: CATALOG });
  }
  if (message.type === "get_available_thinking_levels") {
    write({ type: "response", command: "get_available_thinking_levels", id: message.id, success: true, data: { levels: ["off", "low", "high"] } });
  }
  if (message.type === "set_model") {
    state.model = `${message.provider}/${message.modelId}`;
    write({ type: "response", command: "set_model", id: message.id, success: true });
  }
  if (message.type === "set_thinking_level") {
    state.thinkingLevel = message.level;
    write({ type: "response", command: "set_thinking_level", id: message.id, success: true });
  }
  if (message.type === "get_entries") {
    write({ type: "response", command: "get_entries", id: message.id, success: true, data: { entries: state.entries, leafId: state.entries.at(-1)?.id ?? null } });
  }
  if (message.type === "fork") {
    write({ type: "response", command: "fork", id: message.id, success: true, data: { text: "", cancelled: false } });
  }
  if (message.type === "steer" || message.type === "follow_up") {
    write({ type: "response", command: message.type, id: message.id, success: true });
  }
  if (message.type === "prompt") {
    const text = String(message.message ?? "");
    write({ type: "agent_start" });
    const userEntry = appendEntry("message", { message: userMessage(text) });
    write({ type: "message_start", message: userMessage(text) });
    write({ type: "message_end", message: userMessage(text) });
    const assistantEntry = appendEntry("message", {
      message: { role: "assistant", content: [{ type: "text", text: "hello!" }], stopReason: "stop", timestamp: Date.now() },
    });
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
          message: state.entries.find((entry) => entry.id === assistantEntry.id).message,
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
