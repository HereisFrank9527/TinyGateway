param(
  [switch]$NoCommit,
  [switch]$Draft
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
Set-Location -LiteralPath $root

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI is not installed. Install gh and run: gh auth login"
}

$version = (Get-Content -Raw -Encoding UTF8 VERSION).Trim()
if (-not ($version -match '^\d+\.\d+\.\d+([.-][0-9A-Za-z]+)?$')) {
  throw "VERSION must look like 0.1.0 or 0.1.0-beta. Current: $version"
}

$tag = "v$version"
$zip = Join-Path $root "dist\TinyGateway-portable.zip"

Write-Host "[TinyGateway] Checking GitHub auth..."
Invoke-Checked gh auth status

Write-Host "[TinyGateway] Running tests..."
Invoke-Checked npm test

Write-Host "[TinyGateway] Building portable package..."
Invoke-Checked npm run build:portable

if (-not (Test-Path -LiteralPath $zip)) {
  throw "Missing release asset: $zip"
}

if (-not $NoCommit) {
  Write-Host "[TinyGateway] Staging release files..."
  Invoke-Checked git add -- .
  Invoke-Checked git commit -m "release: $tag"
}

Write-Host "[TinyGateway] Creating tag $tag..."
Invoke-Checked git tag $tag

Write-Host "[TinyGateway] Pushing branch and tag..."
$branch = (git branch --show-current).Trim()
if (-not $branch) {
  throw "Unable to determine current git branch."
}

$upstream = (git for-each-ref --format="%(upstream:short)" "refs/heads/$branch").Trim()
if ($upstream) {
  Invoke-Checked git push
} else {
  Invoke-Checked git push -u origin $branch
}
Invoke-Checked git push origin $tag

$releaseArgs = @(
  "release", "create", $tag,
  $zip,
  "--repo", "HereisFrank9527/TinyGateway",
  "--title", $tag,
  "--notes", "TinyGateway portable release $tag"
)
if ($Draft) {
  $releaseArgs += "--draft"
}

Write-Host "[TinyGateway] Creating GitHub release..."
& gh @releaseArgs
if ($LASTEXITCODE -ne 0) {
  throw "gh release create failed with exit code $LASTEXITCODE"
}

Write-Host "[TinyGateway] Release complete: $tag"
