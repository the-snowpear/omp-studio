import { sshAuthenticationRequest, type SshAuthentication } from "./authentication.js";
import { sshArguments, systemSshExecutable, type SshConnection } from "./platform.js";
import { wslCommandArgs, wslExecutable } from "./wsl.js";
import { RemoteConnectionError } from "./errors.js";
import { desktopText } from "../desktop-language-shared.js";

export interface RemoteSpawn { file: string; args: string[]; env?: NodeJS.ProcessEnv; dispose(): void; }
export function remoteSpawn(profile: SshConnection, command: string, authentication?: SshAuthentication, options?: { tty?: boolean; sshExecutable?: string | undefined }): RemoteSpawn {
  if (profile.kind === "wsl") {
    const file = wslExecutable();
    if (!file) throw new RemoteConnectionError("configuration", desktopText("未安装 WSL", "WSL is not installed"));
    return { file, args: wslCommandArgs(profile.distro, command), dispose() {} };
  }
  const args = sshArguments(profile);
  if (options?.tty) args[0] = "-tt";
  args.push(command);
  const file = options?.sshExecutable ?? systemSshExecutable();
  const request = sshAuthenticationRequest(profile, authentication);
  return { file, args, ...(request ? { env: request.env } : {}), dispose: () => request?.dispose() };
}
