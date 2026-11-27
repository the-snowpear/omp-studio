import type { ChromeRelayHostStatus } from "@omp-studio/studio-protocol";

/** The external browser management fixture stays separate from embedded page state. */
export function getPreviewChromeRelay(zh: boolean, installed = true): ChromeRelayHostStatus {
  const dir = "C:\\Users\\demo\\.omp\\browser-relay\\extension";
  const extensionId = "abcdefghijklmnoabcdefghijklmnopab";
  const launcher = "C:\\Users\\demo\\.omp\\browser-relay\\native-host.cmd";
  return {
    ompVersion: "19.2.1", expectedBuild: "studio-preview", defaultExtensionDir: dir, defaultExtensionId: extensionId,
    registryFile: "C:\\Users\\demo\\.omp\\browser-relay\\installs.json",
    installs: [{ dir, extensionId, exists: installed, missing: !installed, recordedVersion: installed ? "19.2.1" : null, installedVersion: installed ? "19.2.1" : "", installedBuild: installed ? "studio-preview" : null, expectedVersion: "19.2.1", expectedBuild: "studio-preview", upToDate: installed, isDefault: true }],
    browsers: [{ name: "Google Chrome", userDataDir: "C:\\Users\\demo\\AppData\\Local\\Google\\Chrome\\User Data", executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", lastUsedProfile: "Default" }],
    profiles: [
      { browser: "Google Chrome", profile: zh ? "个人" : "Personal", profileDir: "Default", extensionId, loaded: installed, enabled: installed, disabled: false, developerMode: installed },
      { browser: "Google Chrome", profile: zh ? "测试账号" : "QA account", profileDir: "Profile 1", extensionId, loaded: false, enabled: false, disabled: false, developerMode: false },
    ],
    nativeHost: { hostName: "sh.omp.browser", platform: "win32", launcherPath: launcher, launcherExists: installed, launcherValid: installed, registered: installed, needsRepair: !installed,
      manifests: [{ path: "C:\\Users\\demo\\.omp\\browser-relay\\sh.omp.browser.json", exists: installed, valid: installed, pathMatchesLauncher: installed, allowedOrigins: installed ? [`chrome-extension://${extensionId}/`] : [], missingExtensionIds: installed ? [] : [extensionId] }],
      windowsRegistry: [{ browser: "Google Chrome", key: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\sh.omp.browser", registered: installed, matchesManifest: installed }],
    },
    health: { settingEnabled: true, discoveredEndpoints: installed ? ["http://127.0.0.1:19391"] : [], endpoints: installed ? [{ url: "http://127.0.0.1:19391", configured: false, outcome: "ready", relayVersion: "19.2.1", extensionVersion: "19.2.1", cdpClients: 1 }] : [], ready: installed },
    policy: { checked: true, platform: "win32", blocked: false, extensionBlocked: false, nativeHostBlocked: false, userLevelHostsDisabled: false, denials: [], warnings: [] },
  };
}
