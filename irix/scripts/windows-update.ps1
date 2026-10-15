# Installs or updates Irix from the seven irix-*.tgz files in a folder, then starts the daemon.
#
#   powershell -ExecutionPolicy Bypass -File .\windows-update.ps1             # tarballs in this folder
#   powershell -ExecutionPolicy Bypass -File .\windows-update.ps1 -Path D:\irix-dist
#   powershell -ExecutionPolicy Bypass -File .\windows-update.ps1 -DryRun     # only print the steps
#
# The steps, in order:
#   1. irix daemon stop      Windows locks the files of a running daemon, so stop it first.
#                            Skipped when irix is not installed or the daemon is not running.
#   2. npm uninstall -g ...  Removes the old seven packages so no old files are left behind.
#   3. npm install -g ...    All seven tarballs together, so npm never fetches upstream packages.
#   4. irix daemon start     Starts the daemon hidden in the background and returns.
#
# ONNXRUNTIME_NODE_INSTALL=skip is set for this run only: it skips a large voice download that
# Irix does not use and that can stall on a company network.
param(
  [string]$Path = (Get-Location).Path,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$packages = "cli", "server", "client", "protocol", "relay", "plugin", "highlight"

# Only the seven packages, and one file for each. A folder such as ~/irix-dist also holds other
# irix-*.tgz files (a plugin bundle, say), and a folder an earlier bundle was unzipped into holds
# older builds of the same packages; the newest of each package is the one installed.
$files = @(
  foreach ($package in $packages) {
    Get-ChildItem -Path $Path -Filter "irix-$package-*.tgz" |
      Where-Object { $_.Name -match "^irix-$package-\d" } |
      Sort-Object -Property LastWriteTime -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
)
if ($files.Count -ne $packages.Count) {
  $missing = $packages | Where-Object { -not ($files -match "irix-$_-\d") }
  throw "Expected one irix-<package>-<version>.tgz for each of $($packages -join ', ') in '$Path'. Missing: $($missing -join ', '). All seven must be installed together."
}

function Step([string]$Title, [scriptblock]$Action, [switch]$MayFail) {
  Write-Host "==> $Title"
  if ($DryRun) { return }
  # A native command that writes to stderr (a daemon that is not running says so there) is an
  # error under "Stop" in Windows PowerShell 5.1, and a missing command is one in any version. A
  # step that may fail must survive both; the other steps must report them.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $global:LASTEXITCODE = 0
  try {
    & $Action
    $failed = $LASTEXITCODE -ne 0
    $reason = "exit code $LASTEXITCODE"
  } catch {
    $failed = $true
    $reason = $_.Exception.Message
  } finally {
    $ErrorActionPreference = $previous
  }
  $global:LASTEXITCODE = 0
  if ($failed -and $MayFail) { Write-Host "    (skipped: $reason)" }
  elseif ($failed) { throw "'$Title' failed ($reason)" }
}

function Has([string]$Command) { [bool](Get-Command $Command -ErrorAction SilentlyContinue) }

if (-not (Has "npm")) {
  throw "npm was not found. Install Node.js first (see INSTALL-WINDOWS.md), then open a new PowerShell window."
}

# First install, or Irix already uninstalled: there is no command to stop a daemon with, and
# nothing to uninstall. A daemon that is still running without its command would keep Windows
# from replacing its files, so say so rather than fail later with an obscure npm error.
if (Has "irix") {
  Step "irix daemon stop" { irix daemon stop } -MayFail
} else {
  Write-Host "==> irix is not installed; nothing to stop"
  $listener = $null
  try {
    $listener = Get-NetTCPConnection -LocalPort 6890 -State Listen -ErrorAction Stop |
      Select-Object -First 1
  } catch {
    # Nothing listens there, or the check is unavailable: either way there is nothing to warn about.
  }
  if ($listener) {
    Write-Warning "Something is listening on port 6890 (process id $($listener.OwningProcess)), probably an old daemon whose command is gone. If the install below fails with EBUSY or EPERM, stop it: Stop-Process -Id $($listener.OwningProcess)"
  }
}
Step "npm uninstall -g (old packages)" {
  npm uninstall -g ($packages | ForEach-Object { "@irix/$_" })
} -MayFail

$env:ONNXRUNTIME_NODE_INSTALL = "skip"
Step "npm install -g ($($files.Count) tarballs)" { npm install -g $files }

# npm's global folder is on PATH for most Node.js installs, but not for every one; on a first
# install this is where it shows.
if (-not $DryRun -and -not (Has "irix")) {
  $prefix = (npm prefix -g).Trim()
  throw "Installed, but the irix command is not on PATH. Add '$prefix' to your PATH (or open a new PowerShell window), then run: irix daemon start"
}
Step "irix --version" { irix --version }
Step "irix daemon start" { irix daemon start }

if ($DryRun) { Write-Host "Dry run: nothing was changed." }
