import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeInstanceId } from "@omp-studio/studio-protocol";

export interface BridgeBootstrap {
  endpoint: string;
  tokenFile: string;
  token: string;
}

export interface WindowsBridgeAclPort {
  secureDirectory(path: string): Promise<void>;
  createSecureTokenFile(path: string, token: string): Promise<void>;
}

export type WindowsAclCommandRunner = (executable: string, args: readonly string[]) => Promise<string>;

function windowsSystem32Executable(name: "whoami.exe" | "icacls.exe"): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

function runWindowsAclCommand(executable: string, args: readonly string[]): Promise<string> {
  const resolved =
    process.platform === "win32" && (executable === "whoami.exe" || executable === "icacls.exe")
      ? windowsSystem32Executable(executable)
      : executable;
  return new Promise((resolve, reject) => {
    execFile(resolved, [...args], { encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });
}

export function parseWindowsUserSid(output: string): string {
  const match = output.trim().match(/(?:^|,)\s*"?(S-\d+(?:-\d+)+)"?\s*$/u);
  if (match?.[1] === undefined) throw new Error("Unable to determine the current Windows user SID");
  return match[1];
}

/** Production current-user-only ACL provider for Windows Bridge bootstrap state. */
export function createWindowsBridgeAclPort(
  runCommand: WindowsAclCommandRunner = runWindowsAclCommand,
): WindowsBridgeAclPort {
  const sid = runCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"]).then(parseWindowsUserSid);
  const secure = async (path: string, inheritance: string): Promise<void> => {
    const currentSid = await sid;
    await runCommand("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${currentSid}:${inheritance}`]);
  };
  return {
    secureDirectory: (path) => secure(path, "(OI)(CI)F"),
    async createSecureTokenFile(path, token) {
      await writeFile(path, token, { encoding: "utf8", flag: "wx" });
      try {
        await secure(path, "F");
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
    },
  };
}

export async function createBridgeBootstrap(
  privateDirectory: string,
  platform: NodeJS.Platform = process.platform,
  windowsAcl?: WindowsBridgeAclPort,
): Promise<BridgeBootstrap> {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    if (windowsAcl === undefined) {
      throw new Error("Windows bridge bootstrap requires an explicit current-user ACL provider");
    }
    await windowsAcl.secureDirectory(privateDirectory);
  }
  const opaqueName = randomBytes(18).toString("hex");
  const token = randomBytes(32).toString("base64url");
  const tokenFile = join(privateDirectory, `${opaqueName}.token`);
  const endpoint =
    platform === "win32"
      ? `\\\\.\\pipe\\omp-studio-${opaqueName}`
      : join(privateDirectory, `${opaqueName}.sock`);

  if (platform === "win32") {
    await windowsAcl!.createSecureTokenFile(tokenFile, token);
  } else {
    await writeFile(tokenFile, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  return { endpoint, tokenFile, token };
}

export async function consumeBridgeToken(tokenFile: string): Promise<string> {
  const claimed = `${tokenFile}.claimed`;
  await writeFile(claimed, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const token = await readFile(tokenFile, "utf8");
    await rm(tokenFile);
    return token;
  } finally {
    await rm(claimed, { force: true });
  }
}

export function createChallengeProof(token: string, challenge: string, runtimeInstanceId: RuntimeInstanceId): string {
  return createHmac("sha256", token).update(challenge).update("\0").update(runtimeInstanceId).digest("base64url");
}

export function verifyChallengeProof(
  token: string,
  challenge: string,
  runtimeInstanceId: RuntimeInstanceId,
  proof: string,
): boolean {
  const expected = Buffer.from(createChallengeProof(token, challenge, runtimeInstanceId));
  const received = Buffer.from(proof);
  return expected.byteLength === received.byteLength && timingSafeEqual(expected, received);
}
