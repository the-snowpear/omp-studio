import { PLATFORM, type RendererPlatform } from "./platform";

/**
 * The system file manager's name for copy like "在{fileManager}中打开": 访达 / Finder on
 * macOS, 资源管理器 / File Explorer on Windows, 文件管理器 / File Manager on Linux.
 */
export function fileManagerName(t: (key: string) => string, platform: RendererPlatform = PLATFORM): string {
  return t(platform === "darwin" ? "shell.fileManagerMac" : platform === "linux" ? "shell.fileManagerLinux" : "shell.fileManagerWindows");
}
