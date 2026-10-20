# ClearCare desktop launcher (Windows).
# Starts the local ClearCare server hidden, opens ClearCare in its own application window
# (Microsoft Edge "app" mode: no tabs, no address bar), and stops the server when the window closes.
param([switch]$CreateShortcut)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Set-Location -LiteralPath $PSScriptRoot
function Fail($msg) { [System.Windows.MessageBox]::Show($msg, 'ClearCare', 'OK', 'Error') | Out-Null; exit 1 }

# Optional settings from .env (GEMINI_API_KEY, GEMINI_MODEL, PORT). Lines starting with # are ignored.
if (Test-Path -LiteralPath '.env') {
  $allowedSettings = @('GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_MIN_INTERVAL_MS', 'PORT', 'CLEARCARE_GEMINI_BASE_URL', 'CLEARCARE_TRANSLATION_CACHE')
  foreach ($line in Get-Content -LiteralPath '.env') {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$' -and $Matches[1] -in $allowedSettings) { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim().Trim('"', "'"), 'Process') }
  }
}
if ($CreateShortcut) {
  $ws = New-Object -ComObject WScript.Shell
  $targets = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
  foreach ($dir in $targets) {
    $lnk = $ws.CreateShortcut((Join-Path $dir 'ClearCare.lnk'))
    $lnk.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $lnk.WorkingDirectory = $PSScriptRoot
    $lnk.IconLocation = (Join-Path $PSScriptRoot 'clearcare.ico')
    $lnk.Description = 'ClearCare - understand my care instructions'
    $lnk.WindowStyle = 7
    $lnk.Save()
  }
  [System.Windows.MessageBox]::Show('ClearCare shortcut created on your Desktop and in the Start menu.', 'ClearCare') | Out-Null
  exit 0
}
if (-not $env:PORT) { $env:PORT = '4174' }
$base = "http://127.0.0.1:$($env:PORT)"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js is not installed.`nInstall Node.js 22 LTS from https://nodejs.org and open ClearCare again." }

$dataDir = Join-Path $env:LOCALAPPDATA 'ClearCare'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Test-Server { try { (Invoke-WebRequest -Uri "$base/api/health" -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200 } catch { $false } }

$server = $null
if (-not (Test-Server)) {
  $server = Start-Process -FilePath $node.Source -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log')
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; if (Test-Server) { $ok = $true; break } }
  if (-not $ok) { if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }; Fail "ClearCare could not start.`nPort $($env:PORT) may be in use. See $dataDir\server-error.log" }
}

$candidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $browser) { if ($server) { Stop-Process -Id $server.Id -Force }; Fail 'Microsoft Edge or Google Chrome is required to show the ClearCare window.' }

# A dedicated profile keeps ClearCare's window, voices and saved preferences separate from normal browsing.
$profileDir = Join-Path $dataDir 'window-profile'
$winArgs = @("--app=$base/#today", "--user-data-dir=`"$profileDir`"", '--window-size=1366,900', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate')
$window = Start-Process -FilePath $browser -ArgumentList $winArgs -PassThru
$window.WaitForExit()
# Wait for any remaining process that uses ClearCare's profile, then stop the server we started.
while (Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$profileDir*" }) { Start-Sleep -Seconds 1 }
if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
