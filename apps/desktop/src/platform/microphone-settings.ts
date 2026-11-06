export function microphoneSettingsUrl(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  if (platform === "win32") return "ms-settings:privacy-microphone";
  return undefined;
}
