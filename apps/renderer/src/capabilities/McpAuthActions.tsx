import { useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { McpAuthResult } from "@omp-studio/studio-protocol";
import { hostErrorMessage, waitReceipt } from "../hostError";
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
}: {
  client: StudioClient;
  sessionId?: string | undefined;
  name: string;
  available: boolean;
  preview: boolean;
  zh: boolean;
}) {
  const [busy, setBusy] = useState<Action>();
  const [confirmUnauth, setConfirmUnauth] = useState(false);
  const [result, setResult] = useState<McpAuthResult>();
  const [error, setError] = useState("");
  const enabled = preview || (available && !!sessionId);
  const run = async (action: Action) => {
    if (busy) return;
    setConfirmUnauth(false);
    setBusy(action);
    setError("");
    setResult(undefined);
    try {
      if (preview) {
        // Demo: local only, never the Host.
        setResult({
          name,
          scope: "user",
          status: action === "reauth" ? "authorized" : action === "unauth" ? "removed" : "connected",
          message: zh ? "演示：未调用 Runtime。" : "Demo: the Runtime was not called.",
          ...(action === "reauth" ? { authUrl: "https://auth.example.com/authorize?client_id=demo" } : {}),
        });
        return;
      }
      // Re-authorization waits for the browser flow (Runtime timeout 5 minutes); no client-side deadline.
      const handle = await client.command(KIND[action], { sessionId: sessionId!, name });
      const receipt = await waitReceipt<{ result: McpAuthResult }>(client, handle.requestId, action === "reauth" ? null : undefined);
      setResult(receipt.result);
    } catch (cause) {
      setError(hostErrorMessage(cause, zh ? "MCP 授权操作失败" : "MCP authorization action failed"));
    } finally {
      setBusy(undefined);
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
        <button className="btn small outline" disabled={disabled} onClick={() => void run("reauth")} aria-label={(zh ? "重新授权 " : "Re-authorize ") + name}>
          {busy === "reauth" ? (zh ? "等待浏览器授权…" : "Waiting for browser…") : zh ? "重新授权" : "Re-authorize"}
        </button>
        <button className="btn small outline" disabled={disabled} onClick={() => setConfirmUnauth(true)} aria-label={(zh ? "登出 " : "Sign out ") + name}>
          {zh ? "登出" : "Sign out"}
        </button>
        <button className="btn small outline" disabled={disabled} onClick={() => void run("reconnect")} aria-label={(zh ? "重连 " : "Reconnect ") + name}>
          {busy === "reconnect" ? (zh ? "重连中…" : "Reconnecting…") : zh ? "重连" : "Reconnect"}
        </button>
      </div>
      {confirmUnauth ? (
        <div className="mcp-auth-confirm" role="dialog" aria-label={zh ? "确认登出 MCP" : "Confirm MCP sign-out"}>
          <span className="small">
            {zh
              ? `删除 “${name}” 已保存的 OAuth 凭据，并从其配置文件移除 auth 段。之后需要重新授权。`
              : `Delete the stored OAuth credential for “${name}” and remove the auth block from its config file. You will need to re-authorize.`}
          </span>
          <button className="btn small primary" onClick={() => void run("unauth")}>{zh ? "登出" : "Sign out"}</button>
          <button className="btn small" onClick={() => setConfirmUnauth(false)}>{zh ? "取消" : "Cancel"}</button>
        </div>
      ) : null}
      {busy === "reauth" ? (
        <p className="small muted">
          {zh
            ? "已在系统浏览器打开授权页面。若浏览器无法回调本机，可在弹出的输入框粘贴授权码或回调地址。"
            : "The authorization page opened in your browser. If the callback cannot reach this machine, paste the code or redirect URL when prompted."}
        </p>
      ) : null}
      {result ? (
        <p className="small mcp-auth-result" role="status">
          <span className={`chip xs ${result.status === "authorized" || result.status === "connected" || result.status === "removed" ? "green" : result.status === "cancelled" ? "gray" : "amber"}`}>
            {statusText(result.status)}
          </span>
          {result.scope ? <span className="chip gray xs">{result.scope === "project" ? (zh ? "项目配置" : "Project config") : zh ? "用户配置" : "User config"}</span> : null}
          {result.message ? <span>{result.message}</span> : null}
          {result.authUrl ? (
            <span className="mcp-auth-url">
              {zh ? "授权地址：" : "Authorization URL: "}
              <code>{result.authUrl}</code>
            </span>
          ) : null}
        </p>
      ) : null}
      {error ? <p role="alert" className="small">{error}</p> : null}
    </div>
  );
}
