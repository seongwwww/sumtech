param([string]$DataDirectory = $env:LOCALAPPDATA, [string]$StateDirectory = '')
$ErrorActionPreference = 'Stop'
if (-not $StateDirectory) { $StateDirectory = Join-Path $DataDirectory 'BuzzBridge/runner' }
$statePath = Join-Path $StateDirectory 'runner.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'STOPPED'; exit 0 }
& (Join-Path $PSScriptRoot 'status.ps1') -StateDirectory $StateDirectory
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$stopPath = Join-Path $StateDirectory ('stop-' + $state.instance)
[IO.File]::WriteAllText($stopPath, 'stop')
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ((Test-Path -LiteralPath $statePath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
if (Test-Path -LiteralPath $statePath) { throw 'Stop not acknowledged. Inspect runner and child processes; record retained.' }
Write-Output 'STOPPED'
