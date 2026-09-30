/**
 * Microphone permission before capture. macOS asks each app once; after a
 * denial only System Settings can grant access, so the panes offer a way
 * there. Windows and the Web UI leave consent to Chromium's own prompt.
 */

export class MicrophoneDeniedError extends Error {
  constructor(zh: boolean) {
    super(zh
      ? "麦克风权限已被拒绝：请在“系统设置 › 隐私与安全性 › 麦克风”中允许 OMP Studio，然后重试。"
      : "Microphone access is denied. Allow OMP Studio in System Settings › Privacy & Security › Microphone, then try again.");
    this.name = "MicrophoneDeniedError";
  }
}

/**
 * Resolves once macOS has granted the microphone, rejecting with
 * `MicrophoneDeniedError` otherwise. Returns `undefined` off the macOS desktop,
 * so callers start capture in the same tick as before.
 */
export function ensureMicrophoneAccess(
  zh: boolean,
  api: { readonly platform?: string; requestMicrophoneAccess?(): Promise<"granted" | "denied"> } | undefined = globalThis.ompStudioChrome,
): Promise<void> | undefined {
  if (api?.platform !== "darwin" || !api.requestMicrophoneAccess) return undefined;
  return api.requestMicrophoneAccess().then((status) => {
    if (status === "denied") throw new MicrophoneDeniedError(zh);
  });
}

export function MicrophoneSettingsButton({ zh }: { zh: boolean }) {
  const open = globalThis.ompStudioChrome?.openMicrophoneSettings;
  if (!open) return null;
  return (
    <button type="button" className="btn small outline" onClick={() => { void open().catch(() => undefined); }}>
      {zh ? "打开系统设置" : "Open System Settings"}
    </button>
  );
}
