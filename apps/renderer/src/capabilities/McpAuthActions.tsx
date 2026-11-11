import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { McpAuthResult } from "@omp-studio/studio-protocol";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { usePreviewMode } from "../preview/PreviewContext";
import { Icon } from "../icons";
import "./mcpAuth.css";

type Action = "reauth" | "unauth" | "reconnect";
const KIND = { reauth: "mcp.auth.reauth", unauth: "mcp.auth.unauth", reconnect: "mcp.auth.reconnect" } as const;

/** Re-authorize / sign out / reconnect one live MCP server (upstream `/mcp reauth|unauth`, reconnect). */
export function McpAuthActions({
  client,
  sessionId,
  name,
  available,
  preview,
  zh,
  authSupported = true,
  previewScope = "user",
  onComplete,
}: {
  client: StudioClient;
  sessionId?: string | undefined;
  name: string;
  available: boolean;
  preview: boolean;
  zh: boolean;
  authSupported?: boolean;
  previewScope?: "user" | "project";
  onComplete?: (result: McpAuthResult) => void;
}) {
  const { marks } = usePreviewMode();
  const [busy, setBusy] = useState<Action>();
  const [confirmUnauth, setConfirmUnauth] = useState(false);
  const [result, setResult] = useState<McpAuthResult>();
  const [error, setError] = useState("");
  const generation = useRef(0);
  const signOutButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    generation.current++;
    setBusy(undefined);
    setResult(undefined);
    setError("");
    setConfirmUnauth(false);
    return () => { generation.current++; };
  }, [client, sessionId, name, preview]);
  const enabled = preview || (available && !!sessionId);
  const run = async (action: Action) => {
    if (busy) return;
    const epoch = generation.current;
    setConfirmUnauth(false);
    setBusy(action);
    setError("");
    setResult(undefined);
    try {
      if (preview) {
        // Demo: local only, never the Host.
        const value: McpAuthResult = {
          name,
          scope: previewScope,
          status: action === "reauth" ? "authorized" : action === "unauth" ? "removed" : "connected",
          ...(marks ? { message: zh ? "演示：未调用 Runtime。" : "Demo: the Runtime was not called." } : {}),
        };
        setResult(value);
        onComplete?.(value);
        return;
      }
      // Re-authorization waits for the browser flow (Runtime timeout 5 minutes); no client-side deadline.
      const handle = await client.command(KIND[action], { sessionId: sessionId!, name });
      const receipt = await waitReceipt<{ result: McpAuthResult }>(client, handle.requestId, action === "reauth" ? null : undefined);
      if (epoch === generation.current) { setResult(receipt.result); onComplete?.(receipt.result); }
    } catch (cause) {
      if (epoch === generation.current) setError(hostErrorMessage(cause, zh ? "MCP 授权操作失败" : "MCP authorization action failed"));
    } finally {
      if (epoch === generation.current) setBusy(undefined);
    }
  };
  const statusText = (status: McpAuthResult["status"]) =>
    zh
      ? { authorized: "已授权", cancelled: "已取消", refused: "无法授权", removed: "已登出", connected: "已重连", failed: "失败" }[status]
      : { authorized: "Authorized", cancelled: "Cancelled", refused: "Refused", removed: "Signed out", connected: "Reconnected", failed: "Failed" }[status];
  const disabled = !enabled || busy !== undefined;
  return (
    <div className="mcp-auth-actions">
      <div className="mcp-auth-buttons">
        {authSupported ? <><button type="button" className="mcp-auth-secondary" disabled={disabled} onClick={() => void run("reauth")} aria-label={(zh ? "重新授权 " : "Re-authorize ") + name}>
          <Icon name="lock" extra="xs" />{busy === "reauth" ? (zh ? "授权中…" : "Authorizing…") : zh ? "重新授权" : "Re-authorize"}
        </button>
        <button type="button" ref={signOutButton} className="mcp-auth-secondary" disabled={disabled} onClick={() => setConfirmUnauth(true)} aria-label={(zh ? "登出 " : "Sign out ") + name}>
          {zh ? "登出" : "Sign out"}
        </button></> : null}
        <button type="button" className="btn small outline mcp-auth-reconnect" disabled={disabled} onClick={() => void run("reconnect")} aria-label={(zh ? "重连 " : "Reconnect ") + name}>
          <Icon name="refresh" extra="xs" />
          {busy === "reconnect" ? (zh ? "重连中…" : "Reconnecting…") : zh ? "重连" : "Reconnect"}
        </button>
      </div>
      {confirmUnauth || busy === "reauth" || result || error ? <div className="mcp-auth-feedback">
      {confirmUnauth ? (
        <div className="mcp-auth-confirm" role="dialog" aria-label={zh ? "确认登出 MCP" : "Confirm MCP sign-out"}>
          <Icon name="lock" extra="xs" /><div>
          <strong>{zh ? `登出 ${name}？` : `Sign out of ${name}?`}</strong><p>
            {zh
              ? `删除 “${name}” 已保存的 OAuth 凭据，并从其配置文件移除 auth 段。之后需要重新授权。`
              : `Delete the stored OAuth credential for “${name}” and remove the auth block from its config file. You will need to re-authorize.`}
          </p></div>
          <button type="button" autoFocus className="btn small outline" onClick={() => { setConfirmUnauth(false); signOutButton.current?.focus(); }}>{zh ? "取消" : "Cancel"}</button>
          <button type="button" className="btn small danger" onClick={() => void run("unauth")}>{zh ? "确认登出" : "Confirm sign-out"}</button>
        </div>
      ) : null}
      {busy === "reauth" ? (
        <p className="mcp-auth-wait" role="status"><Icon name="external" extra="xs" /><span>
          {zh
            ? "已在系统浏览器打开授权页面。若浏览器无法回调本机，可在弹出的输入框粘贴授权码或回调地址。"
            : "The authorization page opened in your browser. If the callback cannot reach this machine, paste the code or redirect URL when prompted."}
        </span></p>
      ) : null}
      {result ? (
        <div className="mcp-auth-result" role="status">
          <span className={`mcp-auth-status ${result.status === "authorized" || result.status === "connected" || result.status === "removed" ? "success" : result.status === "cancelled" ? "neutral" : "warning"}`}>
            <Icon name={result.status === "authorized" || result.status === "connected" || result.status === "removed" ? "check" : "alert-c"} extra="xs" />{statusText(result.status)}
          </span>
          {result.scope ? <span className="mcp-auth-result-scope">{result.scope === "project" ? (zh ? "项目配置" : "Project config") : zh ? "用户配置" : "User config"}</span> : null}
          {result.message ? <span>{result.message}</span> : null}
          {result.authUrl ? (
            <span className="mcp-auth-url">
              {zh ? "授权地址：" : "Authorization URL: "}
              <code>{result.authUrl}</code>
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="mcp-auth-error"><Icon name="alert-c" extra="xs" /><span>{error}</span></p> : null}
      </div> : null}
    </div>
  );
}
