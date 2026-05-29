param(
  [string]$OutputDir = "dist\TinyGateway"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$output = Join-Path $root $OutputDir
$distRoot = Split-Path -Parent $output
$zipPath = Join-Path $distRoot "TinyGateway-portable.zip"

if (Test-Path -LiteralPath $output) {
  Remove-Item -LiteralPath $output -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $output | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $output "logs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $output "runtime") | Out-Null

Copy-Item -LiteralPath (Join-Path $root "src") -Destination (Join-Path $output "src") -Recurse
Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination (Join-Path $output "package.json")
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination (Join-Path $output "README.md")
Copy-Item -LiteralPath (Join-Path $root "config.example.json") -Destination (Join-Path $output "config.example.json")
Copy-Item -LiteralPath (Join-Path $root "VERSION") -Destination (Join-Path $output "VERSION")

$startBat = @(
  "@echo off",
  "setlocal",
  "cd /d ""%~dp0""",
  "set TG_URL=http://127.0.0.1:8787",
  "",
  "where node >nul 2>nul",
  "if errorlevel 1 (",
  "  echo [TinyGateway] Node.js 20+ not found.",
  "  echo Please install Node.js LTS, then run this file again.",
  "  pause",
  "  exit /b 1",
  ")",
  "",
  "if not exist config.json (",
  "  copy config.example.json config.json >nul",
  "  echo [TinyGateway] Created config.json from config.example.json.",
  "  echo Configure API keys in the admin UI or edit config.json directly.",
  ")",
  "",
  "powershell -NoProfile -ExecutionPolicy Bypass -Command ""try { Invoke-RestMethod '%TG_URL%/health' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }""",
  "if not errorlevel 1 (",
  "  echo [TinyGateway] Already running: %TG_URL%/admin",
  "  start """" ""%TG_URL%/admin""",
  "  exit /b 0",
  ")",
  "",
  "echo [TinyGateway] Starting: %TG_URL%/admin",
  "echo %DATE% %TIME% > runtime\last-start.txt",
  "start ""TinyGateway"" /min cmd /c ""node src\server.js 1>>logs\gateway.out.log 2>>logs\gateway.err.log""",
  "timeout /t 2 /nobreak >nul",
  "powershell -NoProfile -ExecutionPolicy Bypass -Command ""try { Invoke-RestMethod '%TG_URL%/health' -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }""",
  "if errorlevel 1 (",
  "  echo [TinyGateway] Failed to start. See logs\gateway.err.log",
  "  type logs\gateway.err.log",
  "  pause",
  "  exit /b 1",
  ")",
  "start """" ""%TG_URL%/admin""",
  "echo [TinyGateway] Running. Logs: logs\gateway.out.log logs\gateway.err.log",
  "pause"
)
Set-Content -LiteralPath (Join-Path $output "start.bat") -Encoding ASCII -Value $startBat

$stopBat = @(
  "@echo off",
  "setlocal",
  "cd /d ""%~dp0""",
  "set TG_URL=http://127.0.0.1:8787",
  "powershell -NoProfile -ExecutionPolicy Bypass -Command ""try { Invoke-RestMethod -Method Post '%TG_URL%/api/admin/shutdown' -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }""",
  "if errorlevel 1 (",
  "  echo [TinyGateway] Stop request failed. It may not be running.",
  "  exit /b 1",
  ")",
  "echo [TinyGateway] Stop requested.",
  "exit /b 0"
)
Set-Content -LiteralPath (Join-Path $output "stop.bat") -Encoding ASCII -Value $stopBat

$restartBat = @(
  "@echo off",
  "setlocal",
  "cd /d ""%~dp0""",
  "call stop.bat",
  "timeout /t 2 /nobreak >nul",
  "call start.bat"
)
Set-Content -LiteralPath (Join-Path $output "restart.bat") -Encoding ASCII -Value $restartBat

$openAdminBat = @(
  "@echo off",
  "start """" ""http://127.0.0.1:8787/admin"""
)
Set-Content -LiteralPath (Join-Path $output "open-admin.bat") -Encoding ASCII -Value $openAdminBat

New-Item -ItemType Directory -Force -Path (Join-Path $output "scripts") | Out-Null

$updatePs1 = @(
  '$ErrorActionPreference = "Stop"',
  '$repo = "HereisFrank9527/TinyGateway"',
  '$root = Split-Path -Parent $PSScriptRoot',
  '$api = "https://api.github.com/repos/$repo/releases/latest"',
  'Write-Host "[TinyGateway] Checking latest release..."',
  '$release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "TinyGateway-Updater" }',
  '$asset = $release.assets | Where-Object { $_.name -match "portable.*\.zip$" -or $_.name -eq "TinyGateway-portable.zip" } | Select-Object -First 1',
  'if (-not $asset) { throw "Latest release does not contain TinyGateway portable zip asset." }',
  '$tmp = Join-Path $env:TEMP ("TinyGateway-update-" + [guid]::NewGuid())',
  '$zip = Join-Path $tmp $asset.name',
  '$extract = Join-Path $tmp "extract"',
  'New-Item -ItemType Directory -Force -Path $tmp,$extract | Out-Null',
  'Write-Host "[TinyGateway] Downloading $($release.tag_name)..."',
  'Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers @{ "User-Agent" = "TinyGateway-Updater" }',
  'Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force',
  '$source = Join-Path $extract "TinyGateway"',
  'if (-not (Test-Path -LiteralPath $source)) { $source = $extract }',
  '$backup = Join-Path $tmp "backup"',
  'New-Item -ItemType Directory -Force -Path $backup | Out-Null',
  'foreach ($name in @("config.json", "logs", "runtime")) {',
  '  $path = Join-Path $root $name',
  '  if (Test-Path -LiteralPath $path) { Move-Item -LiteralPath $path -Destination (Join-Path $backup $name) -Force }',
  '}',
  'Get-ChildItem -LiteralPath $source -Force | ForEach-Object {',
  '  $target = Join-Path $root $_.Name',
  '  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }',
  '  Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force',
  '}',
  'foreach ($name in @("config.json", "logs")) {',
  '  $saved = Join-Path $backup $name',
  '  if (Test-Path -LiteralPath $saved) {',
  '    $target = Join-Path $root $name',
  '    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }',
  '    Move-Item -LiteralPath $saved -Destination $target -Force',
  '  }',
  '}',
  '$savedRuntime = Join-Path $backup "runtime"',
  'if (Test-Path -LiteralPath $savedRuntime) {',
  '  New-Item -ItemType Directory -Force -Path (Join-Path $root "runtime") | Out-Null',
  '  Get-ChildItem -LiteralPath $savedRuntime -Force | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $root "runtime" $_.Name) -Force }',
  '}',
  'Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue',
  'Write-Host "[TinyGateway] Updated to $($release.tag_name)."',
  'Write-Host "[TinyGateway] Run start.bat to start the gateway."'
)
Set-Content -LiteralPath (Join-Path $output "scripts\update-portable.ps1") -Encoding UTF8 -Value $updatePs1

$updateBat = @(
  "@echo off",
  "setlocal",
  "cd /d ""%~dp0""",
  "call stop.bat",
  "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update-portable.ps1",
  "pause"
)
Set-Content -LiteralPath (Join-Path $output "update.bat") -Encoding ASCII -Value $updateBat

$readme = @(
  "TinyGateway portable build",
  "",
  "Plain command startup is still supported in the project root:",
  "  npm start",
  "  node src\server.js",
  "",
  "Portable commands:",
  "- start.bat: start TinyGateway if it is not running, then open admin UI",
  "- stop.bat: request local shutdown",
  "- restart.bat: stop then start",
  "- open-admin.bat: open http://127.0.0.1:8787/admin",
  "- update.bat: download latest GitHub Release portable zip and update local files",
  "",
  "On first run, config.json is created from config.example.json.",
  "Configure Provider, API Key, model list, and model mappings in the admin UI.",
  "",
  "Note: this portable build still requires Node.js 20+ installed on this machine."
)
Set-Content -LiteralPath (Join-Path $output "README-portable.txt") -Encoding UTF8 -Value $readme

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -LiteralPath $output -DestinationPath $zipPath -Force

Write-Host "Portable build created: $output"
Write-Host "Portable zip created: $zipPath"
