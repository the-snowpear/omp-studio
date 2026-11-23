import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { StudioClientImpl } from "@omp-studio/client";
import {
  BrowserWebClientTransport,
  type WebSocketLike,
} from "@omp-studio/transport-web/browser";
import { I18nProvider, useI18n } from "../i18n";
import { App } from "../App";
import { ErrorBoundary } from "../ErrorBoundary";
import { installBrowserServices } from "./services";
import "./web.css";

globalThis.OMP_STUDIO_WEB_ENTRY = true;
document.documentElement.dataset.webWorkbench = "true";
const ready = import("../main");

function WebEntry() {
  const { resolvedLanguage, setLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [client, setClient] = useState<StudioClientImpl>();
  const services = useRef<
    Awaited<ReturnType<typeof installBrowserServices>> | undefined
  >(undefined);
  const [servicesDisconnected, setServicesDisconnected] = useState(false);
  const [sessionLost, setSessionLost] = useState(false);
  const [transport] = useState(
    () =>
      new BrowserWebClientTransport({
        baseUrl: location.origin,
        webSocketFactory: (url) =>
          new WebSocket(url) as unknown as WebSocketLike,
        headers: () => ({
          "X-Studio-Control": globalThis.ompWebControlVersion ?? "",
        }),
        mobile: { onDisconnect: () => setDisconnected(true) },
        onRecovered: () => setDisconnected(false),
        onSessionLost: () => setSessionLost(true),
      }),
  );
  const [code, setCode] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("pair") ?? "",
  );
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [disconnected, setDisconnected] = useState(false);

  async function connect(pair = false) {
    setBusy(true);
    setError("");
    try {
      if (pair)
        await transport.pair(code.trim(), name.trim() || navigator.platform);
      await transport.restoreSession();
      history.replaceState(null, "", location.pathname);
      services.current?.dispose();
      services.current = await installBrowserServices(transport, (connected) =>
        setServicesDisconnected(!connected),
      );
      const next = new StudioClientImpl(transport);
      await next.bootstrap();
      setClient(next);
      setDisconnected(false);
    } catch (cause) {
      if (pair || client)
        setError(
          zh
            ? "连接失败。请检查配对码和主机状态后重试。"
            : "Connection failed. Check the pairing code and Host, then try again.",
        );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void connect();
  }, []);
  if (client)
    return (
      <>
        <App client={client} />
        {(disconnected || servicesDisconnected || sessionLost) && (
          <div className="web-reconnect" role="alert">
            <span>
              {sessionLost
                ? zh
                  ? "此设备的授权已结束，请重新配对。"
                  : "This device's authorization has ended. Pair again to reconnect."
                : zh
                  ? "连接已断开，正在恢复连接。草稿保留在此设备。"
                  : "Disconnected. Restoring the connection. Your drafts are kept on this device."}
            </span>
            <button
              onClick={() => {
                if (sessionLost) location.reload();
                else {
                  transport.reconnect();
                  services.current?.reconnect();
                }
              }}
            >
              {sessionLost
                ? zh
                  ? "重新配对"
                  : "Pair again"
                : zh
                  ? "重新连接"
                  : "Reconnect"}
            </button>
          </div>
        )}
      </>
    );
  return (
    <main className="web-pair">
      <header>
        <strong>OMP Studio</strong>
        <button
          className="web-language"
          onClick={() => setLanguage(zh ? "en" : "zh")}
        >
          {zh ? "English" : "中文"}
        </button>
      </header>
      <section className="web-pair-body">
        <div className="web-pair-intro">
          <span className="web-host-address">{location.host}</span>
          <h1>{zh ? "连接你的工作台" : "Connect to your workbench"}</h1>
          <p>
            {zh
              ? "从另一台设备继续项目、对话和终端。"
              : "Continue your projects, conversations and terminals from another device."}
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect(true);
          }}
        >
          <label>
            {zh ? "设备名称" : "Device name"}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={zh ? "例如，我的笔记本" : "e.g. My laptop"}
              autoComplete="off"
            />
          </label>
          <label>
            {zh ? "配对码" : "Pairing code"}
            <input
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              spellCheck={false}
              required
            />
          </label>
          <p className="web-permission">
            {zh
              ? "此设备可以查看你的项目。接管后，可以修改文件、使用模型并以主机账户运行终端命令。"
              : "This device can view your projects. After taking control, it can edit files, use models and run terminal commands as the Host account."}
          </p>
          {error && <p role="alert">{error}</p>}
          <button
            className="web-primary"
            type="submit"
            disabled={busy || !code.trim()}
          >
            {busy
              ? zh
                ? "正在连接…"
                : "Connecting…"
              : zh
                ? "配对并连接"
                : "Pair and connect"}
          </button>
          <p className="web-help">
            {zh
              ? "在桌面「Web 访问」生成配对码，或在主机执行 omp-studio-web pair。"
              : "Generate a code in desktop Web access, or run omp-studio-web pair on the Host."}
          </p>
        </form>
      </section>
    </main>
  );
}
void ready.then(() =>
  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>
      <I18nProvider>
        <WebEntry />
      </I18nProvider>
    </ErrorBoundary>,
  ),
);
