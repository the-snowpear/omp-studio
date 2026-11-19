import { useEffect, useRef, useState, type ReactNode } from "react";
import type { WorkspaceId } from "@omp-studio/client-contract";
import type { MobileAccessStatus } from "@omp-studio/transport-desktop";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_MOBILE_ACCESS } from "../preview/fixtures";
import { SettingSection } from "./SettingRow";
import "./mobileAccess.css";

type Pairing = { qr?: string; expiresAt: number };
type Step = 0 | 1 | 2 | 3;

const TRUST_KEY = "omp.mobileAccess.trustedFingerprint";
const PAIRING_MS = 60_000;

function readTrusted(): string | undefined {
  try { return localStorage.getItem(TRUST_KEY) ?? undefined; } catch { return undefined; }
}
function writeTrusted(fingerprint: string): void {
  try { localStorage.setItem(TRUST_KEY, fingerprint); } catch { /* the step just shows again next time */ }
}
/** `AB:CD:EF:…` (Node's fingerprint256) → groups of four hex digits, easier to compare by eye. */
function fingerprintGroups(fingerprint: string): string[] {
  return fingerprint.replace(/[^0-9a-f]/gi, "").toUpperCase().match(/.{1,4}/g) ?? [];
}

export function MobileAccessSettings({ preview }: { preview: boolean }) {
  const { resolvedLanguage } = useI18n();
  const { marks } = usePreviewMode();
  const zh = resolvedLanguage === "zh";
  const api = globalThis.ompStudioMobileAccess;
  const [status, setStatus] = useState<MobileAccessStatus | undefined>(() => preview ? PREVIEW_MOBILE_ACCESS.idle : undefined);
  const [workspace, setWorkspace] = useState<WorkspaceId>();
  const [ip, setIp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [pairing, setPairing] = useState<Pairing>();
  const [now, setNow] = useState(Date.now);
  const [trusted, setTrusted] = useState(readTrusted);
  const [viewCert, setViewCert] = useState(false);
  const [exported, setExported] = useState(false);
  const [copied, setCopied] = useState(false);
  const [platform, setPlatform] = useState<"ios" | "android">("ios");
  const wasPaired = useRef(false);

  useEffect(() => {
    if (preview || !api) return;
    let mounted = true;
    const refresh = () => void api.status().then(value => {
      if (!mounted) return;
      setStatus(value);
      setWorkspace(previous => value.projects.some(project => project.id === previous) ? previous : value.projects[0]?.id);
      setIp(previous => value.addresses.includes(previous) ? previous : value.addresses[0] ?? "");
    }, () => { if (mounted) setError(true); });
    refresh();
    const timer = setInterval(refresh, 2_000);
    return () => { mounted = false; clearInterval(timer); };
  }, [api, preview]);

  useEffect(() => {
    if (!preview) return;
    setWorkspace(previous => previous ?? PREVIEW_MOBILE_ACCESS.idle.projects[0]?.id);
    setIp(previous => previous || PREVIEW_MOBILE_ACCESS.idle.addresses[0] || "");
  }, [preview]);

  // The countdown only ticks while a code is on screen.
  useEffect(() => {
    if (!pairing) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pairing]);

  const active = status?.active;
  // A scan flips `paired`; the code that was scanned is spent.
  useEffect(() => {
    const paired = active?.paired === true;
    if (paired && !wasPaired.current) setPairing(undefined);
    wasPaired.current = paired;
  }, [active?.paired]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    if (preview) { await action(); return; }
    if (!api) return;
    setBusy(true);
    setError(false);
    try {
      await action();
      setStatus(await api.status());
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  // Preview: every action only moves local fixture state; nothing reaches the Host.
  const demo = {
    start: () => setStatus(PREVIEW_MOBILE_ACCESS.active(ip, workspace)),
    stop: () => setStatus(PREVIEW_MOBILE_ACCESS.idle),
    pair: () => ({ expiresAt: Date.now() + PAIRING_MS }),
  };
  const start = () => void run(async () => { if (preview) demo.start(); else if (api && workspace && ip) await api.start(ip, workspace); });
  const stop = () => void run(async () => { setPairing(undefined); setViewCert(false); if (preview) demo.stop(); else await api?.stop(); });
  const pair = () => void run(async () => { setNow(Date.now()); setPairing(preview ? demo.pair() : await api!.pair()); });
  const revoke = () => void run(async () => { setPairing(undefined); if (preview) setStatus(PREVIEW_MOBILE_ACCESS.active(ip, workspace)); else await api?.revoke(); });
  const exportCertificate = () => void run(async () => { if (preview || await api?.exportCertificate()) setExported(true); });
  const confirmTrust = () => {
    if (!active) return;
    writeTrusted(active.fingerprint);
    setTrusted(active.fingerprint);
    setViewCert(false);
    if (!active.paired) pair();
  };
  const copyFingerprint = () => {
    if (!active) return;
    void navigator.clipboard?.writeText(active.fingerprint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    }, () => undefined);
  };

  const live = pairing !== undefined && pairing.expiresAt > now;
  const expired = pairing !== undefined && !live;
  const isTrusted = active !== undefined && trusted === active.fingerprint;
  const step: Step = !active ? 0
    : viewCert || (!isTrusted && !active.paired) ? 1
      : active.paired && !pairing ? 3 : 2;
  const seconds = live ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;
  const projectName = active?.workspaceName ?? status?.projects.find(project => project.id === workspace)?.name ?? "";
  const origin = active?.origin ?? (ip ? `https://${ip}` : "");
  const unavailable = !preview && !api;
  const cannotStart = !preview && status !== undefined && (!status.projects.length || !status.addresses.length);

  const text = zh ? ZH : EN;
  const pill = !active ? { tone: "", label: text.off }
    : step === 3 ? { tone: "ok", label: text.paired }
      : expired ? { tone: "warn", label: text.expired }
        : { tone: "wait", label: text.waiting };

  if (unavailable) {
    return <SettingSection title={text.title} desc={text.desc}>
      <p className="mas-unavailable">{text.desktopOnly}</p>
    </SettingSection>;
  }

  return <SettingSection title={text.title} desc={text.desc}>
    <div className="mas" aria-busy={busy}>
      <div className="mas-bar">
        <span className={`mas-pill ${pill.tone}`} role="status"><i aria-hidden="true" />{pill.label}</span>
        {preview && marks ? <span className="mas-demo">{text.demo}</span> : null}
        {active ? <code className="mas-origin">{origin}</code> : null}
        <button type="button" className={`switch${active ? " on" : ""}`} role="switch" aria-checked={!!active} aria-label={text.title}
          disabled={busy || (!active && (!workspace || !ip))} onClick={active ? stop : start} />
      </div>

      <div className="mas-grid">
        <ol className="mas-flow" aria-label={text.flowAria}>
          <FlowStep index={0} step={step} title={text.s1} sub={step > 0 ? `${projectName} · ${origin}` : text.s1Hint}
            action={step > 0 ? <button type="button" className="mas-link" disabled={busy} onClick={stop}>{text.change}</button> : null}>
            <div className="mas-label" id="mas-project-label">{text.projectLabel}</div>
            <div className="mas-options" role="radiogroup" aria-labelledby="mas-project-label">
              {(status?.projects ?? []).map(project => <button type="button" key={project.id} role="radio" aria-checked={project.id === workspace}
                className={`mas-option${project.id === workspace ? " on" : ""}`} disabled={busy} onClick={() => setWorkspace(project.id)}>
                <span className="mas-radio" aria-hidden="true" /><span className="mas-option-name">{project.name}</span>
              </button>)}
            </div>
            <div className="mas-label" id="mas-ip-label">{text.ipLabel}</div>
            <div className="mas-chips" role="radiogroup" aria-labelledby="mas-ip-label">
              {(status?.addresses ?? []).map(address => <button type="button" key={address} role="radio" aria-checked={address === ip}
                className={`mas-chip${address === ip ? " on" : ""}`} disabled={busy} onClick={() => setIp(address)}>
                <WifiIcon /><code>{address}</code>
              </button>)}
            </div>
            {cannotStart ? <p className="mas-hint" role="note">{text.needProject}</p> : null}
            <div className="mas-actions">
              <button type="button" className="btn primary" disabled={busy || !workspace || !ip} onClick={start}>{text.start}</button>
              <span className="mas-note"><ShieldIcon />{text.scopeNote}</span>
            </div>
          </FlowStep>

          <FlowStep index={1} step={step} title={text.s2} sub={step > 1 || (step === 1 && viewCert) ? text.s2Done : text.s2Hint}
            action={step > 1 ? <button type="button" className="mas-link" onClick={() => setViewCert(true)}>{text.view}</button> : null}>
            <div className="mas-cert">
              <span className="mas-file" aria-hidden="true"><CertIcon /></span>
              <div className="mas-cert-main">
                <code className="mas-cert-name">OMP-Studio-Mobile-CA.cer</code>
                <span className="mas-cert-sub">{exported ? text.exported : text.certHint}</span>
              </div>
              <button type="button" className={`btn ${exported ? "outline" : "primary"}`} disabled={busy} onClick={exportCertificate}>
                {exported ? text.exportAgain : text.export}
              </button>
            </div>
            {active ? <div className="mas-fp">
              <div className="mas-fp-head"><span>{text.fpLabel}</span>
                <button type="button" className="btn small outline" onClick={copyFingerprint}>{copied ? text.copied : text.copy}</button>
              </div>
              <div className="mas-fp-grid" aria-label={active.fingerprint}>
                {fingerprintGroups(active.fingerprint).map((group, index, all) => <span key={index} className={index === 0 || index === all.length - 1 ? "edge" : undefined}>{group}</span>)}
              </div>
            </div> : null}
            <div className="mas-platform">
              <div className="mas-seg" role="radiogroup" aria-label={text.platformAria} data-value={platform}>
                <span className="mas-seg-thumb" aria-hidden="true" />
                <button type="button" role="radio" aria-checked={platform === "ios"} onClick={() => setPlatform("ios")}>iOS</button>
                <button type="button" role="radio" aria-checked={platform === "android"} onClick={() => setPlatform("android")}>Android</button>
              </div>
              <ol className="mas-path" key={platform}>
                {(platform === "ios" ? text.ios : text.android).map(([label, path]) => <li key={label}><span>{label}</span>{path}</li>)}
              </ol>
            </div>
            <div className="mas-actions">
              <button type="button" className="btn primary" disabled={busy} onClick={confirmTrust}>{text.trusted}</button>
              {viewCert ? <button type="button" className="btn" onClick={() => setViewCert(false)}>{text.back}</button> : null}
            </div>
          </FlowStep>

          <FlowStep index={2} step={step} title={text.s3} sub={step > 2 ? text.s3Done : text.s3Hint} last>
            <p className="mas-p">{text.s3Text}</p>
            <div className="mas-actions">
              <button type="button" className="btn outline" disabled={busy} onClick={pair}><RefreshIcon />{pairing ? text.regen : text.generate}</button>
              <span className="mas-note">{text.s3Note}</span>
            </div>
          </FlowStep>
        </ol>

        <aside className="mas-panel" aria-label={text.panelTitle}>
          {step === 3 ? <div className="mas-done" role="status">
            <span className="mas-check" aria-hidden="true"><CheckIcon size={30} /></span>
            <strong>{text.okTitle}</strong>
            <span className="mas-done-sub">{text.okSub}</span>
            <div className="mas-done-actions">
              <button type="button" className="btn outline" disabled={busy} onClick={pair}>{text.replace}</button>
              <button type="button" className="btn outline danger" disabled={busy} onClick={revoke}>{text.revoke}</button>
            </div>
            <span className="mas-note">{text.replaceNote}</span>
          </div> : <>
            <div className="mas-stage">
              <div className={`mas-qr${step < 2 ? " locked" : ""}${expired ? " expired" : ""}${live ? " live" : ""}`}>
                {live ? <svg className="mas-ring" viewBox="0 0 220 220" aria-hidden="true">
                  <rect x="1.5" y="1.5" width="217" height="217" rx="24" pathLength="100" />
                  <rect className={seconds <= 15 ? "warn" : undefined} x="1.5" y="1.5" width="217" height="217" rx="24" pathLength="100"
                    style={{ strokeDashoffset: 100 - (seconds / 60) * 100 }} />
                </svg> : null}
                <div className="mas-qr-card" key={pairing?.expiresAt ?? "none"}>
                  {pairing?.qr ? <img src={pairing.qr} width={184} height={184} alt={text.qrAlt} /> : <DemoCode />}
                  {live ? <span className="mas-beam" aria-hidden="true" /> : null}
                </div>
                {preview && marks && live ? <button type="button" className="mas-demo-scan" onClick={() => setStatus(PREVIEW_MOBILE_ACCESS.active(ip, workspace, true))}>{text.demoScan}</button> : null}
                {step < 2 ? <div className="mas-over"><span className="mas-over-ic"><LockIcon /></span>{step === 0 ? text.lock1 : text.lock2}</div> : null}
                {step === 2 && !pairing ? <div className="mas-over"><button type="button" className="btn primary" disabled={busy} onClick={pair}>{text.generate}</button></div> : null}
                {expired ? <div className="mas-over"><span className="mas-over-ic warn"><ClockIcon /></span>{text.expiredTitle}
                  <button type="button" className="btn primary small" disabled={busy} onClick={pair}>{text.regen}</button></div> : null}
              </div>
            </div>
            <div className="mas-status" role="status">
              {live ? <>
                <strong><i className="mas-live" aria-hidden="true" />{text.waitTitle}<span className={`mas-count${seconds <= 15 ? " warn" : ""}`}>{text.left(seconds)}</span></strong>
                <span>{text.waitSub}</span>
              </> : expired ? <>
                <strong className="warn">{text.expiredTitle}</strong><span>{text.expiredSub}</span>
              </> : <>
                <strong className="muted">{step === 0 ? text.lock1 : step === 1 ? text.lock2 : text.readyTitle}</strong><span>{text.lockSub}</span>
              </>}
            </div>
            <ol className={`mas-tips${live ? " on" : ""}`}>
              {text.tips.map((tip, index) => <li key={tip}><b>{index + 1}</b>{tip}</li>)}
            </ol>
          </>}
        </aside>
      </div>

      <ul className="mas-foot">
        {text.foot.map(item => <li key={item}><CheckIcon size={13} />{item}</li>)}
      </ul>
      {error && !preview ? <p className="mas-error" role="alert">{text.error}</p> : null}
    </div>
  </SettingSection>;
}

function FlowStep({ index, step, title, sub, action, last, children }: {
  index: number; step: Step; title: string; sub: string; action?: ReactNode; last?: boolean; children: ReactNode;
}) {
  const state = step > index ? "done" : step === index ? "current" : "todo";
  return <li className={`mas-step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
    <span className="mas-bub" aria-hidden="true">{state === "done" ? <CheckIcon size={14} /> : index + 1}</span>
    {last ? null : <span className="mas-conn" aria-hidden="true"><i /></span>}
    <div className="mas-head">
      <div className="mas-head-text"><div className="mas-step-title">{title}</div><div className="mas-step-sub">{sub}</div></div>
      {action}
    </div>
    <div className={`mas-body${state === "current" ? " open" : ""}`} inert={state !== "current"}>
      <div className="mas-body-in"><div className="mas-pad">{children}</div></div>
    </div>
  </li>;
}

/** Preview only: a static stand-in so the panel keeps its shape. It encodes nothing. */
function DemoCode() {
  return <div className="mas-demo-code" aria-hidden="true">
    {PREVIEW_MOBILE_ACCESS.codeModules.map(([row, column]) => <i key={`${row}-${column}`} style={{ gridRow: row, gridColumn: column }} />)}
    <b style={{ gridArea: "1 / 1 / 8 / 8" }} /><b style={{ gridArea: "1 / 19 / 8 / 26" }} /><b style={{ gridArea: "19 / 1 / 26 / 8" }} />
  </div>;
}

const icon = (path: string, size = 16, width = 2) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
const CheckIcon = ({ size = 16 }: { size?: number }) => icon("M5 12.5l4.5 4.5L19 7.5", size, 2.6);
const WifiIcon = () => icon("M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 19.5h.01", 14);
const ShieldIcon = () => icon("M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z", 13);
const CertIcon = () => icon("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9.5 14.5l1.8 1.8 3.4-3.6", 18, 1.9);
const RefreshIcon = () => icon("M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4", 14);
const LockIcon = () => icon("M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a1 1 0 0 1 1-1z", 16);
const ClockIcon = () => icon("M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", 16);

const ZH = {
  title: "手机访问", desc: "手机和电脑连上同一个 Wi‑Fi 后，可以在手机上继续一个本地项目的对话。",
  desktopOnly: "请在 OMP Studio 桌面端开启此功能。", demo: "演示", demoScan: "演示：模拟扫码",
  off: "未开启", waiting: "等待配对", paired: "已配对", expired: "配对码已过期",
  flowAria: "配对步骤", s1: "选择项目", s2: "信任证书", s3: "扫码配对",
  s1Hint: "选择手机可以访问的本地项目和网络", s2Hint: "首次使用时，在手机上安装并信任 Studio 证书", s3Hint: "用手机相机扫描右侧的二维码",
  projectLabel: "共享项目", ipLabel: "局域网地址", start: "开启手机访问", scopeNote: "手机只能访问这一个项目",
  needProject: "请先打开本地项目并连接局域网。", change: "更改", view: "查看", back: "返回",
  certHint: "用 AirDrop、数据线或其他可信方式传到手机", export: "导出证书", exported: "已导出，传到手机后安装", exportAgain: "再次导出",
  fpLabel: "SHA‑256 指纹 · 在手机上逐组核对", copy: "复制", copied: "已复制", platformAria: "手机系统",
  ios: [["安装", "设置 › 通用 › VPN 与设备管理 › 安装描述文件"], ["信任", "设置 › 通用 › 关于本机 › 证书信任设置 › 启用"]] as Array<[string, string]>,
  android: [["安装", "设置 › 安全 › 加密与凭据 › 安装证书 › CA 证书"], ["核对", "比对指纹一致后再确认安装"]] as Array<[string, string]>,
  trusted: "已信任，生成配对码", s2Done: "证书已在手机上信任",
  s3Text: "打开手机相机对准二维码，轻点弹出的链接即可完成配对。二维码 60 秒内有效，过期后重新生成即可。",
  generate: "生成配对码", regen: "重新生成", s3Note: "配对 8 小时内有效", s3Done: "手机已配对",
  panelTitle: "配对二维码", lock1: "先选择要共享的项目", lock2: "信任证书后显示二维码", readyTitle: "准备好就生成配对码",
  lockSub: "二维码只在你操作时生成，60 秒后自动失效。",
  waitTitle: "等待手机扫码", waitSub: "扫码后手机会打开 OMP Studio，并直接进入这个项目。", left: (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 后失效`,
  expiredTitle: "二维码已过期", expiredSub: "重新生成一个二维码，再用手机扫描。",
  tips: ["打开相机", "对准二维码", "轻点链接"], qrAlt: "手机配对二维码",
  okTitle: "手机已配对", okSub: "现在可以在手机上查看会话、发送消息，并处理单次工具审批。配对 8 小时后需要重新扫码。",
  replace: "配对另一台手机", revoke: "撤销手机授权", replaceNote: "新的配对会替换当前手机的授权",
  foot: ["只共享所选项目", "配对 8 小时后自动失效", "关闭后，电脑上已在执行的任务会继续运行"],
  error: "操作失败。请检查本地项目、网络地址和应用构建后重试。",
};
const EN: typeof ZH = {
  title: "Mobile access", desc: "Continue a local project’s conversations on your phone while both devices are on the same Wi‑Fi.",
  desktopOnly: "Enable this feature from the OMP Studio desktop app.", demo: "Demo", demoScan: "Demo: simulate a scan",
  off: "Off", waiting: "Waiting for phone", paired: "Paired", expired: "Code expired",
  flowAria: "Pairing steps", s1: "Choose a project", s2: "Trust the certificate", s3: "Scan to pair",
  s1Hint: "Pick the local project and network your phone can reach", s2Hint: "On first use, install and trust the Studio certificate on your phone", s3Hint: "Scan the code on the right with your phone camera",
  projectLabel: "Shared project", ipLabel: "LAN address", start: "Enable mobile access", scopeNote: "Your phone can open this project only",
  needProject: "Open a local project and connect to the local network first.", change: "Change", view: "View", back: "Back",
  certHint: "Send it to your phone with AirDrop, a cable or another trusted channel", export: "Export certificate", exported: "Exported. Install it on your phone", exportAgain: "Export again",
  fpLabel: "SHA‑256 fingerprint · compare each group on your phone", copy: "Copy", copied: "Copied", platformAria: "Phone platform",
  ios: [["Install", "Settings › General › VPN & Device Management › install the profile"], ["Trust", "Settings › General › About › Certificate Trust Settings › turn on"]],
  android: [["Install", "Settings › Security › Encryption & credentials › Install a certificate › CA certificate"], ["Check", "Confirm only after the fingerprint matches"]],
  trusted: "Trusted — create a code", s2Done: "Certificate trusted on the phone",
  s3Text: "Point your phone camera at the code and tap the link that appears. The code is valid for 60 seconds; create a new one any time.",
  generate: "Create pairing code", regen: "New code", s3Note: "Pairing lasts 8 hours", s3Done: "Phone paired",
  panelTitle: "Pairing code", lock1: "Choose a project first", lock2: "Trust the certificate to show the code", readyTitle: "Create a code when you’re ready",
  lockSub: "Codes are created only when you ask and expire after 60 seconds.",
  waitTitle: "Waiting for your phone", waitSub: "After scanning, your phone opens OMP Studio straight into this project.", left: (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`,
  expiredTitle: "This code expired", expiredSub: "Create a new code, then scan it with your phone.",
  tips: ["Open camera", "Point at code", "Tap the link"], qrAlt: "Phone pairing QR code",
  okTitle: "Phone paired", okSub: "Read chats, send messages and answer one-time tool approvals from your phone. Pair again after 8 hours.",
  replace: "Pair another phone", revoke: "Revoke phone access", replaceNote: "A new pairing replaces this phone’s access",
  foot: ["Only the selected project is shared", "Pairing expires after 8 hours", "Tasks already running keep going on the computer"],
  error: "The operation failed. Check the local project, network address, and app build, then retry.",
};
