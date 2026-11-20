import { expect, it } from "vitest";
import { displayLog } from "./logDisplay";

it("decodes RGB, indexed backgrounds, and resets without leaving escape codes in the text", () => {
  const log = displayLog("\x1b[38:2::18:52:86;48;5;235mcolor\x1b[39m background\x1b[m plain");
  expect(log.text).toBe("color background plain");
  expect(log.marks.map(mark => [log.text.slice(mark.from, mark.to), mark.style])).toEqual([
    ["color", "color: rgb(18 52 86); background-color: rgb(38 38 38)"],
    [" background", "background-color: rgb(38 38 38)"],
  ]);
});

it("preserves explicit colors over level colors and strips non-color sequences", () => {
  const log = displayLog("\x1b[2K\x1b[31mPASS\x1b[0m command\r\n\x1b]8;;https://example.test\x1b\\detail\x1b]8;;\x1b\\\n  [INFO] ready");
  expect(log.text).toBe("PASS command\ndetail\n  [INFO] ready");
  expect(log.marks.map(mark => [log.text.slice(mark.from, mark.to), mark.style])).toEqual([
    ["PASS", "color: var(--red)"],
    ["[INFO]", "color: var(--blue); font-weight: var(--fw-semibold)"],
  ]);
});
