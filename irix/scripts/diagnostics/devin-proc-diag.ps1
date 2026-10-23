# Collects what is needed to find out why devin.exe processes pile up under the Irix daemon and why
# the daemon then crashes.
#
#   powershell -ExecutionPolicy Bypass -File .\devin-proc-diag.ps1
#   powershell -ExecutionPolicy Bypass -File .\devin-proc-diag.ps1 -Samples 20 -IntervalSec 30
#
# With -Samples above 1 it takes a snapshot every -IntervalSec seconds and records every devin.exe
# that appeared or went away in between, so leave it running while you use the web UI as usual.
# Writes a folder devin-diag-<time> next to where you run it, plus a .zip of it. Nothing is sent
# anywhere. daemon.log lines are copied as they are, with Bearer tokens and token/key/secret values
# replaced by ***; look through the folder before you share it.
param(
  [int]$Samples = 1,
  [int]$IntervalSec = 30,
  [string]$IrixHome = (Join-Path $env:USERPROFILE ".irix"),
  [int]$LogTail = 400
)

$ErrorActionPreference = "Continue"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path (Get-Location) "devin-diag-$stamp"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

function Redact([string]$text) {
  if (-not $text) { return $text }
  $text = $text -replace '(?i)(bearer\s+)[A-Za-z0-9._\-]+', '$1***'
  $text -replace '(?i)((token|key|secret|password)["'']?\s*[:=]\s*["'']?)[^"''\s,}]+', '$1***'
}

function Write-Section([string]$file, [string]$title, $body) {
  $path = Join-Path $outDir $file
  Add-Content -Path $path -Value "== $title" -Encoding UTF8
  Add-Content -Path $path -Value (($body | Out-String -Width 400).TrimEnd()) -Encoding UTF8
  Add-Content -Path $path -Value "" -Encoding UTF8
}

function Get-Kind([string]$cmd) {
  if (-not $cmd) { return "unknown (no command line)" }
  if ($cmd -match '--version') { return "version (usage plugin)" }
  if ($cmd -match '(^|[\s"\\/])acp(\s|"|$)') { return "acp (chat or probe)" }
  return "other"
}

# One snapshot of every process, keyed by PID, so parents can be looked up without more queries.
function Get-Snapshot {
  $all = @{}
  foreach ($p in (Get-CimInstance Win32_Process)) { $all[[int]$p.ProcessId] = $p }
  $devin = foreach ($p in $all.Values) {
    if ($p.Name -ne "devin.exe") { continue }
    $parent = $all[[int]$p.ParentProcessId]
    # A PID can be reused: a "parent" started after the child is not the real parent.
    $parentAlive = $parent -and $parent.CreationDate -le $p.CreationDate
    $grand = if ($parentAlive) { $all[[int]$parent.ParentProcessId] } else { $null }
    [pscustomobject]@{
      PID          = [int]$p.ProcessId
      Started      = $p.CreationDate
      AgeMin       = [math]::Round(((Get-Date) - $p.CreationDate).TotalMinutes, 1)
      MemMB        = [int]($p.WorkingSetSize / 1MB)
      Handles      = $p.HandleCount
      Kind         = Get-Kind $p.CommandLine
      ParentPID    = [int]$p.ParentProcessId
      Parent       = if ($parentAlive) { $parent.Name } else { "<gone>" }
      ParentCmd    = if ($parentAlive) { Redact $parent.CommandLine } else { "" }
      GrandParent  = if ($grand) { "$($grand.Name) ($([int]$grand.ProcessId))" } else { "" }
      CommandLine  = Redact $p.CommandLine
    }
  }
  [pscustomobject]@{ All = $all; Devin = @($devin | Sort-Object Started) }
}

function Write-Summary($snap, [string]$file, [string]$label) {
  $d = $snap.Devin
  Write-Section $file "$label : $($d.Count) devin.exe, $([int](($d | Measure-Object MemMB -Sum).Sum)) MB total" ""
  Write-Section $file "by kind" ($d | Group-Object Kind | Select-Object Count, Name | Format-Table -AutoSize)
  Write-Section $file "by parent" ($d | Group-Object Parent, ParentPID | Select-Object Count, Name | Format-Table -AutoSize)
}

$report = "report.txt"
Write-Section $report "machine" @(
  "time:      $(Get-Date -Format o)",
  "os:        $([Environment]::OSVersion.VersionString)",
  "ps:        $($PSVersionTable.PSVersion)",
  "irix home: $IrixHome"
)

Write-Section $report "devin --version / where.exe devin" @(
  (& { try { (devin --version 2>&1 | Out-String).Trim() } catch { "could not run devin: $($_.Exception.Message)" } }),
  (& { try { (where.exe devin 2>&1 | Out-String).Trim() } catch { "where.exe failed" } })
)

Write-Section $report "irix daemon status" (& {
  try { (irix daemon status 2>&1 | Out-String).Trim() } catch { "could not run irix: $($_.Exception.Message)" }
})

$first = Get-Snapshot
Write-Summary $first $report "now"
Write-Section $report "devin.exe processes (oldest first)" ($first.Devin | Format-List)

# The daemon: node.exe processes that belong to Irix, and every process under them.
$nodes = @($first.All.Values | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match '(?i)irix|paseo' })
Write-Section $report "irix node.exe processes" ($nodes | ForEach-Object {
  [pscustomobject]@{
    PID = [int]$_.ProcessId; ParentPID = [int]$_.ParentProcessId; Started = $_.CreationDate
    MemMB = [int]($_.WorkingSetSize / 1MB); Handles = $_.HandleCount; CommandLine = Redact $_.CommandLine
  }
} | Format-List)

$children = @{}
foreach ($p in $first.All.Values) {
  $ppid = [int]$p.ParentProcessId
  if (-not $children.ContainsKey($ppid)) { $children[$ppid] = New-Object System.Collections.Generic.List[object] }
  $children[$ppid].Add($p)
}
function Write-Tree([int]$procId, [int]$depth, [System.Collections.Generic.List[string]]$lines) {
  if ($depth -gt 8 -or -not $children.ContainsKey($procId)) { return }
  foreach ($c in $children[$procId]) {
    $cmd = Redact $c.CommandLine
    if ($cmd -and $cmd.Length -gt 160) { $cmd = $cmd.Substring(0, 160) + "..." }
    $lines.Add(("  " * $depth) + "$($c.Name) ($([int]$c.ProcessId), $([int]($c.WorkingSetSize / 1MB)) MB)  $cmd")
    Write-Tree ([int]$c.ProcessId) ($depth + 1) $lines
  }
}
$roots = @($nodes | Where-Object { -not ($nodes.ProcessId -contains $_.ParentProcessId) })
foreach ($r in $roots) {
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("$($r.Name) ($([int]$r.ProcessId))")
  Write-Tree ([int]$r.ProcessId) 1 $lines
  Write-Section $report "process tree under node $([int]$r.ProcessId)" $lines
}

# daemon.log: the last lines, and every line that looks like a crash or a restart.
$logs = @(Get-ChildItem -Path $IrixHome -Filter "*.log*" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
Write-Section $report "log files in $IrixHome" ($logs | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize)
$daemonLog = Join-Path $IrixHome "daemon.log"
if (Test-Path $daemonLog) {
  $pattern = 'crash|exit|exited|restart|heap|out of memory|ENOMEM|EMFILE|ENFILE|EAGAIN|uncaught|unhandled|fatal|SIGKILL|kill-timeout|could not release|spawn|taskkill'
  $hits = foreach ($f in $logs) {
    Select-String -Path $f.FullName -Pattern $pattern -ErrorAction SilentlyContinue |
      ForEach-Object { "$($f.Name):$($_.LineNumber): $(Redact $_.Line)" }
  }
  Set-Content -Path (Join-Path $outDir "log-matches.txt") -Value ($hits | Select-Object -Last 1500) -Encoding UTF8
  Set-Content -Path (Join-Path $outDir "daemon-log-tail.txt") `
    -Value (Get-Content $daemonLog -Tail $LogTail | ForEach-Object { Redact $_ }) -Encoding UTF8
} else {
  Write-Section $report "daemon.log" "not found at $daemonLog (pass -IrixHome)"
}

# Windows' own record of node.exe or devin.exe dying (Application Error 1000, .NET/Node 1026, WER 1001).
try {
  $events = Get-WinEvent -FilterHashtable @{ LogName = "Application"; Id = 1000, 1001, 1026; StartTime = (Get-Date).AddDays(-3) } -ErrorAction Stop |
    Where-Object { $_.Message -match '(?i)node\.exe|devin\.exe' } |
    Select-Object -First 40 TimeCreated, Id, ProviderName, @{ n = "Message"; e = { ($_.Message -split "`n" | Select-Object -First 12) -join " | " } }
  Write-Section $report "Application event log: node.exe / devin.exe errors, last 3 days" ($events | Format-List)
} catch {
  Write-Section $report "Application event log" "none found or not readable: $($_.Exception.Message)"
}

# Sampling: what appears and what goes away while the daemon runs.
if ($Samples -gt 1) {
  $timeline = "timeline.txt"
  $known = @{}
  foreach ($p in $first.Devin) { $known[$p.PID] = $p }
  Write-Section $timeline "sample 1 / $Samples  $(Get-Date -Format HH:mm:ss)  devin.exe: $($first.Devin.Count)" ""
  for ($i = 2; $i -le $Samples; $i++) {
    Start-Sleep -Seconds $IntervalSec
    $snap = Get-Snapshot
    $now = @{}
    foreach ($p in $snap.Devin) { $now[$p.PID] = $p }
    $new = @($snap.Devin | Where-Object { -not $known.ContainsKey($_.PID) })
    $gone = @($known.Values | Where-Object { -not $now.ContainsKey($_.PID) })
    $mem = [int](($snap.Devin | Measure-Object MemMB -Sum).Sum)
    Write-Section $timeline "sample $i / $Samples  $(Get-Date -Format HH:mm:ss)  devin.exe: $($snap.Devin.Count)  (+$($new.Count) / -$($gone.Count))  $mem MB" ""
    if ($new.Count) { Write-Section $timeline "  appeared" ($new | Select-Object PID, Kind, Parent, ParentPID, CommandLine | Format-Table -AutoSize -Wrap) }
    if ($gone.Count) { Write-Section $timeline "  went away" ($gone | Select-Object PID, Kind, AgeMin, Parent | Format-Table -AutoSize) }
    Write-Host "sample $i/$Samples : $($snap.Devin.Count) devin.exe (+$($new.Count) / -$($gone.Count))"
    $known = $now
  }
  Write-Summary $snap $report "after $Samples samples"
  Write-Section $report "devin.exe processes at the end" ($snap.Devin | Format-List)
}

Write-Summary $first "console-summary.txt" "devin.exe at start"
Get-Content (Join-Path $outDir "console-summary.txt") | Write-Host

$zip = "$outDir.zip"
try {
  Compress-Archive -Path (Join-Path $outDir "*") -DestinationPath $zip -Force
  Write-Host "Wrote $outDir and $zip"
} catch {
  Write-Host "Wrote $outDir (zip failed: $($_.Exception.Message))"
}
