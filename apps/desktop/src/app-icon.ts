/**
 * Desktop app mark: window / dock / notification / Windows AppUserModelId.
 *
 * Source of truth is repo-root `icon.png`, copied next to the Electron
 * package as `resources/icon.ico` + `resources/icon.png`. Packed builds must
 * include `resources/**` in electron-builder `files` so `app.getAppPath()`
 * can still see them inside the asar.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Must match `packaging/electron-builder.yml` `appId`. */
export const APP_USER_MODEL_ID = "com.ompstudio.app";

export function resolveAppIconPath(options: {
  readonly appPath: string;
  readonly platform: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
}): string | undefined {
  const exists = options.exists ?? existsSync;
  const dir = join(options.appPath, "resources");
  const ico = join(dir, "icon.ico");
  const png = join(dir, "icon.png");
  if (options.platform === "win32" && exists(ico)) return ico;
  if (exists(png)) return png;
  if (exists(ico)) return ico;
  return undefined;
}
