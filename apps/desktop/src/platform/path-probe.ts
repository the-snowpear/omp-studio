import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import { dirname, join, parse, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkspacePathKind, WorkspacePathResolution } from "@omp-studio/client-contract";

const execute = promisify(execFile);
const networkPath = /^[\\/]{2}/;
const remoteFileSystem = /^(?:nfs[0-9]*|cifs|smb[0-9a-z]*|afs|ceph|glusterfs|9p|coda|davfs[0-9]*|ncpfs|autofs|fuse(?:blk|\..+)?)$/i;
const unescapeMount = (path: string) => path.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));

const fileKind = (info: Stats): WorkspacePathKind | undefined =>
  info.isFile() ? "file" : info.isDirectory() ? "directory" : undefined;

async function localPaths(): Promise<(path: string) => boolean> {
  if (process.platform === "win32") {
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // DriveType gets volume metadata. Listing a drive root could connect a disconnected mapping.
    const { stdout } = await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "foreach ($drive in [IO.DriveInfo]::GetDrives()) { if ($drive.DriveType -in 'Removable','Fixed','CDRom','Ram') { $drive.Name } }"
    ], { windowsHide: true, timeout: 3000 });
    const localRoots = new Set(stdout.trim().toUpperCase().split(/\s+/));
    return path => localRoots.has(parse(path).root.toUpperCase());
  }

  const remoteMounts: string[] = [];
  if (process.platform === "linux") {
    for (const line of (await readFile("/proc/self/mountinfo", "utf8")).split("\n").filter(Boolean)) {
      const [mount, filesystem] = line.split(" - ");
      const [type, source] = filesystem!.split(" ");
      if (remoteFileSystem.test(type!) || source?.startsWith("//")) remoteMounts.push(unescapeMount(mount!.split(" ")[4]!));
    }
  } else {
    const { stdout } = await execute("/sbin/mount", [], { timeout: 3000 });
    for (const line of stdout.split("\n")) {
      const match = /^.+? on (.+) \((.+)\)$/.exec(line);
      if (match && !match[2]!.split(", ").includes("local")) remoteMounts.push(match[1]!);
    }
  }
  return path => !remoteMounts.some(mount => path === mount || path.startsWith(mount === sep ? mount : mount + sep));
}

/** An automatic probe may inspect local metadata. Follow links and mounts only on an explicit open. */
export async function probeFilePaths(
  paths: readonly string[],
  pathFor: (path: string) => string | Promise<string>,
  explicit = false,
): Promise<readonly WorkspacePathResolution[]> {
  const isLocal = explicit ? undefined : await localPaths().catch(() => () => false);
  const classified = new Map<string, Promise<WorkspacePathKind | undefined>>();
  function localKind(path: string): Promise<WorkspacePathKind | undefined> {
    let result = classified.get(path);
    if (!result) {
      result = (async () => {
        if (!isLocal?.(path)) return undefined;
        const parent = dirname(path);
        if (parent !== path) {
          const parentKind = await localKind(parent);
          if (parentKind !== "directory") return parentKind === undefined ? undefined : "missing";
        }
        try {
          return fileKind(await lstat(path));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") return "missing";
          throw error;
        }
      })();
      classified.set(path, result);
    }
    return result;
  }
  const results = await Promise.all(paths.map(async (path): Promise<WorkspacePathResolution | undefined> => {
    if (!explicit && networkPath.test(path)) return undefined;
    try {
      const target = await pathFor(path);
      const kind = explicit ? fileKind(await stat(target)) : await localKind(target);
      return kind === undefined ? undefined : { path, kind };
    } catch {
      return { path, kind: "missing" };
    }
  }));
  return results.filter(item => item !== undefined);
}
