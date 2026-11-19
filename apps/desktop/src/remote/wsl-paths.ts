import { posix, win32 } from "node:path";
import { assertDistroName } from "./wsl.js";
import { desktopText } from "../desktop-language-shared.js";

export function wslUncPath(distro: string, linuxPath: string): string {
  assertDistroName(distro);
  if (!posix.isAbsolute(linuxPath) || /[\\\0]/u.test(linuxPath)) throw new Error(desktopText("需要可映射到 Windows 的 Linux 绝对路径", "Expected an absolute Linux path that Windows can open"));
  return `\\\\wsl.localhost\\${distro}${posix.normalize(linuxPath).replaceAll("/", "\\")}`;
}
export function wslLinuxPath(distro: string, unc: string): string {
  return "/" + win32.relative(wslUncPath(distro, "/"), unc).replaceAll("\\", "/");
}
