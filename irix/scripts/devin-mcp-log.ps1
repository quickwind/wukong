# Collects what Devin's own log says about MCP servers, to find out why Devin ignores the servers
# Paseo/Irix hands it (an old Devin, or a team policy).
#
#   Run devin-mcp-probe.mjs first (node devin-mcp-probe.mjs --out probe-mcp.txt), then:
#   powershell -ExecutionPolicy Bypass -File .\devin-mcp-log.ps1
#
# Writes mcp-lines.txt next to where you run it (UTF-8). It holds: the Devin version, the log files it
# looked at, and the lines of the newest logs that mention mcp, policy, allowlist, blocked or denied.
# Bearer tokens and token/key/secret values are replaced with *** before anything is written.
# It reads only Devin's *.log files; it never opens Devin's credentials.
param(
  [string]$Out = "mcp-lines.txt",
  [int]$Logs = 4,
  [int]$MaxLines = 80
)

$ErrorActionPreference = "Continue"
$report = New-Object System.Collections.Generic.List[string]

$report.Add("== devin --version")
try { $report.Add(((devin --version 2>&1) | Out-String).Trim()) } catch { $report.Add("could not run devin: $($_.Exception.Message)") }

# Devin keeps its logs in a folder named "devin" (Windows: under %LOCALAPPDATA% or %APPDATA%; elsewhere
# ~/.local/share/devin). Find those folders with a shallow search, then look for *.log inside them only.
$roots = @($env:LOCALAPPDATA, $env:APPDATA, (Join-Path $env:USERPROFILE ".local")) |
  Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$devinDirs = @()
foreach ($root in $roots) {
  $devinDirs += Get-ChildItem -Path $root -Directory -Recurse -Depth 3 -Filter "devin*" -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName
}
$files = @()
foreach ($dir in ($devinDirs | Select-Object -Unique)) {
  $files += Get-ChildItem -Path $dir -Recurse -Filter "*.log" -ErrorAction SilentlyContinue
}
$files = @($files | Sort-Object LastWriteTime -Descending | Select-Object -First $Logs)

$report.Add("")
$report.Add("== log files looked at (newest first)")
if ($files.Count -eq 0) { $report.Add("none found under: $($roots -join '; ')") }
foreach ($file in $files) { $report.Add("$($file.LastWriteTime.ToString('s'))  $($file.Length) bytes  $($file.FullName)") }

$pattern = "mcp|polic|allowlist|allow-list|whitelist|blocked|denied|not allowed|forbidden"
foreach ($file in $files) {
  $report.Add("")
  $report.Add("== $($file.Name)")
  $lines = @(Select-String -Path $file.FullName -Pattern $pattern -ErrorAction SilentlyContinue |
    Select-Object -First $MaxLines | ForEach-Object { $_.Line })
  if ($lines.Count -eq 0) { $report.Add("(no line matches)") }
  foreach ($line in $lines) {
    $clean = $line -replace "(?i)bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer ***"
    $clean = $clean -replace "(?i)((token|key|secret|password|authorization)[`"']?\s*[:=]\s*[`"']?)[^\s`"',}]+", '$1***'
    if ($clean.Length -gt 400) { $clean = $clean.Substring(0, 400) + " ..." }
    $report.Add($clean)
  }
}

[System.IO.File]::WriteAllLines((Join-Path (Get-Location).Path $Out), $report, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $Out ($($report.Count) lines). Send it back; tokens are masked, but glance through it first."
