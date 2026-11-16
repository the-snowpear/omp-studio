// Capture real control-mode bytes. Optional --ssh <alias> / --container <name>.
// Only the unique studio-capture-* socket created here is ever stopped.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const ssh = option("--ssh"), container = option("--container");
const socket = `studio-capture-${randomUUID()}`;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function launch(args) {
  let command = "tmux", argv = ["-L", socket, "-f", "/dev/null", ...args];
  if (container) { argv = ["exec", "-i", container, command, ...argv]; command = "docker"; }
  if (ssh) { argv = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", ssh, [command, ...argv].map(quote).join(" ")]; command = "ssh"; }
  return spawn(command, argv, { stdio: "pipe", windowsHide: true });
}
const child = launch(["-u", "-C", "new-session", "-s", "cap", "-x", "120", "-y", "32"]);
const chunks = [], blocks = [], waiters = [];
let pending = Buffer.alloc(0), block, version, failure;
function nextBlock() { return blocks.length ? Promise.resolve(blocks.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject })); }
child.stdout.on("data", chunk => {
  chunks.push(chunk);
  pending = Buffer.concat([pending, chunk]);
  let at;
  while ((at = pending.indexOf(10)) >= 0) {
    const line = pending.subarray(0, at).toString().replace(/\r$/, ""); pending = pending.subarray(at + 1);
    if (block && /^%(end|error) \d+ \d+ \d+$/.test(line)) {
      const result = { ok: line.startsWith("%end "), lines: block ?? [] }; block = undefined;
      const waiter = waiters.shift(); if (waiter) waiter.resolve(result); else blocks.push(result);
    } else if (block) block.push(line);
    else if (line.startsWith("%begin ")) block = [];
  }
});
child.stderr.on("data", chunk => process.stderr.write(chunk));
child.on("error", error => { failure = error; for (const waiter of waiters.splice(0)) waiter.reject(error); });
child.on("exit", () => { for (const waiter of waiters.splice(0)) waiter.reject(failure ?? new Error("tmux exited before response")); });
const timeout = setTimeout(() => { failure = new Error("Capture timed out"); child.kill(); }, 60_000);
const run = async (line, allowError = false) => {
  child.stdin.write(line + "\n");
  const result = await nextBlock();
  if (!result.ok && !allowError) throw new Error(`${line}: ${result.lines.join("\n")}`);
  return result.lines;
};
const type = async text => {
  await run(`send-keys -t %0 -H ${[...Buffer.from(text)].map(byte => byte.toString(16).padStart(2, "0")).join(" ")}`);
  await run("run-shell 'sleep 0.2'");
};
try {
  const startup = await nextBlock();
  if (!startup.ok) throw new Error(startup.lines.join("\n"));
  [version] = await run("display-message -p '#{version}'");
  await run("refresh-client -f pause-after=15");
  await run("refresh-client -C 120x32");
  await run("refresh-client -C @0:100x30", true);
  await run("refresh-client -B 'studio-title:%*:#{pane_title}'");
  await run("refresh-client -B 'studio-cwd:%*:#{pane_current_path}'");
  await type("printf '中文 😀 \\\\ \\n'\r");
  await type("head -c 204800 /dev/zero | tr '\\0' x; printf '\\n'\r");
  await type("vi -u NONE -n\r");
  await run("list-panes -s -F '#{pane_id}\t#{alternate_on}\t#{keypad_cursor_flag}\t#{keypad_flag}\t#{mouse_any_flag}\t#{mouse_sgr_flag}\t#{wrap_flag}\t#{origin_flag}\t#{scroll_region_upper}\t#{scroll_region_lower}\t#{cursor_flag}'");
  await run("capture-pane -p -e -t %0");
  await run("capture-pane -p -e -a -t %0");
  await type("\x1b:q!\r");
  await run("split-window -h -t %0");
  await run("split-window -v -t %1");
  await run("list-windows -F '#{window_id}\t#{window_index}\t#{window_active}\t#{window_flags}\t#{window_visible_layout}\t#{window_name}'");
  await run("resize-pane -t %0 -x 40");
  await run("resize-pane -t %0 -Z");
  await run("list-windows -F '#{window_id}\t#{window_layout}\t#{window_visible_layout}'");
  await run("resize-pane -t %0 -Z");
  await run("refresh-client -A '%0:off'");
  await run("refresh-client -A '%0:on'");
  await run("refresh-client -A '%0:continue'");
  await run("capture-pane -p -e -J -t %0 -S -1000");
  await run("display-message -p '%%begin is ordinary block output'");
  await run("new-window -t @0 -a");
  await run("rename-window -t @1 'quote'\\''; $HOME ##{pane_id}'");
  await run("list-windows -F '#{window_id}\t#{window_name}'");
  await run("kill-window -t @1");
  await run("kill-pane -t %2");
  const exited = new Promise(resolve => child.once("close", resolve));
  child.stdin.end("\n");
  await exited;
  const directory = fileURLToPath(new URL("../apps/desktop/test/fixtures/tmux/", import.meta.url));
  await mkdir(directory, { recursive: true });
  const name = `${version}-control.bin`;
  await writeFile(`${directory}/${name}`, Buffer.concat(chunks));
  console.log(`Captured ${name}: ${Buffer.concat(chunks).length} bytes${ssh ? " over ssh -T" : ""}`);
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  if (child.exitCode === null) child.kill();
  const cleanup = launch(["kill-server"]);
  cleanup.stdout.resume(); cleanup.stderr.resume();
}
