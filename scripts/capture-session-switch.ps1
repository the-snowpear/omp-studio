param(
  [int]$RootProcessId = 0,
  [ValidateRange(3, 600)][int]$DurationSeconds = 120,
  [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
if ($RootProcessId -eq 0) {
  $previewExecutables = @(
    [IO.Path]::GetFullPath((Join-Path $repository 'outputs/preview-electron/electron.exe')),
    [IO.Path]::GetFullPath((Join-Path $repository 'node_modules/electron/dist/electron.exe'))
  )
  # Window titles and MainWindowHandle are not process identity: opening DevTools,
  # minimizing, or changing the current document can change them.
  $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe' OR Name = 'OMP Studio.exe' OR Name = 'omp-studio.exe'" | Where-Object {
    $command = [string]$_.CommandLine
    if ($command -match '(?:^|[\s"])--type(?:=|[\s"])') { return $false }
    $preview = $_.Name -eq 'electron.exe' -and $previewExecutables -contains [string]$_.ExecutablePath
    $product = $_.Name -in @('OMP Studio.exe', 'omp-studio.exe')
    $preview -or $product
  })
  if ($candidates.Count -eq 0) { throw 'No OMP main process was identified. Open the current build, or specify -RootProcessId explicitly.' }
  if ($candidates.Count -eq 1) { $RootProcessId = $candidates[0].ProcessId }
  else {
    Write-Host 'More than one OMP Studio main process was found. Choose the application you are testing:'
    $candidates | Select-Object ProcessId, Name | Format-Table | Out-Host
    $RootProcessId = [int](Read-Host 'Main process ID')
    if ($RootProcessId -notin $candidates.ProcessId) { throw 'The selected process is not one of the displayed OMP applications.' }
  }
}
$directory = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repository 'outputs/perf/manual-session-switch' }
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
$output = Join-Path $directory ('processes-' + $stamp + '.jsonl')
Write-Host ''
Write-Host ('Selected main process: ' + $RootProcessId)
Write-Host ('Recording the selected app for up to ' + $DurationSeconds + ' seconds. No app process will be started or stopped.')
Write-Host 'Now paste scripts/manual-session-switch-capture.js into the OMP DevTools Console, then close DevTools.'
Write-Host 'That script records for 60 seconds: idle, A/B switching, different sessions, then idle.'
Write-Host ('Put its downloaded JSON in: ' + $directory)
Write-Host ''
& (Join-Path $PSScriptRoot 'sample-session-processes.ps1') -RootProcessId $RootProcessId -DurationSeconds $DurationSeconds -OutputPath $output
Write-Host ''
Write-Host 'Finished. Leave both the JSON and JSONL files in the output folder and tell the assistant capture is complete.'
