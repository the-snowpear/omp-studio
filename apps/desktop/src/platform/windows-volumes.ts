import { execFile } from "node:child_process";
import type { SystemPlaces } from "@omp-studio/client-contract";

// Publish the assigned drive letters before asking any device for capacity.
// A disconnected mount can block a Windows filesystem call beyond the UI deadline.
const probe = `
$roots = [Environment]::GetLogicalDrives()
[Console]::WriteLine(($roots -join '|'))
$sizeGetter = [IO.DriveInfo].GetProperty('TotalSize').GetGetMethod()
$freeGetter = [IO.DriveInfo].GetProperty('AvailableFreeSpace').GetGetMethod()
$factory = [Threading.Tasks.Task[long]]::Factory
$reads = foreach ($root in $roots) {
  $drive = [IO.DriveInfo]::new($root)
  [PSCustomObject]@{
    Root = $root
    Size = $factory.StartNew($sizeGetter.CreateDelegate([Func[long]], $drive))
    Free = $factory.StartNew($freeGetter.CreateDelegate([Func[long]], $drive))
  }
}
# A slow device must not prevent later drive letters from reporting free space.
$tasks = [Threading.Tasks.Task[]]@($reads | ForEach-Object { $_.Size; $_.Free })
try { [void][Threading.Tasks.Task]::WaitAll($tasks, 400) } catch {}
foreach ($read in $reads) {
  if ($read.Size.Status -eq 'RanToCompletion' -and $read.Free.Status -eq 'RanToCompletion') {
    [Console]::WriteLine("$($read.Root)|$($read.Size.Result)|$($read.Free.Result)")
  }
}`;

type Volumes = SystemPlaces["volumes"];
let pending: Promise<Volumes> | undefined;

function probeWindowsVolumes(): Promise<Volumes> {
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe],
      { windowsHide: true, timeout: 3000, encoding: "utf8" }, (_error, stdout) => {
        // Only consume complete lines if the capacity deadline stopped the helper.
        const lines = stdout.split(/\r?\n/u);
        lines.pop();
        const roots = lines.shift()?.split("|").filter(Boolean) ?? [];
        const volumes = new Map<string, Volumes[number]>(roots.map(path => [path, { path, label: path.slice(0, 2), ready: false }]));
        for (const line of lines) {
          const [path, total, free] = line.split("|");
          const volume = volumes.get(path ?? "");
          if (volume) volumes.set(volume.path, { ...volume, totalBytes: Number(total), freeBytes: Number(free), ready: true });
        }
        resolve([...volumes.values()]);
      });
  });
}

export function windowsVolumes(): Promise<Volumes> {
  return pending ??= probeWindowsVolumes().finally(() => { pending = undefined; });
}
