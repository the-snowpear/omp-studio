param(
  [Parameter(Mandatory = $true)][int]$RootProcessId,
  [ValidateRange(1, 3600)][int]$DurationSeconds = 60,
  [ValidateRange(1, 30)][int]$IntervalSeconds = 1,
  [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) { throw 'The requested app process is no longer running.' }
if (-not $OutputPath) {
  $directory = Join-Path (Split-Path $PSScriptRoot -Parent) 'outputs/perf'
  $OutputPath = Join-Path $directory ('session-processes-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + '.jsonl')
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path $OutputPath) { throw 'Refusing to overwrite an existing recording.' }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
$writer = [IO.StreamWriter]::new($OutputPath, $false, [Text.UTF8Encoding]::new($false))
$startedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$watch = [Diagnostics.Stopwatch]::StartNew()
$previous = @{}
try {
  $writer.WriteLine((@{ type = 'metadata'; version = 1; startedAtUnixMs = $startedAtUnixMs; logicalCores = [Environment]::ProcessorCount; durationSeconds = $DurationSeconds; intervalSeconds = $IntervalSeconds } | ConvertTo-Json -Compress))
  while ($watch.Elapsed.TotalSeconds -lt $DurationSeconds) {
    $rows = @(Get-CimInstance Win32_Process)
    $root = $rows | Where-Object { $_.ProcessId -eq $RootProcessId } | Select-Object -First 1
    if (-not $root) { $writer.WriteLine((@{ type = 'root-exited'; atMs = $watch.ElapsedMilliseconds } | ConvertTo-Json -Compress)); break }
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootProcessId)
    do {
      $added = $false
      foreach ($row in $rows) { if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added = $true } }
    } while ($added)
    $privateWorkingSets = @{}
    try {
      $filter = ($ids | ForEach-Object { 'IDProcess = ' + $_ }) -join ' OR '
      foreach ($counter in (Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter $filter -Property IDProcess, WorkingSetPrivate)) {
        $privateWorkingSets[[int]$counter.IDProcess] = [long]$counter.WorkingSetPrivate
      }
    } catch { <# Optional Windows counter; omit unavailable values rather than report a false zero. #> }
    $groups = @{}
    $processes = @()
    foreach ($row in $rows) {
      if (-not $ids.Contains([int]$row.ProcessId)) { continue }
      $process = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
      if (-not $process) { continue }
      $command = [string]$row.CommandLine
      $role = if ($row.ProcessId -eq $RootProcessId) { 'main' }
        elseif ($command.Contains('--type=gpu-process')) { 'gpu' }
        elseif ($command.Contains('--type=renderer')) { 'renderer' }
        elseif ($command.Contains('network.mojom.NetworkService')) { 'network' }
        elseif ($command.Contains('--studio-session-telemetry-probe')) { 'telemetry-probe' }
        elseif ($row.Name -eq 'omp.exe' -or $command.Contains('--mode studio-host')) { 'runtime' }
        else { 'other-child' }
      if (-not $groups.ContainsKey($role)) { $groups[$role] = @{ count = 0; workingSetBytes = 0L; privateWorkingSetBytes = 0L; privateCommitBytes = 0L; cpuCorePercent = 0.0; cpuMachinePercent = 0.0 } }
      $group = $groups[$role]
      $group.count++; $group.workingSetBytes += $process.WorkingSet64; $group.privateCommitBytes += $process.PrivateMemorySize64
      if ($group.ContainsKey('privateWorkingSetBytes')) {
        if ($privateWorkingSets.ContainsKey([int]$row.ProcessId)) { $group.privateWorkingSetBytes += $privateWorkingSets[[int]$row.ProcessId] }
        else { $group.Remove('privateWorkingSetBytes') }
      }
      $stamp = $watch.Elapsed.TotalMilliseconds
      $cpu = $process.TotalProcessorTime.TotalMilliseconds
      $key = [int]$row.ProcessId
      if ($previous.ContainsKey($key)) {
        $delta = $stamp - $previous[$key].at
        if ($delta -gt 0) {
          $percent = [Math]::Max(0.0, ($cpu - $previous[$key].cpu) / $delta * 100)
          $group.cpuCorePercent += $percent; $group.cpuMachinePercent += $percent / [Environment]::ProcessorCount
        }
      }
      $previous[$key] = @{ at = $stamp; cpu = $cpu }
      $processes += @{ pid = [int]$row.ProcessId; parentPid = [int]$row.ParentProcessId; role = $role;
        startedAtUnixMs = ([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds();
        workingSetBytes = $process.WorkingSet64; privateCommitBytes = $process.PrivateMemorySize64;
        privateWorkingSetBytes = $privateWorkingSets[[int]$row.ProcessId]; cpuTotalMs = $cpu }
    }
    $writer.WriteLine((@{ type = 'sample'; atMs = $watch.ElapsedMilliseconds; roles = $groups; processes = $processes } | ConvertTo-Json -Compress -Depth 5))
    $writer.Flush()
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally { $writer.Dispose() }
Write-Output ('Numeric process recording saved: ' + $OutputPath)
