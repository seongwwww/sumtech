param([string]$DataDirectory = $env:LOCALAPPDATA, [string]$StateDirectory = '')
$ErrorActionPreference = 'Stop'
if (-not $StateDirectory) { $StateDirectory = Join-Path $DataDirectory 'BuzzBridge/runner' }
$statePath = Join-Path $StateDirectory 'runner.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'STOPPED'; exit 0 }
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ($state.instance -notmatch '^[a-f0-9]{32}$' -or $state.pid -le 0) { throw 'Invalid runner record.' }
$owned = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)" -ErrorAction SilentlyContinue
if (-not $owned -or $owned.Name -ne 'node.exe' -or $owned.CommandLine -notlike "*host.mjs*$($state.instance)*") { throw 'STALE: recorded PID is absent or belongs to another process.' }
Write-Output "RUNNING pid=$($state.pid) agent=$($state.agent) mode=$($state.mode)"
Write-Output "LOG=$($state.stdout) ERRORS=$($state.stderr)"
Write-Output "CONFIG=$($state.config) DATA=$($state.data_directory)"
