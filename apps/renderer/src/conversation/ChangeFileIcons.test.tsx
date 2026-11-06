import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { ChangesPanel, type ChangesDiffFile } from "./ChangesPanel";
import { TurnDiffCard } from "./TurnDiffCard";

afterEach(cleanup);

/**
 * 改动卡 / 改动侧栏的文件图标必须与 Explorer 同源：形由 iconNameFor() 决定，
 * 色由行上的 data-ftype 派生。这组用例锁的是「形接了、色没接」这一类回归——
 * 上一次落地就漏在这里：图标形状对了，但行上没有 data-ftype，全是同一个灰。
 */

function diffFile(file: string): ChangesDiffFile {
  return { file, add: 1, del: 0, hunks: [{ hunkLabel: "@@ -1 +1 @@", lines: [] }] };
}

function renderPanel(files: readonly string[]) {
  return render(
    <I18nProvider forcedLanguage="zh">
      <ChangesPanel
        turns={[{ id: "t1", label: "第 1 轮", add: files.length, del: 0 }]}
        turnId="t1"
        onTurnChange={() => {}}
        files={files.map(diffFile)}
        expanded={new Set()}
        onToggle={() => {}}
        split={false}
        onSplit={() => {}}
      />
    </I18nProvider>,
  );
}

it("puts the file type on change sidebar rows, not just on the icon", () => {
  const { container } = renderPanel(["src/App.tsx", "src/index.html", "src/base.css", "turbo.json"]);
  const rows = [...container.querySelectorAll(".ch-item")];
  expect(rows.map((row) => row.getAttribute("data-ftype"))).toEqual(["code", "markup", "style", "config"]);
});

it("classifies sidebar rows by basename so nested secret and pinned files still resolve", () => {
  const { container } = renderPanel(["config/.env", "docs/README.md", "notes.md"]);
  const rows = [...container.querySelectorAll(".ch-item")];
  // 传完整路径时 `config/.env` 会一路落空到 null，红色和钥匙形都不会出现。
  expect(rows[0]?.getAttribute("data-ftype")).toBe("secret");
  expect(rows[0]?.hasAttribute("data-secret")).toBe(true);
  expect(rows[1]?.getAttribute("data-ftype")).toBe("doc");
  // 同为 doc，README 走旗舰「书」形，普通 md 走文档形——形与色是两轴。
  expect(rows[1]?.querySelector(".ch-row-icon svg")?.innerHTML).not.toBe(rows[2]?.querySelector(".ch-row-icon svg")?.innerHTML);
});

it("marks turn diff card rows with the same type and sensitive flag as the tree", () => {
  const { container } = render(
    <I18nProvider forcedLanguage="zh">
      <TurnDiffCard
        files={[
          { path: "src/App.tsx", name: "App.tsx", dir: "src/", add: 2, del: 0 },
          { path: "config/.env", name: ".env", dir: "config/", add: 1, del: 1 },
        ]}
        defaultOpen
      />
    </I18nProvider>,
  );
  const rows = [...container.querySelectorAll(".turn-diff-row")];
  expect(rows[0]?.getAttribute("data-ftype")).toBe("code");
  expect(rows[0]?.hasAttribute("data-secret")).toBe(false);
  expect(rows[1]?.getAttribute("data-ftype")).toBe("secret");
  expect(rows[1]?.hasAttribute("data-secret")).toBe(true);
});

it("leaves unknown extensions untyped so the icon falls back instead of guessing", () => {
  const { container } = renderPanel(["assets/blob.unknownext"]);
  const row = container.querySelector(".ch-item");
  expect(row?.hasAttribute("data-ftype")).toBe(false);
  expect(row?.hasAttribute("data-secret")).toBe(false);
});
