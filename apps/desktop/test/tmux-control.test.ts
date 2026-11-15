import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Writable } from "node:stream";
import { test } from "node:test";
import { TmuxControlParser, type TmuxBlock } from "../src/tmux/control-parser.js";
import { TmuxControlClient } from "../src/tmux/control-client.js";
import { parseTmuxLayout, tmuxLayoutChecksum } from "../src/tmux/layout.js";
import { actionLines, quoteTmux, sendKeysLines, supportedTmuxVersion } from "../src/tmux/commands.js";
import { TerminalOutputBatcher } from "../src/terminal-batch.js";

const fixtures = new URL("../../test/fixtures/tmux/", import.meta.url);
function replay(bytes: Buffer, split: boolean) {
  const blocks: TmuxBlock[] = [], notifications: Array<[string, string]> = [], output: Buffer[] = [], noise: string[] = [];
  const parser = new TmuxControlParser({ onBlock: block => blocks.push(block), onNotification: (name, args) => notifications.push([name, args.toString()]), onPaneOutput: (_id, data) => output.push(Buffer.from(data)), onNoise: line => noise.push(line.toString()), onProtocolError: kind => assert.fail(kind) });
  let seed = 17;
  for (let at = 0; at < bytes.length;) {
    seed = (seed * 16807) % 2147483647;
    const length = split ? seed % 4096 + 1 : bytes.length;
    parser.push(bytes.subarray(at, at + length)); at += length;
  }
  return { blocks, notifications, output: Buffer.concat(output), noise };
}
for (const name of readdirSync(fixtures).filter(name => name.endsWith(".bin"))) {
  test(`real tmux ${name}: arbitrary transport chunks preserve blocks, UTF-8 and layouts`, () => {
    const bytes = readFileSync(new URL(name, fixtures));
    const whole = replay(bytes, false);
    assert.deepEqual(replay(bytes, true), whole);
    assert.ok(whole.blocks.some(block => block.lines.some(line => line.toString() === "%begin is ordinary block output")));
    assert.ok(whole.output.includes(Buffer.from("中文 😀")));
    assert.ok(whole.notifications.some(([name]) => name === "%exit"));
    let nested = false, zoomed = false;
    for (const [event, args] of whole.notifications) if (event === "%layout-change") {
      const [, layout, visible, flags] = args.split(" ");
      const parsed = parseTmuxLayout(visible ?? layout!);
      assert.ok(parsed);
      nested ||= parsed.panes.length === 3;
      zoomed ||= flags?.includes("Z") === true && parsed.panes.length === 1;
    }
    assert.ok(nested); assert.ok(zoomed);
  });
}
test("notification bytes split across UTF-8 code points pass through the terminal batcher", () => {
  const text: string[] = [];
  const batcher = new TerminalOutputBatcher({ sink: { send: (_id, data) => text.push(data) } });
  batcher.open("pane");
  const parser = new TmuxControlParser({ onBlock() {}, onNotification() {}, onPaneOutput: (_id, bytes) => { batcher.push("pane", bytes); batcher.flush(); } });
  parser.push(Buffer.from("motd\n%begin 1 1 0\n%end 1 1 0\n"));
  const utf8 = Buffer.from("中");
  parser.push(Buffer.concat([Buffer.from("%output %0 "), utf8.subarray(0, 1), Buffer.from("\n%extended-output %0 0 : "), utf8.subarray(1), Buffer.from("\\134\\015\\012\n")]));
  batcher.closeAll();
  assert.equal(text.join(""), "中\\\r\n");
});
test("noise and exit reasons stay outside command blocks", () => {
  const events = replay(Buffer.from("hello\n%begin 1 1 0\n%output is a command result\n%end 1 1 0\n%exit too far behind\n"), true);
  assert.deepEqual(events.noise, ["hello"]);
  assert.equal(events.blocks[0]?.lines[0]?.toString(), "%output is a command result");
  assert.deepEqual(events.notifications, [["%exit", "too far behind"]]);
});
test("captured screen text resembling a different command's end marker stays in the screen", () => {
  const events = replay(Buffer.from("%begin 10 20 1\n%end 9 20 1\n%end 10 19 1\n%error 10 20 0\nshell prompt\n%end 10 20 1\n"), true);
  assert.equal(events.blocks.length, 1);
  assert.deepEqual(events.blocks[0]!.lines.map(line => line.toString()), ["%end 9 20 1", "%end 10 19 1", "%error 10 20 0", "shell prompt"]);
  assert.equal(events.blocks[0]!.ok, true);
});
test("layout checksum and nested pane rectangles reflect tmux's border cells", () => {
  const body = "100x30,0,0{40x30,0,0,0,59x30,41,0[59x15,41,0,1,59x14,41,16,2]}";
  const layout = parseTmuxLayout(`${tmuxLayoutChecksum(body)},${body}`)!;
  assert.deepEqual(layout.panes[2], { type: "pane", paneId: "%2", cols: 59, rows: 14, x: 41, y: 16 });
  assert.equal(parseTmuxLayout(`ffff,${body}`), undefined);
});
test("literal names and large Unicode pastes produce safe, byte-exact commands", () => {
  assert.equal(quoteTmux("x'; $HOME"), "'x'\\''; $HOME'");
  assert.deepEqual(actionLines({ kind: "renameWindow", windowId: "@1", name: "'; $HOME #{pane_id}" }), ["rename-window -t @1 ''\\''; $HOME ##{pane_id}'"]);
  const paste = "中文😀".repeat(120);
  const lines = sendKeysLines("%1", paste);
  assert.equal(lines.length, Math.ceil(Buffer.byteLength(paste) / 512));
  const actual = Buffer.from(lines.map(line => line.split(" -H ")[1]!.replaceAll(" ", "")).join(""), "hex");
  assert.equal(actual.toString(), paste);
  assert.deepEqual(actionLines({ kind: "resizeWindow", windowId: "@1", cols: 120, rows: 32 }), ["refresh-client -C 120x32"]);
  assert.equal(supportedTmuxVersion("3.1c"), false);
  for (const version of ["3.2a", "3.7c", "next-3.8", "master"]) assert.equal(supportedTmuxVersion(version), true);
});
test("startup gate prevents pairing our first command with the launch block; FIFO rejects command errors", async () => {
  const written: string[] = [];
  const stdin = new Writable({ write(chunk, _encoding, done) { written.push(chunk.toString()); done(); } });
  const client = new TmuxControlClient(stdin, { onNotification() {}, onPaneOutput() {} });
  const first = client.run("version"), second = client.run("bad");
  const rejected = assert.rejects(second, /unknown command/);
  assert.deepEqual(written, []);
  client.parser.push(Buffer.from("%begin 1 1 0\n%end 1 1 0\n"));
  await client.ready;
  assert.deepEqual(written, ["version\n", "bad\n"]);
  client.parser.push(Buffer.from("%begin 1 2 1\n3.2a\n%end 1 2 1\n%begin 1 3 1\nunknown command\n%error 1 3 1\n"));
  assert.equal((await first)[0]?.toString(), "3.2a");
  await rejected;
  client.detach();
  assert.equal(written.at(-1), "\n");
});
test("hook output cannot consume the pending response to a Studio command", async () => {
  const stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const client = new TmuxControlClient(stdin, { onNotification() {}, onPaneOutput() {} });
  client.parser.push(Buffer.from("%begin 1 1 0\n%end 1 1 0\n"));
  const windows = client.run("list-windows"), panes = client.run("list-panes");
  client.parser.push(Buffer.from("%begin 1 2 0\nhook output\n%end 1 2 0\n%begin 1 3 1\nwindows\n%end 1 3 1\n%begin 1 4 1\npanes\n%end 1 4 1\n"));
  assert.equal((await windows)[0]!.toString(), "windows");
  assert.equal((await panes)[0]!.toString(), "panes");
  client.detach();
});
