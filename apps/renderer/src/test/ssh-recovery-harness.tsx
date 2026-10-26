// Isolated QA entry, excluded from the packaged Vite inputs. Never connects to SSH.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { StudioClientImpl } from "@omp-studio/client";
import type { ClientTransport } from "@omp-studio/client-contract";
import { createContractFixtureApi } from "@omp-studio/testkit";
import type { RemoteApi, RemoteConnectionStatus, RemoteInventory } from "../../../desktop/src/remote/shared";
import { ExecutionTargets, useExecutionTarget } from "../workspaces/ExecutionTargets";
import { ExecutionTargetPicker } from "../workspaces/ExecutionTargetPicker";
import { RemoteScopeNotice } from "../workspaces/RemoteScopeNotice";
import { PreviewModeProvider } from "../preview/PreviewContext";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../App.css";
import "../workspaces/ssh.css";

const fixture = createContractFixtureApi() as unknown as ClientTransport;
const local = new StudioClientImpl(fixture);
const listeners = new Set<() => void>();
let generation = 1;
let failSync = false;
let inventory: RemoteInventory = { activeId: "qa", profiles: [{ id: "qa", name: "Ubuntu 开发服务器（隔离演示）", host: "example.invalid", platform: "linux" }], statuses: [{ id: "qa", state: "connected", generation }] };
function setStatus(state: RemoteConnectionStatus["state"]) {
  if (state === "connected") generation++;
  inventory = { ...inventory, statuses: [{ id: "qa", state, generation, ...(state === "recovering" ? { message: "网络连接中断，正在等待重新附加原 Host；命令不会自动重发" } : state === "degraded" ? { message: "远端响应迟缓，暂停新的写操作并检查通道；不重启 Host" } : {}), ...(state === "recovering" ? { attempt: 2, maxAttempts: 5, retryAt: Date.now() + 4_000 } : {}) }] };
  for (const listener of listeners) listener();
}
const unavailable = async () => { throw new Error("隔离演示不执行实际操作"); };
globalThis.ompStudioRemote = {
  list: async () => inventory,
  onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  onEvent: () => () => {},
  bootstrap: async () => { if (failSync) throw new Error("演示：快照暂不可用"); return fixture.bootstrap(); },
  query: (_id, request) => fixture.query(request), command: unavailable, save: unavailable, remove: unavailable, register: unavailable, directories: unavailable, installRuntime: unavailable,
  connect: async () => { failSync = false; setStatus("connected"); },
  disconnect: async () => setStatus("disconnected"), select: async id => { inventory = { ...inventory, activeId: id }; },
} satisfies RemoteApi;
localStorage.setItem("omp.previewMode", "0");
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
function Surface() {
  const [draft, setDraft] = useState("");
  const target = useExecutionTarget();
  return <main style={{ padding: 24, maxWidth: 840, margin: "auto" }}>
    <h1>SSH 连接恢复 · 隔离演示</h1><p>仅模拟主进程状态。不连接服务器、不接收真实密码、不发送命令。</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, margin: "24px 0" }}>
      <button className="btn outline" onClick={() => setStatus("degraded")}>响应迟缓</button>
      <button className="btn outline" onClick={() => setStatus("recovering")}>模拟断线</button>
      <button className="btn outline" onClick={() => { failSync = false; setStatus("connected"); }}>恢复通道</button>
      <button className="btn outline" onClick={() => { failSync = true; setStatus("connected"); }}>同步失败</button>
      <button className="btn outline" onClick={() => { failSync = false; }}>解除同步故障</button>
    </div>
    <ExecutionTargetPicker />
    <label style={{ display: "grid", gap: 8, marginTop: 24 }}>未保存的编辑<textarea aria-label="未保存的编辑" value={draft} onChange={event => setDraft(event.target.value)} style={{ minHeight: 120, width: "100%", background: "var(--surface)", color: "var(--text)", padding: 12, border: "1px solid var(--border)" }} /></label>
    <p>当前：{target.inventory.statuses[0]?.state} · 同步版本 {target.syncRevision}</p>
    <RemoteScopeNotice />
  </main>;
}
const mounted = createRoot(document.getElementById("root")!);
mounted.render(<ExecutionTargets client={local}>{(_client, key) => <PreviewModeProvider switchEnabled><Surface key={key} /></PreviewModeProvider>}</ExecutionTargets>);
import.meta.hot?.dispose(() => { mounted.unmount(); listeners.clear(); globalThis.ompStudioRemote = undefined; void local.close(); });
