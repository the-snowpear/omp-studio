import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TerminalCommand } from "../../../desktop/src/terminal-shared";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useTerminalStore } from "../terminalSessions";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";
import { useDockEngine } from "../dock/DockContext";
import "./commandBlock.css";

export function commandShell(language: string): TerminalCommand["shell"] | undefined {
  switch (language.toLowerCase()) {
    case "bash": return "bash";
    case "sh": return "sh";
    case "zsh": return "zsh";
    case "pwsh": case "powershell": case "ps1": return "powershell";
    default: return undefined;
  }
}

type CommandExecution = { run(command: TerminalCommand): Promise<void>; unavailable?: string | undefined };
export const CommandExecutionContext = createContext<CommandExecution | undefined>(undefined);

export function CommandBlockProvider({ workspaceId, sessionId, conversationId, children }: {
  workspaceId: string | undefined; sessionId: string | undefined; conversationId: string | undefined; children: ReactNode;
}) {
  const store = useTerminalStore(), target = useExecutionTarget(), dock = useDockEngine();
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const remote = target.inventory.statuses.find(status => status.id === target.id);
  const unavailable = !store.api ? zh ? "仅桌面端支持执行命令" : "Run commands in the desktop app"
    : !workspaceId ? zh ? "请先打开工作区" : "Open a workspace first"
    : target.id && (remote?.state !== "connected" || remote.operation) ? zh ? "请先连接 SSH 工作区" : "Connect the SSH workspace first" : undefined;
  const value = useMemo<CommandExecution>(() => ({ unavailable, run: async command => {
    await store.create(target.id, workspaceId, sessionId, conversationId, command);
    dock.store.dispatch({ type: "open", panel: "terminal" });
  } }), [store, target.id, workspaceId, sessionId, conversationId, dock.store, unavailable]);
  return <CommandExecutionContext.Provider value={value}>{children}</CommandExecutionContext.Provider>;
}

export function CommandBlock({ language, text, children, streaming }: {
  language: string; text: string; children: ReactNode; streaming: boolean;
}) {
  const execution = useContext(CommandExecutionContext), { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [copied, setCopied] = useState(false), [starting, setStarting] = useState(false), [notice, setNotice] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), launching = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setNotice(""); setCopied(false); }, [text, language]);
  const reason = streaming ? zh ? "等待命令块输出完成" : "Waiting for the command block"
    : !text.trim() ? zh ? "命令为空" : "Empty command"
    : preview ? undefined : execution?.unavailable ?? (!execution ? zh ? "请在对话中执行命令" : "Run commands from a conversation" : undefined);
  const runLabel = starting ? zh ? "正在启动…" : "Starting…" : zh ? "在终端执行" : "Run in terminal";
  const copyLabel = copied ? zh ? "已复制" : "Copied" : zh ? "复制命令" : "Copy command";
  async function run() {
    if (launching.current || reason) return;
    if (preview) { if (marks) setNotice(zh ? "演示：命令将在底部终端执行" : "Demo: commands run in the terminal below"); return; }
    launching.current = true; setStarting(true); setNotice("");
    try { await execution!.run({ shell: commandShell(language)!, text }); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { launching.current = false; setStarting(false); }
  }
  return <div className="md-code md-command" data-shell={language}>
    <span className="sr-only md-code-lang">{language}</span>
    <div className="md-command-actions">
      {preview && marks ? <span className="md-command-demo">{zh ? "演示" : "Demo"}</span> : null}
      <button type="button" className="md-command-run" aria-label={runLabel} data-tip={reason ?? runLabel} disabled={starting || !!reason} onClick={() => void run()}>
        {starting ? <span className="spinner" /> : <Icon name="play" />}
      </button>
      <button type="button" className="md-code-copy" aria-label={copyLabel} data-tip={copyLabel} disabled={streaming} onClick={() => {
        void navigator.clipboard.writeText(text).then(() => { setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500); }).catch(error => setNotice(String(error)));
      }}><Icon name={copied ? "check" : "copy"} /></button>
    </div>
    <pre className="codeblock md-code-pre">{children}</pre>
    {notice ? <div className="md-command-notice" role="status">{notice}</div> : null}
  </div>;
}
