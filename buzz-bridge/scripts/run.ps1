param(
  [ValidateSet('codex','claude')][string]$Agent = 'codex',
  [ValidateSet('listen','notifications')][string]$Mode = 'listen',
  [string]$WatchConfig = '',
  [string]$Config = $env:BUZZ_BRIDGE_CONFIG,
  [string]$DataDirectory = $env:LOCALAPPDATA,
  [string]$StateDirectory = ''
)
$ErrorActionPreference = 'Stop'
$hostScript = Join-Path $PSScriptRoot 'host.mjs'
if ($Config) { $Config = (Resolve-Path -LiteralPath $Config).Path }
if (-not $DataDirectory) { throw 'DataDirectory or LOCALAPPDATA is required.' }
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
if (-not $StateDirectory) { $StateDirectory = Join-Path $DataDirectory 'BuzzBridge/runner' }
if ($Mode -eq 'notifications' -and -not $WatchConfig) { throw 'Notifications mode requires -WatchConfig.' }
if ($WatchConfig) { $WatchConfig = (Resolve-Path -LiteralPath $WatchConfig).Path }
New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
$StateDirectory = (Resolve-Path -LiteralPath $StateDirectory).Path
$statePath = Join-Path $StateDirectory 'runner.json'
$launchLock = Join-Path $StateDirectory 'launch.lock'
try { $handle = [IO.File]::Open($launchLock, 'CreateNew', 'Write', 'None') }
catch { throw 'Concurrent launch or stale launch.lock; inspect before retrying.' }
try {
  if (Test-Path -LiteralPath $statePath) {
    $prior = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $priorProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($prior.pid)" -ErrorAction SilentlyContinue
    if ($priorProcess -and $priorProcess.CommandLine -like "*$($prior.instance)*") { throw 'Bridge already running.' }
    throw 'Stale runner.json. Inspect recorded process and archive the record before restart.'
  }
  $instance = [guid]::NewGuid().ToString('N')
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $stdout = Join-Path $StateDirectory 'stdout.log'
  $stderr = Join-Path $StateDirectory 'stderr.log'
  $launcher = Join-Path $PSScriptRoot 'launch.mjs'
  $pidFile = Join-Path $StateDirectory ('pid-' + $instance)
  $launchArgs = @($launcher, $hostScript, $instance, $Mode, $Agent, $StateDirectory, $WatchConfig, $stdout, $stderr, $pidFile, $Config, $DataDirectory) | ForEach-Object { '"' + $_ + '"' }
  $launchProcess = Start-Process -FilePath $node -ArgumentList ($launchArgs -join ' ') -PassThru -WindowStyle Hidden
  if (-not $launchProcess.WaitForExit(5000)) { throw 'Managed launcher did not exit.' }
  if ($launchProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $pidFile)) { throw 'Managed host launch failed.' }
  $processId = [IO.File]::ReadAllText($pidFile)
  Remove-Item -LiteralPath $pidFile
  if ($processId -notmatch '^\d+$') { throw 'Invalid managed host PID.' }
  $process = Get-Process -Id ([int]$processId) -ErrorAction Stop
  $record = @{ pid = $process.Id; instance = $instance; agent = $Agent; mode = $Mode; config = $Config; data_directory = $DataDirectory; started_at = [DateTime]::UtcNow.ToString('o'); stdout = $stdout; stderr = $stderr } | ConvertTo-Json
  [IO.File]::WriteAllText($statePath, $record, (New-Object Text.UTF8Encoding $false))
  Start-Sleep -Milliseconds 700
  $process.Refresh()
  if ($process.HasExited) { throw "Bridge exited during startup. Inspect $stderr" }
  & (Join-Path $PSScriptRoot 'status.ps1') -StateDirectory $StateDirectory
} finally {
  $handle.Dispose()
  Remove-Item -LiteralPath $launchLock
}
