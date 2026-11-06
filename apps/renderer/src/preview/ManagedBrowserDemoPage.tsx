import { useState, type MouseEvent, type ReactNode } from "react";
import type { ManagedBrowserPage } from "@omp-studio/studio-protocol";
import "./managedBrowserDemo.css";

export type DemoPick = { selector: string; tagName: string; text: string; rect: { x: number; y: number; width: number; height: number } };

/**
 * Stand-in web pages for preview mode, where no native page exists. They are
 * plain local markup: picking an element only adds a reference in this window.
 */
export function ManagedBrowserDemoPage({ page, picking, interactive, hint, onPick }: {
  page: ManagedBrowserPage; picking: boolean; interactive: boolean; hint: string | null; onPick: (pick: DemoPick) => void;
}) {
  const [count, setCount] = useState(0);
  const target = (selector: string, tagName: string, text: string) => ({
    "data-demo-pick": selector,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      // Capture runs outside-in: only the innermost pickable element under the pointer answers.
      if (!picking || (event.target as Element).closest("[data-demo-pick]") !== event.currentTarget) return;
      event.preventDefault(); event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      onPick({ selector, tagName, text, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
    },
  });
  const url = page.url;
  let body: ReactNode;
  if (url.includes("/docs/")) body = <article className="mbd-doc">
    <nav className="mbd-doc-crumbs" {...target("nav.crumbs", "nav", "文档 / 工作台 / 浏览器")}>文档 / 工作台 / 浏览器</nav>
    <h1 {...target("article > h1", "h1", "在对话里使用浏览器")}>在对话里使用浏览器</h1>
    <p {...target("article > p:nth-of-type(1)", "p", "每个对话都有自己的网页。")}>每个对话都有自己的网页，你和 Agent 看到的是同一张页面。需要亲自操作时先接管，用完再交还。</p>
    <div className="mbd-callout" {...target("aside.callout", "aside", "选择元素后可以写备注")}><strong>提示</strong> 选择元素后可以写备注，一起放进输入框发给 Agent。</div>
    <pre {...target("pre.code", "pre", "browser open localhost:5173")}><code>browser open http://localhost:5173 --target main</code></pre>
  </article>;
  else if (url.includes("localhost:6006")) body = <div className="mbd-story">
    <aside className="mbd-story-tree"><strong>Components</strong><span>Badge</span><span className="is-active">Button</span><span>Dialog</span><span>Tabs</span></aside>
    <main className="mbd-story-canvas">
      <div className="mbd-story-stage"><button type="button" className="mbd-button" {...target("button.primary", "button", "Primary")} disabled={!interactive}>Primary</button><button type="button" className="mbd-button is-ghost" {...target("button.ghost", "button", "Ghost")} disabled={!interactive}>Ghost</button></div>
      <table className="mbd-story-args" {...target("table.args", "table", "Controls")}><tbody><tr><th>variant</th><td>primary</td></tr><tr><th>size</th><td>medium</td></tr><tr><th>disabled</th><td>false</td></tr></tbody></table>
    </main>
  </div>;
  else body = <div className="mbd-app">
    <header className="mbd-app-bar"><span className="mbd-app-logo" aria-hidden="true" /><strong>Studio Kit</strong><nav><span className="is-active">Components</span><span>Tokens</span><span>Changelog</span></nav></header>
    <div className="mbd-app-body">
      <aside className="mbd-app-side"><span>Overview</span><span className="is-active">Button</span><span>Input</span><span>Select</span><span>Toast</span></aside>
      <main className="mbd-app-main">
        <p className="mbd-app-crumbs">Components / Button</p>
        <h1 {...target("main > h1", "h1", "Button")}>Button</h1>
        <p {...target("main > p.lead", "p", "Buttons trigger an action or event.")} className="mbd-app-lead">Buttons trigger an action or event. Use one primary button per view.</p>
        <section className="mbd-app-card" {...target("section.playground", "section", "Playground")}>
          <button type="button" className="mbd-button" data-preview-counter {...target("button[data-preview-counter]", "button", `Preview button · ${count}`)} disabled={!interactive} onClick={() => setCount(value => value + 1)}>Preview button · {count}</button>
          <button type="button" className="mbd-button is-ghost" {...target("button.ghost", "button", "Cancel")} disabled={!interactive}>Cancel</button>
          <label className="mbd-app-field" {...target("label.field", "label", "Project name")}><span>Project name</span><input readOnly value="omp-studio" tabIndex={interactive ? 0 : -1} /></label>
        </section>
      </main>
    </div>
  </div>;
  return <div className={`mbd-page${picking ? " is-picking" : ""}`}>{body}{hint ? <p className="mbd-hint">{hint}</p> : null}</div>;
}
