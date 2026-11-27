/** Controlled UI acceptance only. No install command reaches a user's browser profile. */
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { StudioClient } from "@omp-studio/client-contract";
import { ChromeRelayHostPane } from "../browser/ChromeRelayHostPane";
import { ChipComposer, type ChipComposerHandle } from "../composer/ChipComposer";
import { emptySnapshot, type ComposerSnapshot, type PromptImage } from "../composer/types";
import { ArchiveActivityPane, ArchiveTranscriptInspector } from "../history/ArchiveExplorer";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider, PreviewSurface } from "../preview/PreviewContext";
import { getPreviewChromeRelay } from "../preview/chromeRelayPreview";
import { previewArchiveActivity, previewArchiveTranscript } from "../preview/archivePreview";
import { SettingsBackendsHarness } from "./SettingsBackendsHarness";
import { SessionFeaturesHarness } from "./SessionFeaturesHarness";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/workbench.css";
import "../styles/typography.css";
import "../styles/tabs.css";
import "../styles/pages.css";
import "../App.css";
import "../browser/managedBrowser.css";
import "../history/archive.css";

function sampleImage(): PromptImage {
  const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 600;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f5f4f8"; context.fillRect(0, 0, 960, 600);
  context.fillStyle = "#ffffff"; context.fillRect(64, 56, 832, 488);
  context.fillStyle = "#6e56cf"; context.fillRect(64, 56, 8, 488);
  context.fillStyle = "#24232d"; context.font = "bold 32px Arial"; context.fillText("Queue attachment review", 108, 120);
  context.font = "18px Arial"; context.fillStyle = "#737080"; context.fillText("Review the draft before sending", 108, 158);
  ["Draft preserved", "Image identity stable", "Ready for review"].forEach((label, index) => {
    const y = 228 + index * 88; context.fillStyle = "#eeecf6"; context.fillRect(108, y - 28, 660, 58);
    context.fillStyle = "#6e56cf"; context.beginPath(); context.arc(132, y, 6, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#3e3b4a"; context.fillText(label, 155, y + 6);
  });
  return { type: "image", mimeType: "image/png", data: canvas.toDataURL("image/png").split(",")[1]! };
}

function Harness() {
  const params = new URLSearchParams(location.search);
  const [language, setLanguage] = useState<"zh" | "en">(params.get("lang") === "en" ? "en" : "zh");
  const [preview, setPreview] = useState(params.get("source") !== "controlled");
  const [dark, setDark] = useState(params.get("theme") === "dark");
  const [tab, setTab] = useState("chrome");
  const [width, setWidth] = useState(760);
  const [reads, setReads] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<ComposerSnapshot>(emptySnapshot);
  const [composerDisabled, setComposerDisabled] = useState(false);
  const composer = useRef<ChipComposerHandle>(null);
  const image = useMemo(sampleImage, []);
  const zh = language === "zh";
  const languageRef = useRef(language); languageRef.current = language;
  const client = useMemo(() => ({
    query: async (kind: string, input: Record<string, unknown>) => {
      setReads(previous => [...previous.slice(-5), `${kind} ${JSON.stringify(input)}`]);
      const chinese = languageRef.current === "zh";
      if (kind === "browser.relayHost.status") {
        const result = getPreviewChromeRelay(chinese);
        result.profiles[0]!.profile = "Controlled profile";
        result.policy.blocked = true;
        result.policy.nativeHostBlocked = true;
        result.policy.denials = [{ browser: "Google Chrome", policy: "NativeMessagingBlocklist", scope: "machine", source: "HKLM\\Software\\Policies\\Google\\Chrome", value: ["sh.omp.browser"], reason: chinese ? "受控读取：企业策略拒绝 sh.omp.browser Native Host。" : "Controlled read: enterprise policy blocks the sh.omp.browser native host." }];
        return result;
      }
      if (kind === "archive.transcript.read") return previewArchiveTranscript(String(input.targetSessionId), chinese);
      const view = kind === "archive.calls.list" ? "calls" : kind === "archive.messages.grep" ? "grep" : "stats";
      return { rows: previewArchiveActivity(view, chinese), truncated: false };
    },
    command: async () => { throw new Error("Read-only acceptance harness; installation commands are disabled."); },
  }) as unknown as StudioClient, []);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => {
    composer.current?.setSnapshot({ text: "Review [图1] before sending.", images: [image], doc: { nodes: [
      { type: "text", value: "Review " }, { type: "chip", chip: { id: "upgrade-image-1", kind: "image", label: "图1", image } }, { type: "text", value: " before sending." },
    ] } });
  }, [image]);
  const attachment = snapshot.doc.nodes.find(node => node.type === "chip" && node.chip.kind === "image");
  return <I18nProvider forcedLanguage={language}><PreviewModeProvider switchEnabled><PreviewSurface preview={preview}>
    <header style={{ position: "fixed", inset: "0 0 auto 0", zIndex: 2147483647, height: 48, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", background: "var(--surface)", borderBottom: "1px solid var(--border)", color: "var(--text)" }}>
      <strong style={{ marginRight: 12 }}>19.2.1 · Acceptance</strong>
      <button className="btn small outline" onClick={() => setLanguage(value => value === "zh" ? "en" : "zh")}>{zh ? "English" : "中文"}</button>
      <button className="btn small outline" onClick={() => setDark(value => !value)}>{zh ? "深浅主题" : "Theme"}</button>
      <button className="btn small outline" onClick={() => setPreview(value => !value)}>{preview ? "Preview data" : "Controlled reads"}</button>
      <button className="btn small outline" aria-pressed={composerDisabled} onClick={() => setComposerDisabled(value => !value)}>{composerDisabled ? zh ? "恢复输入框" : "Enable composer" : zh ? "禁用输入框" : "Disable composer"}</button>
      {[760, 380].map(value => <button key={value} className={`btn small ${width === value ? "primary" : "outline"}`} onClick={() => setWidth(value)}>{value}px</button>)}
    </header>
    <main style={{ padding: "72px 24px 24px", height: "100vh", overflow: "auto", background: "var(--bg)", color: "var(--text)" }}>
      <nav style={{ display: "flex", gap: 8, marginBottom: 18 }} aria-label="Acceptance surface">{[["chrome", "Chrome 扩展", "Chrome extension"], ["composer", "Composer 批注", "Composer annotation"], ["archive", "历史与归档", "History and archive"], ["settings", "设置与后端", "Settings and backends"], ["sessions", "会话与后台", "Sessions and jobs"]].map(([value, chinese, english]) => <button key={value} className={`btn small ${tab === value ? "primary" : "outline"}`} onClick={() => setTab(value!)}>{zh ? chinese : english}</button>)}</nav>
      <div hidden={tab !== "chrome"} style={{ position: "relative", width, maxWidth: "100%", height: "calc(100vh - 145px)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}><ChromeRelayHostPane client={client} sessionId="acceptance" visible={tab === "chrome"} onBack={() => setTab("composer")} /></div>
      <section hidden={tab !== "composer"} style={{ width, maxWidth: "100%" }}><h2>{zh ? "图片批注与草稿保留" : "Image annotation and draft retention"}</h2><p className="muted">{zh ? "从附件缩略图打开批注，合成后核对下方身份与字节状态。" : "Open annotation from the attachment thumbnail, then inspect identity and byte changes below."}</p><div className="composer-region" style={{ padding: 18, border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)" }}><ChipComposer ref={composer} disabled={composerDisabled} ariaLabel={zh ? "验收草稿" : "Acceptance draft"} onChange={setSnapshot} /></div><pre data-testid="attachment-state" style={{ whiteSpace: "pre-wrap", marginTop: 16 }}>{JSON.stringify({ id: attachment?.type === "chip" ? attachment.chip.id : null, text: snapshot.text, imageCount: snapshot.images.length, bytesChanged: snapshot.images[0]?.data !== image.data, bytes: snapshot.images[0]?.data.length }, null, 2)}</pre></section>
      <section hidden={tab !== "archive"} style={{ width, maxWidth: "100%" }}><ArchiveTranscriptInspector client={client} sessionId="acceptance" targetSessionId="sess-7c2e91" /><ArchiveActivityPane client={client} sessionId="acceptance" scope="workspace" active={tab === "archive"} available /></section>
      <section hidden={tab !== "settings"}><SettingsBackendsHarness visible={tab === "settings"} /></section>
      <section hidden={tab !== "sessions"}><SessionFeaturesHarness visible={tab === "sessions"} /></section>
      {!preview ? <details style={{ marginTop: 20, maxWidth: 900 }}><summary>{zh ? "受控查询记录（无用户数据）" : "Controlled query log (no user data)"}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11 }}>{reads.join("\n")}</pre></details> : null}
    </main>
  </PreviewSurface></PreviewModeProvider></I18nProvider>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
