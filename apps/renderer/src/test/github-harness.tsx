/** Manual browser QA entry. Not included in the production Rollup inputs. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GitHubReference, StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { GitWorkbench, type GitOpenIntent } from "../git/GitWorkbench";
import { GitQuickCard } from "../git/GitQuickCard";
import { GitWorkspaceProvider } from "../git/GitWorkspaceContext";
import { SessionWorktreesPane } from "../workspaces/SessionWorktreesPane";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import { githubReferenceSnapshot } from "../composer/githubReference";
import { gitCommitReferenceLabel } from "../composer/gitCommitReference";
import { emptySnapshot, type ComposerSnapshot } from "../composer/types";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/sidebar.css";
import "../styles/workbench.css";
import "../App.css";
import "../styles/typography.css";
import "../styles/tabs.css";

const unavailable = () => { throw new Error("Preview must not call the Host"); };
const client = { query: unavailable, command: unavailable } as unknown as StudioClient;

function Harness() {
  const [wide, setWide] = useState(false);
  const [dark, setDark] = useState(false);
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [snapshot, setSnapshot] = useState<ComposerSnapshot>(emptySnapshot);
  const [cardWidth, setCardWidth] = useState(320);
  const [collapsed, setCollapsed] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [intent, setIntent] = useState<GitOpenIntent>();
  const sequence = useRef(0);
  const composer = useRef<ChipComposerHandle>(null);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  const addReference = (reference: GitHubReference) => {
    const captured = githubReferenceSnapshot(reference);
    composer.current?.insertChip({ kind: "github", label: `${captured.kind === "pr" ? "PR" : "Issue"} #${captured.number} ${captured.title}`, reference: captured });
    composer.current?.focus();
  };
  return <I18nProvider forcedLanguage={language}><PreviewModeProvider>
    <main style={{ height: "100vh", overflow: "auto", padding: 16, background: "var(--bg)", color: "var(--text)" }}>
      <header style={{ display: "flex", justifyContent: "space-between", maxWidth: 1100, margin: "0 auto 12px", gap: 12 }}><strong>Git · 浏览器验收</strong><div style={{ display: "flex", gap: 8 }}>
        <button className="btn small outline" onClick={() => setWide(value => !value)}>{wide ? "紧凑 420px" : "展开 1000px"}</button>
        <button className="btn small outline" onClick={() => setCardWidth(value => value === 280 ? 320 : value === 320 ? 480 : 280)}>卡片 {cardWidth}px</button>
        <button className="btn small outline" onClick={() => setDark(value => !value)}>{dark ? "浅色" : "深色"}</button>
        <button className="btn small outline" onClick={() => setLanguage(value => value === "zh" ? "en" : "zh")}>{language === "zh" ? "English" : "中文"}</button>
      </div></header>
      <GitWorkspaceProvider client={client}>
        <div style={{ maxWidth: 1100, margin: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", gap: 16 }}>
          <section style={{ width: cardWidth, flexShrink: 0, maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)" }}>
            <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}><strong>Git</strong><button className="icon-btn small" aria-label="折叠快捷卡" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>⌄</button></header>
            {!collapsed ? <GitQuickCard client={client} workspaceName="omp-web" visible worktrees={<SessionWorktreesPane client={client} visible launcher launcherLabel="Worktree" />} onOpen={next => { setIntent({ ...next, key: ++sequence.current }); setSidebar(true); }} onReference={addReference} onCommitReference={reference => { composer.current?.insertChip({ kind: "git-commit", label: gitCommitReferenceLabel(reference), reference }); composer.current?.focus(); }} /> : null}
          </section>
          <div hidden={!sidebar} style={{ width: wide ? 760 : 420, maxWidth: "100%", height: "calc(100vh - 245px)", minHeight: 400, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "var(--bg)" }}>
            <GitWorkbench client={client} visible={sidebar} workspaceName="omp-studio" intent={intent} worktrees={<SessionWorktreesPane client={client} visible launcher launcherLabel="Worktree" />} onReference={addReference} />
          </div>
        </div>
      </GitWorkspaceProvider>
      <section style={{ maxWidth: 1000, margin: "14px auto 0", padding: 12, border: "1px solid var(--border)", borderRadius: 10 }}>
        <ChipComposer ref={composer} ariaLabel="引用测试输入框" placeholder="补充分析、处理或审查要求…" onChange={setSnapshot} />
        <p className="tiny muted" style={{ marginTop: 8 }}>引用 {snapshot.doc.nodes.filter(node => node.type === "chip").length} · 本页不发送消息</p>
      </section>
    </main>
  </PreviewModeProvider></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
