import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import type { WebStatus } from "../../../desktop/src/web/shared";
import { webAccessPreview } from "../preview/webAccessPreview";
import { updateControlState } from "./controlState";
import { useWebAccessUi } from "./WebAccessContext";
import { WebControlBar } from "./WebControlBar";
import "./web.css";

export function WebAccess() {
  const api = globalThis.ompStudioWebAccess;
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview, marks } = usePreviewMode();
  const [state, setState] = useState<WebStatus>();
  const { open, setOpen, visible } = useWebAccessUi();
  const [pair, setPair] = useState<{
    url: string;
    expiresAt: number;
    qr: string;
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewRemoved, setPreviewRemoved] = useState<string[]>([]);
  const [previewNames, setPreviewNames] = useState<Record<string, string>>({});
  const [previewControl, setPreviewControl] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  const refresh = () => api?.status().then(setState);
  useEffect(() => {
    if (!api) return;
    void refresh()?.catch(() => {});
    return api.onControl((control) =>
      setState((current) => (current ? { ...current, control } : current)),
    );
  }, [api]);
  useEffect(() => {
    if (open) void refresh()?.catch(() => {});
  }, [open]);
  useEffect(() => {
    if (state) updateControlState(state.control, state.deviceId);
  }, [state]);
  if (!api && !preview) return null;
  const fixture = webAccessPreview(zh);
  const model = preview
    ? {
        ...fixture,
        devices: fixture.devices
          .filter((device) => !previewRemoved.includes(device.id))
          .map((device) => ({
            ...device,
            name: previewNames[device.id] ?? device.name,
          })),
      }
    : state;
  const controlling = preview
    ? previewControl
    : state?.deviceId !== undefined && model?.control.owner?.id === state.deviceId;
  const controlLabel = controlling
    ? zh ? "此设备正在控制" : "You have control"
    : model?.control.owner
      ? zh ? `${model.control.owner.name} 正在控制` : `${model.control.owner.name} has control`
      : zh ? "可接管工作台" : "Workbench available";
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await action();
      if (!preview) await refresh();
    } catch (cause) {
      setError(
        zh
          ? "操作未完成，请检查主机连接后重试。"
          : "The action did not complete. Check the Host connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {visible && <WebControlBar>
        <span className={`web-control-dot ${controlling ? "is-owner" : ""}`} />
        <span className="web-control-label" title={controlLabel}>{controlLabel}</span>
        {preview && marks && <span>{zh ? "演示" : "Demo"}</span>}
        {!controlling && (
          <button
            onClick={() => {
              void run(() =>
                preview
                  ? Promise.resolve(setPreviewControl(true))
                  : api!.takeControl(),
              );
            }}
            disabled={busy}
          >
            {zh ? "接管" : "Take control"}
          </button>
        )}
        <button
          className="web-manage"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {zh ? "Web 访问" : "Web access"}
        </button>
        {model?.control.authorizationUrl && (
          <a
            href={model.control.authorizationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {zh ? "完成登录" : "Complete sign-in"}
          </a>
        )}
      </WebControlBar>}
      {open && (
        <div className="web-dialog-backdrop" onClick={() => setOpen(false)}>
          <section
            className="web-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="web-access-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h2 id="web-access-title">
                {zh ? "连接你的设备" : "Connect your devices"}
              </h2>
              <button
                onClick={() => setOpen(false)}
                aria-label={zh ? "关闭" : "Close"}
              >
                ×
              </button>
            </header>
            <p className="web-help">
              {zh
                ? "已配对设备共享项目与会话。每次由一个设备控制写入和终端。"
                : "Paired devices share projects and conversations. One device controls changes and terminal input at a time."}
            </p>
            <div className="web-dialog-control">
              <span className={`web-control-dot ${controlling ? "is-owner" : ""}`} />
              <span>{controlLabel}</span>
              {!controlling && <button disabled={busy} onClick={() => {
                void run(() => preview ? Promise.resolve(setPreviewControl(true)) : api!.takeControl());
              }}>{zh ? "接管" : "Take control"}</button>}
              {model?.control.authorizationUrl && <a href={model.control.authorizationUrl} target="_blank" rel="noopener noreferrer">{zh ? "完成登录" : "Complete sign-in"}</a>}
            </div>
            {!globalThis.OMP_STUDIO_WEB_ENTRY && (
              <>
                <div className="web-address-row">
                  <span>{zh ? "本机" : "Local"}</span>
                  <a href={model?.origin} target="_blank" rel="noreferrer">
                    {model?.origin}
                  </a>
                </div>
                <div className="web-address-row">
                  <span>{zh ? "局域网" : "Local network"}</span>
                  <span>
                    {model?.lanOrigin ??
                      (zh
                        ? "选择地址以开启 HTTPS"
                        : "Select an address to enable HTTPS")}
                  </span>
                </div>
                <div className="web-address-buttons">
                  {model?.addresses.map((ip) => (
                    <button
                      key={ip}
                      disabled={busy}
                      onClick={() => {
                        void run(() =>
                          preview ? Promise.resolve() : api!.listen(ip),
                        );
                      }}
                    >
                      {ip}
                    </button>
                  ))}
                  {model?.lanOrigin && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        void run(() =>
                          preview ? Promise.resolve() : api!.listen(),
                        );
                      }}
                    >
                      {zh ? "关闭局域网" : "Disable LAN"}
                    </button>
                  )}
                </div>
                {model?.fingerprint && (
                  <>
                    <p className="web-help">
                      {zh
                        ? "在另一台设备上信任 CA 证书，并核对指纹。"
                        : "Trust the CA certificate on the other device and verify its fingerprint."}
                    </p>
                    <code className="web-fingerprint">{model.fingerprint}</code>
                    <button
                      onClick={() => {
                        void run(() =>
                          preview
                            ? Promise.resolve()
                            : api!.exportCertificate(),
                        );
                      }}
                    >
                      {zh ? "导出 CA 证书" : "Export CA certificate"}
                    </button>
                  </>
                )}
                <button
                  className="web-primary"
                  disabled={busy}
                  onClick={() => {
                    void run(async () => {
                      if (!preview) setPair(await api!.pair());
                    });
                  }}
                >
                  {zh ? "生成一次性配对码" : "Generate a pairing code"}
                </button>
                {pair && (
                  <div className="web-pair-code">
                    <img
                      src={pair.qr}
                      alt={zh ? "配对二维码" : "Pairing QR code"}
                    />
                    <div>
                      <p>
                        {zh
                          ? "请在 60 秒内打开链接或扫码"
                          : "Open this link or scan within 60 seconds"}
                      </p>
                      <a href={pair.url} target="_blank" rel="noreferrer">
                        {pair.url}
                      </a>
                    </div>
                  </div>
                )}
              </>
            )}
            <h3>{zh ? "已授权设备" : "Authorized devices"}</h3>
            <div className="web-devices">
              {model?.devices.length ? (
                model.devices.map((device) => (
                  <div key={device.id} className="web-device-row">
                    <input
                      aria-label={zh ? "设备名称" : "Device name"}
                      defaultValue={device.name}
                      onBlur={(event) => {
                        const name = event.target.value.trim();
                        if (name && name !== device.name)
                          void run(() =>
                            preview
                              ? Promise.resolve(
                                  setPreviewNames((previous) => ({
                                    ...previous,
                                    [device.id]: name,
                                  })),
                                )
                              : api!.rename(device.id, name),
                          );
                      }}
                    />
                    <time>
                      {new Date(device.lastSeenAt).toLocaleDateString(
                        resolvedLanguage,
                      )}
                    </time>
                    <button
                      disabled={busy}
                      onClick={() => {
                        void run(() =>
                          preview
                            ? Promise.resolve(
                                setPreviewRemoved((previous) => [
                                  ...previous,
                                  device.id,
                                ]),
                              )
                            : api!.revoke(device.id),
                        );
                      }}
                    >
                      {zh ? "撤销" : "Revoke"}
                    </button>
                  </div>
                ))
              ) : (
                <p className="web-help">
                  {zh ? "尚未配对浏览器" : "No browsers paired yet"}
                </p>
              )}
            </div>
            {error && <p role="alert">{error}</p>}
          </section>
        </div>
      )}
    </>
  );
}
