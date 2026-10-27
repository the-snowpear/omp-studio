import type { RemoteEnvironment } from "./deploy.js";
import { nodeRemoteCommand } from "./deploy.js";
import { powershellCommand, quotePs, quoteSh } from "./probe.js";

export function remoteNodeCommand(environment: RemoteEnvironment, script: string, executable = environment.node): string {
  const body = `eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString())`;
  if (environment.platform === "win32" && executable !== "node") return powershellCommand(`& ${quotePs(executable)} -e ${quotePs(body)}; exit $LASTEXITCODE`);
  if (environment.platform !== "win32") return `${quoteSh(executable)} -e ${quoteSh(body)}`;
  return nodeRemoteCommand(script, executable);
}
