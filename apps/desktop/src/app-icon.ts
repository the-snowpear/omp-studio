/**
 * Resolve the native app icon for Electron windows.
 *
 * Development loads the desktop package directly, while packaged builds load
 * from `resources/app.asar` and place the same files next to the asar via
 * electron-builder `extraResources`. Prefer the unpacked path so Windows can
 * read the ICO from the real filesystem for taskbar/window identity.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Must match `packaging/electron-builder.yml` `appId`. */
export const APP_USER_MODEL_ID = "com.ompstudio.desktop";

export function resolveAppIconPath(options: {
  readonly appPath: string;
  readonly platform: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
}): string | undefined {
  const exists = options.exists ?? existsSync;
  const candidates = (fileName: string): string[] => [
    // Packaged: appPath is .../resources/app.asar.
    join(options.appPath, "..", fileName),
    // Development and asar-local fallback: appPath is apps/desktop.
    join(options.appPath, "resources", fileName),
    // Development workspace root: appPath is repository root.
    join(options.appPath, "apps", "desktop", "resources", fileName),
  ];
  const preferred = options.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png", "icon.ico"];
  for (const fileName of preferred) {
    for (const path of candidates(fileName)) {
      if (exists(path)) return path;
    }
  }
  return undefined;
}
