import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const write = value => process.stdout.write(JSON.stringify(value) + "\n");

rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "prompt") {
    write({ type: "message_start", messageId: "m1" });
    for (const delta of ["he", "llo", "!"]) {
      setTimeout(() => write({ type: "message_update", messageId: "m1", delta }), 10);
    }
    setTimeout(() => write({ type: "agent_settled" }), 80);
  }
  if (message.type === "abort") {
    write({ type: "agent_settled", aborted: true });
  }
});
