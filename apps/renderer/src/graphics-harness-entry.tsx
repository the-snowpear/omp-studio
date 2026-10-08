import { createRoot } from "react-dom/client";
import { useState } from "react";
import { GraphicPreview } from "./graphics/GraphicPreview";
import { MarkdownText } from "./conversation/markdown";
import { PREVIEW_GRAPHICS } from "./preview/mediaPreview";
import { I18nProvider } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/workbench.css";
const samples: Record<string, string> = {
  ...PREVIEW_GRAPHICS,
  "scene.wrl": PREVIEW_GRAPHICS["scene.x3dv"]!.replace(
    "#X3D V3.3 utf8\nPROFILE Interchange",
    "#VRML V2.0 utf8",
  ),
  "chart.chart": JSON.stringify({
    columns: ["Round", "Score", "Baseline"],
    rows: [
      [1, 0.7, 0.7],
      [2, 0.76, 0.7],
      [3, 0.83, 0.7],
      [4, 0.86, 0.7],
    ],
  }),
  "graphic.svg":
    '<svg viewBox="0 0 320 180"><rect x="25" y="20" width="270" height="140" rx="16" fill="var(--accent)"/><text x="160" y="100" text-anchor="middle" fill="var(--surface)" font-size="24">Studio SVG</text></svg>',
  "flow.mmd": "flowchart LR\n A[Input]-->B[Review]-->C[Result]",
};
const fixtureUrls = Object.fromEntries(
  Object.entries(
    import.meta.glob("./graphics/fixtures/*", {
      query: "?url",
      import: "default",
      eager: true,
    }),
  )
    .filter(([name]) => !name.endsWith(".md"))
    .map(([name, url]) => [name.split("/").at(-1)!, url as string]),
);
const table =
  "| Model | Latency |\n|---|---:|\n| A | 12 ms |\n| B | 20 ms |\n| C | 8 ms |\n| D | 40 ms |\n";
function Harness() {
  const [name, setName] = useState("scene.x3dv"),
    [shown, setShown] = useState(true),
    [step, setStep] = useState(1),
    [theme, setTheme] = useState("light");
  const partial =
    '<svg viewBox="0 0 320 180"><rect x="20" y="20" width="' +
    step * 60 +
    '" height="100" fill="var(--accent)"/><path d="';
  return (
    <I18nProvider forcedLanguage="zh">
      <main style={{ padding: 24, maxWidth: 900, margin: "auto" }}>
        <h1>Graphics verification</h1>
        <label>
          Sample{" "}
          <select
            aria-label="Sample"
            value={name}
            onChange={(event) => setName(event.target.value)}
          >
            {[
              ...new Set([
                ...Object.keys(samples),
                ...Object.keys(fixtureUrls),
                "numeric-table",
                "streaming-svg",
              ]),
            ].map((key) => (
              <option key={key}>{key}</option>
            ))}
          </select>
        </label>
        <button
          className="btn outline"
          onClick={() => setShown((value) => !value)}
        >
          {shown ? "Hide preview" : "Show preview"}
        </button>
        <button
          className="btn outline"
          onClick={() => {
            const next = theme === "light" ? "dark" : "light";
            setTheme(next);
            document.documentElement.setAttribute("data-theme", next);
          }}
        >
          Toggle theme
        </button>
        {name === "streaming-svg" ? (
          <button
            className="btn outline"
            onClick={() => setStep((value) => (value % 4) + 1)}
          >
            Append SVG
          </button>
        ) : null}
        {shown ? (
          name === "numeric-table" ? (
            <MarkdownText text={table} />
          ) : name === "streaming-svg" ? (
            <MarkdownText streaming text={"\x60\x60\x60svg\n" + partial} />
          ) : (
            <GraphicPreview
              key={name}
              name={name}
              {...(samples[name] !== undefined
                ? { text: samples[name]! }
                : { src: fixtureUrls[name]! })}
            />
          )
        ) : null}
      </main>
    </I18nProvider>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Harness />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
