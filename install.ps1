param(
  [switch]$DryRun,
  [ValidateSet("auto", "bun", "node")]
  [string]$Runtime
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PackageName = "repo-harness"
$PackageVersion = if ($env:REPO_HARNESS_VERSION) { $env:REPO_HARNESS_VERSION } else { "latest" }
$InstallRuntime = if ($Runtime) { $Runtime.ToLowerInvariant() } elseif ($env:REPO_HARNESS_INSTALL_RUNTIME) { $env:REPO_HARNESS_INSTALL_RUNTIME.ToLowerInvariant() } else { "auto" }
$MinimumNodeVersion = [version]"20.10.0"
$BunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME ".bun" }
$BunBin = Join-Path $BunInstall "bin"

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Add-PathEntry([string]$PathEntry) {
  if ($PathEntry -and (Test-Path $PathEntry)) {
    $entries = $env:PATH -split [System.IO.Path]::PathSeparator
    if ($entries -notcontains $PathEntry) {
      $env:PATH = "$PathEntry$([System.IO.Path]::PathSeparator)$env:PATH"
    }
  }
}

function Refresh-InstallerPath {
  Add-PathEntry $BunBin
  if ($env:APPDATA) { Add-PathEntry (Join-Path $env:APPDATA "npm") }
  if (Test-Command "npm") {
    $npmPrefix = (& npm config get prefix 2>$null | Select-Object -First 1).Trim()
    Add-PathEntry $npmPrefix
  }
}

function Assert-Prerequisites {
  if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    throw "PowerShell 5.1 or newer is required. PowerShell 7 is recommended."
  }
  if (-not (Test-Command "git")) {
    throw "Git is required. Install Git for Windows, reopen PowerShell, and rerun this installer."
  }
  if (-not (Test-Command "node")) {
    throw "Node.js 20.10 or newer is required because the published repo-harness launcher uses Node."
  }
  $nodeText = (& node -p "process.versions.node").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $nodeText) {
    throw "Node.js is present, but its version could not be read."
  }
  $nodeVersion = [version]$nodeText
  if ($nodeVersion -lt $MinimumNodeVersion) {
    throw "Node.js 20.10 or newer is required; found $nodeVersion."
  }
}

function Install-BunIfNeeded {
  if (Test-Command "bun") { return }
  Write-Host "Installing Bun runtime..."
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  Refresh-InstallerPath
  if (-not (Test-Command "bun")) {
    throw "Bun installation completed, but bun is still not on PATH. Reopen PowerShell or add $BunBin to PATH."
  }
}

function Select-InstallRuntime {
  switch ($InstallRuntime) {
    "bun" {
      Install-BunIfNeeded
      return "bun"
    }
    "node" {
      if (-not (Test-Command "npm")) { throw "npm is required for REPO_HARNESS_INSTALL_RUNTIME=node." }
      return "node"
    }
    "auto" {
      if (Test-Command "bun") { return "bun" }
      if (Test-Command "npm") { return "node" }
      throw "Neither Bun nor npm is available. Install Bun or reinstall Node.js with npm."
    }
    default {
      throw "Invalid REPO_HARNESS_INSTALL_RUNTIME=$InstallRuntime. Expected auto, bun, or node."
    }
  }
}

if ($DryRun -or $env:REPO_HARNESS_DRY_RUN -eq "1") {
  Write-Host "DRY RUN: would require Git and Node.js 20.10+, choose runtime ($InstallRuntime), install $PackageName@$PackageVersion, and verify the CLI."
  exit 0
}

Refresh-InstallerPath
Assert-Prerequisites
$Runtime = Select-InstallRuntime
$PackageSpec = "$PackageName@$PackageVersion"

if ($Runtime -eq "bun") {
  Write-Host "Installing $PackageSpec with Bun..."
  & bun add -g $PackageSpec
} else {
  Write-Host "Installing $PackageSpec with npm..."
  & npm install -g $PackageSpec --omit=optional --no-audit --no-fund
}
if ($LASTEXITCODE -ne 0) { throw "Package installation failed with exit code $LASTEXITCODE." }

Refresh-InstallerPath
if (-not (Test-Command "repo-harness")) {
  throw "repo-harness is not on PATH after installation. Reopen PowerShell or add the package-manager global bin directory to PATH."
}

$Version = (& repo-harness --version | Select-Object -First 1).Trim()
if ($LASTEXITCODE -ne 0 -or -not $Version) {
  throw "repo-harness installed, but version readback failed."
}
& repo-harness doctor --help *> $null
if ($LASTEXITCODE -ne 0) { throw "repo-harness installed, but the doctor command could not be loaded." }

Write-Host "repo-harness $Version installed."
Write-Host ""
Write-Host "Next:"
Write-Host "  repo-harness install --no-cli"
Write-Host "  repo-harness doctor"
Write-Host "  repo-harness adopt --repo C:\path\to\your-project --dry-run"
