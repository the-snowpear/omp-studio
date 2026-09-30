/**
 * Small lifecycle policies that differ on macOS, kept pure for tests.
 */
import { join } from "node:path";

/**
 * Arguments for `app.relaunch`: keep the user's, drop a stale restart flag and
 * the `-psn_*` process serial number older macOS adds to Finder launches.
 */
export function relaunchArguments(argv: readonly string[]): string[] {
  return argv
    .slice(1)
    .filter((arg) => arg !== "--omp-restarted" && !arg.startsWith("-psn_"))
    .concat("--omp-restarted");
}

export const MOVE_TO_APPLICATIONS_DECLINED_FILE = "move-to-applications-declined";

export function moveToApplicationsMarkerPath(stateRoot: string): string {
  return join(stateRoot, MOVE_TO_APPLICATIONS_DECLINED_FILE);
}

/**
 * A packaged Mac app run from the disk image, Downloads or an App Translocation
 * mount cannot update itself in place; offer the move once until declined.
 */
export function shouldOfferMoveToApplications(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly inApplicationsFolder: boolean;
  readonly declined: boolean;
}): boolean {
  return input.platform === "darwin" && input.isPackaged && !input.inApplicationsFolder && !input.declined;
}

export interface MoveToApplicationsStrings {
  readonly message: string;
  readonly detail: string;
  readonly move: string;
  readonly later: string;
}

export function moveToApplicationsStrings(locale: string): MoveToApplicationsStrings {
  return locale.toLowerCase().startsWith("zh")
    ? {
        message: "将 OMP Studio 移到“应用程序”文件夹？",
        detail: "从磁盘映像或“下载”文件夹运行时无法自动更新。移动后应用会重新打开。",
        move: "移到“应用程序”",
        later: "暂不移动",
      }
    : {
        message: "Move OMP Studio to the Applications folder?",
        detail: "OMP Studio can't update itself while it runs from a disk image or the Downloads folder. It reopens after the move.",
        move: "Move to Applications",
        later: "Not Now",
      };
}
