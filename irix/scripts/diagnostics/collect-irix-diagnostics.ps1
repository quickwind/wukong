# collect-irix-diagnostics.ps1
#
# Irix (Windows) diagnostics: read-only. Kills nothing, changes nothing.
#
#   powershell -ExecutionPolicy Bypass -File .\collect-irix-diagnostics.ps1
#
# Writes a full report next to this script, in irix-diag-<timestamp>\report.txt, plus a
# irix-diag-<timestamp>.zip of the same folder, and prints the summary plus the crash
# evidence. Send that folder back.
#
# What it is hunting: devin.exe processes. There are two known spawn sites, and the
# script tells them apart by the command line:
#   "devin acp ..."        one per live agent session  (the daemon's ACP client)
#   "devin --version"     the usage plugin's version probe (one per uncached usage fetch)
# Each devin.exe is classified as attached (a live daemon ancestor) or orphan.

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$Stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$UserHome = $env:USERPROFILE
if (-not $UserHome) { $UserHome = $env:HOME }
if (-not $UserHome) { $UserHome = [Environment]::GetFolderPath("UserProfile") }

# The report lands next to this script, so it can be picked up from wherever the
# script was copied to. A folder that cannot be written to falls back to the home dir.
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }
$OutDir = Join-Path $ScriptDir "irix-diag-$Stamp"
try {
    New-Item -ItemType Directory -Path $OutDir -Force -ErrorAction Stop | Out-Null
} catch {
    $OutDir = Join-Path $UserHome "irix-diag-$Stamp"
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$ReportPath = Join-Path $OutDir "report.txt"

$script:Report = New-Object System.Collections.Generic.List[string]

function Write-Section {
    param([string]$Title)
    $line = ("=" * 78) + "`n" + $Title + "`n" + ("=" * 78)
    Write-Host $line -ForegroundColor Cyan
    $script:Report.Add($line)
}

function Write-Lines {
    param([string[]]$Lines, [string]$Color = "Gray")
    if (-not $Lines) { $Lines = @("(none)") }
    foreach ($l in $Lines) {
        $safe = Redact $l
        Write-Host $safe -ForegroundColor $Color
        $script:Report.Add($safe)
    }
}

# daemon.log and command lines can hold a daemon password, a relay token or an API key.
# Everything that leaves this script is redacted first.
function Redact([string]$text) {
    if (-not $text) { return $text }
    $text = $text -replace '(?i)(bearer\s+)[A-Za-z0-9._\-]+', '$1***'
    $text = $text -replace '(?i)((token|key|secret|password|authorization)["'']?\s*[:=]\s*["'']?)[^"''\s,}]+', '$1***'
    return $text
}

function Try-Get {
    param([scriptblock]$Block, $Fallback = "(failed)")
    try { & $Block } catch { $Fallback }
}

$HOME_DIR = Join-Path $UserHome ".irix"
$LOG_PATH = Join-Path $HOME_DIR "daemon.log"
$PID_PATH = Join-Path $HOME_DIR "paseo.pid"
$RUNTIME_DIR = Join-Path $HOME_DIR "runtime\devin"

# ---------------------------------------------------------------- 1. environment
Write-Section "1. Environment"
$os = Try-Get { Get-CimInstance Win32_OperatingSystem }
$envLines = @()
if ($os) {
    $envLines += "OS            : $($os.Caption) $($os.Version) (build $($os.BuildNumber))"
    $envLines += "Computer      : $env:COMPUTERNAME   User: $env:USERNAME"
    $envLines += "Physical RAM : $([math]::Round($os.TotalVisibleMemorySize / 1MB, 2)) GB total, $([math]::Round($os.FreePhysicalMemory / 1MB, 2)) GB free"
    $envLines += "Last boot     : $($os.LastBootUpTime)"
}
$envLines += "PowerShell    : $($PSVersionTable.PSVersion)"
$envLines += "Script UTC    : $((Get-Date).ToUniversalTime().ToString('u'))"
$envLines += "Irix home     : $HOME_DIR"
Write-Lines $envLines

# ---------------------------------------------- 1b. which devin binary is used
Write-Section "1b. The devin CLI on this machine"
$cliLines = @()
$cliLines += "where.exe devin :"
$whereOut = Try-Get { (& where.exe devin 2>&1 | Out-String).Trim() } "(where.exe failed)"
foreach ($w in ($whereOut -split "`r?`n")) { if ($w.Trim()) { $cliLines += "  $w" } }
$verOut = Try-Get { (& devin --version 2>&1 | Out-String).Trim() } "(devin --version failed)"
$cliLines += ""
$cliLines += "devin --version :"
foreach ($v in ($verOut -split "`r?`n")) { if ($v.Trim()) { $cliLines += "  $v" } }
$cliLines += ""
$cliLines += "A version like 'devin 3000.11.92 (sha)' is what the usage plugin expects;"
$cliLines += "anything else means the usage plugin's version cache stays cold and it"
$cliLines += "spawns a 'devin --version' probe on every usage fetch."
Write-Lines $cliLines

# ------------------------------------------------------- 2. all processes (one shot)
Write-Section "2. Process inventory"
$allProc = @{}
try {
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction Stop)) {
        $allProc[[int]$p.ProcessId] = $p
    }
} catch {
    Write-Lines @("Could not read the process list: $($_.Exception.Message)")
}
Write-Lines @("Processes visible: $($allProc.Count)")

function Get-AncestorChain {
    # Not $Pid: $PID is a read-only automatic variable in PowerShell.
    param([int]$ProcessId, [int]$MaxDepth = 6)
    $chain = @()
    $current = $ProcessId
    $seen = @{}
    for ($i = 0; $i -lt $MaxDepth; $i++) {
        if ($seen.ContainsKey($current)) { break }
        $seen[$current] = $true
        $proc = $allProc[$current]
        if (-not $proc) {
            $chain += ,@($current, "<not found>", "")
            break
        }
        $chain += ,@([int]$proc.ProcessId, $proc.Name, [string]$proc.CommandLine)
        $ppid = [int]$proc.ParentProcessId
        if ($ppid -le 0) { break }
        $current = $ppid
    }
    return $chain
}

# ------------------------------------------------- 3. daemon / supervisor / plugins
Write-Section "3. Daemon, supervisor and plugin processes"
$daemonProcs = @()
$pluginProcs = @()
foreach ($kv in $allProc.GetEnumerator()) {
    $cmd = [string]$kv.Value.CommandLine
    if ($cmd -match "daemon-worker|supervisor-entrypoint|supervisor\.js") { $daemonProcs += $kv.Value }
    if ($cmd -match "plugin-process") { $pluginProcs += $kv.Value }
}
if ($daemonProcs.Count -eq 0) {
    Write-Lines @("No daemon/supervisor process found by command line.") "Yellow"
} else {
    $lines = @()
    foreach ($p in $daemonProcs) {
        $lines += "PID $($p.ProcessId)  PPID $($p.ParentProcessId)  $($p.Name)"
        $lines += "    $($p.CommandLine)"
    }
    Write-Lines $lines
}
Write-Lines @("", "Plugin host processes (they spawn the usage plugin's 'devin --version' probe):") "Yellow"
if ($pluginProcs.Count -eq 0) {
    Write-Lines @("  (none found)")
} else {
    $lines = @()
    foreach ($p in $pluginProcs) {
        $lines += "  PID $($p.ProcessId)  PPID $($p.ParentProcessId)  started $($p.CreationDate)"
        $lines += "      $($p.CommandLine)"
    }
    Write-Lines $lines
}

if (Test-Path $PID_PATH) {
    Write-Lines @("", "pid file ($PID_PATH):", (Get-Content $PID_PATH -Raw).Trim()) "Yellow"
} else {
    Write-Lines @("", "pid file ($PID_PATH): NOT FOUND") "Yellow"
}

if (Test-Path $RUNTIME_DIR) {
    Write-Lines @("", "Devin runtime dir ($RUNTIME_DIR):") "Yellow"
    $rt = @(Get-ChildItem $RUNTIME_DIR -ErrorAction SilentlyContinue | ForEach-Object {
        "  $($_.Name)  $([math]::Round($_.Length/1KB,2)) KB  $($_.LastWriteTime)"
    })
    Write-Lines $rt
}

# ------------------------------------------------------- 4. devin.exe inventory
Write-Section "4. devin.exe inventory (the suspected leak)"

function Get-DevinTable {
    $rows = @()
    foreach ($kv in $allProc.GetEnumerator()) {
        if ($kv.Value.Name -ieq "devin.exe") {
            $cmd = [string]$kv.Value.CommandLine
            $kind = if ($cmd -match "\bacp\b") { "acp-session" }
                    elseif ($cmd -match "--version") { "version-probe" }
                    else { "other" }
            $rows += [PSCustomObject]@{
                Pid      = [int]$kv.Value.ProcessId
                Ppid     = [int]$kv.Value.ParentProcessId
                Kind     = $kind
                Started  = $kv.Value.CreationDate
                MemMB    = [int]([double]$kv.Value.WorkingSetSize / 1MB)
                Handles  = [int]$kv.Value.HandleCount
                Command  = $cmd
            }
        }
    }
    return @($rows | Sort-Object Started)
}

function Get-FreeMemMB {
    try {
        $o = Get-CimInstance Win32_OperatingSystem
        return [int]([double]$o.FreePhysicalMemory / 1024)
    } catch { return -1 }
}

$devinProcs = Get-DevinTable
$orphanCount = 0
$attachedCount = 0
$byKind = @{}
if ($devinProcs.Count -eq 0) {
    Write-Lines @("No devin.exe running.") "Yellow"
} else {
    foreach ($p in $devinProcs) {
        $chain = Get-AncestorChain -ProcessId $p.Pid
        $reachesLiveDaemon = $false
        $chainText = @()
        foreach ($link in $chain) {
            $cpid = $link[0]
            $cname = $link[1]
            $ccmd = $link[2]
            $alive = $allProc.ContainsKey([int]$cpid)
            if ($alive -and ($ccmd -match "daemon-worker|supervisor-entrypoint|plugin-process")) {
                $reachesLiveDaemon = $true
            }
            $tag = if ($alive) { "alive" } else { "DEAD" }
            $short = if ($ccmd) { (($ccmd -replace "\s+", " ").Substring(0, [Math]::Min(100, $ccmd.Length))) } else { "" }
            $chainText += "$cname($cpid $tag) <- $short"
        }
        $isOrphan = (-not $reachesLiveDaemon)
        if ($isOrphan) { $orphanCount++ } else { $attachedCount++ }
        if (-not $byKind.ContainsKey($p.Kind)) { $byKind[$p.Kind] = 0 }
        $byKind[$p.Kind] = $byKind[$p.Kind] + 1
        $status = if ($isOrphan) { "ORPHAN" } else { "attached" }
        $color = if ($isOrphan) { "Yellow" } else { "Green" }
        $head = ("PID {0,-7} {1,-13} started {2,-20} {3,-9} {4,6} MB  {5,5} handles" -f $p.Pid, $p.Kind, $p.Started, $status, $p.MemMB, $p.Handles)
        Write-Host $head -ForegroundColor $color
        $script:Report.Add($head)
        Write-Host "    cmd: $($p.Command)" -ForegroundColor "DarkGray"
        $script:Report.Add("    cmd: $($p.Command)")
        foreach ($t in $chainText) {
            Write-Host "    $t" -ForegroundColor "DarkGray"
            $script:Report.Add("    $t")
        }
    }
}
Write-Lines @("", "devin.exe total : $($devinProcs.Count)", "  orphans (no live daemon ancestor): $orphanCount", "  attached to a live daemon        : $attachedCount")
foreach ($k in $byKind.Keys) { Write-Lines @("  kind '$k'        : $($byKind[$k])") }
$devinMemMB = [int](($devinProcs | Measure-Object MemMB -Sum).Sum)
Write-Lines @("  memory in devin.exe : $devinMemMB MB", "  free physical RAM    : $(Get-FreeMemMB) MB")
Write-Lines @("  ('acp-session' = one per live agent; 'version-probe' = the usage plugin's probe)") "Yellow"

# --------------------------------------------- 4b. is the population growing?
Write-Section "4b. Growth check (samples every 30s for 3 minutes)"
Write-Lines @("A growing count is a live leak. A flat count with many orphans means the") "Yellow"
Write-Lines @("growth came from daemon restarts. The usage poll runs every ~5.5 minutes,") "Yellow"
Write-Lines @("so run this script again after 10 minutes if the numbers look flat here.") "Yellow"
$trend = @()
$probes = 0
$sessions = 0
for ($sample = 1; $sample -le 6; $sample++) {
    Start-Sleep -Seconds 30
    $snapshot = @()
    try {
        $snapshot = @(Get-CimInstance Win32_Process -Filter "Name='devin.exe'" -ErrorAction Stop)
    } catch {
        Write-Lines @("sample ${sample}: could not read the process list: $($_.Exception.Message)")
        continue
    }
    $probes = 0
    $sessions = 0
    $recent = 0
    $memMB = 0
    $cutoff = (Get-Date).AddMinutes(-5)
    foreach ($s in $snapshot) {
        $cmd = [string]$s.CommandLine
        if ($cmd -match "--version") { $probes++ } else { $sessions++ }
        if ($s.CreationDate -and $s.CreationDate -gt $cutoff) { $recent++ }
        $memMB += [int]([double]$s.WorkingSetSize / 1MB)
    }
    $free = Get-FreeMemMB
    $trend += "sample ${sample} @ $(Get-Date -Format 'HH:mm:ss')  total=$($snapshot.Count)  acp-sessions=$sessions  version-probes=$probes  started-in-last-5min=$recent  devin-mem=${memMB}MB  free-RAM=${free}MB"
    Write-Lines @($trend[-1]) "Yellow"
}
$firstCount = $devinProcs.Count
$lastCount = $probes + $sessions
Write-Lines @("", "devin.exe at start : $firstCount", "devin.exe at end   : $lastCount", "delta              : $($lastCount - $firstCount)") "Yellow"
if ($lastCount -gt $firstCount) {
    Write-Lines @("=> The population is GROWING while the daemon runs. That is a live leak,") "Yellow"
    Write-Lines @("   not crash leftovers. The 'version-probe' rows above point at the") "Yellow"
    Write-Lines @("   usage plugin; 'acp-session' points at agent sessions that are not closed.") "Yellow"
}

# ------------------------------------------------------ 5. daemon log: crash lines
Write-Section "5. Crash evidence in daemon.log"
if (-not (Test-Path $LOG_PATH)) {
    Write-Lines @("daemon.log not found at $LOG_PATH") "Yellow"
} else {
    $logInfo = Get-Item $LOG_PATH
    Write-Lines @("daemon.log: $($logInfo.FullName)  $([math]::Round($logInfo.Length/1KB,1)) KB  modified $($logInfo.LastWriteTime)")
    Write-Lines @("", "Rotated logs:")
    $rotated = @(Get-ChildItem (Split-Path $LOG_PATH) -Filter "daemon.log*" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | ForEach-Object { "  $($_.Name)  $([math]::Round($_.Length/1KB,1)) KB  $($_.LastWriteTime)" })
    Write-Lines $rotated

    $tail = @(Get-Content $LOG_PATH -Tail 6000 -ErrorAction SilentlyContinue)
    Write-Lines @("", "Log tail: $($tail.Count) lines read.")

    $crashPatterns = "Uncaught exception|Unhandled promise rejection|daemon crashing|FATAL ERROR|Allocation failed|heap out of memory|Worker crashed|Restarting worker|Worker exited|Spawning worker|out of memory|EAGAIN|EMFILE|Usage fetch failed"
    $crashLines = @()
    for ($i = 0; $i -lt $tail.Count; $i++) {
        if ($tail[$i] -match $crashPatterns) {
            $crashLines += ("[{0,5}] {1}" -f ($i + 1), $tail[$i])
        }
    }
    Write-Lines @("", "Crash / restart / usage lines (last 100 of $([math]::Max(0,$crashLines.Count)) matches):") "Yellow"
    Write-Lines @($crashLines | Select-Object -Last 100)

    $restartCount = ($tail | Where-Object { $_ -match "Restarting worker" }).Count
    $crashCount = ($tail | Where-Object { $_ -match "daemon crashing|Worker crashed|FATAL ERROR" }).Count
    $usageFailCount = ($tail | Where-Object { $_ -match "Usage fetch failed" }).Count
    Write-Lines @("", "In the last 6000 log lines: worker restarts = $restartCount, crash markers = $crashCount, usage fetch failures = $usageFailCount") "Yellow"

    # The window around the last crash marker
    $lastIdx = -1
    for ($i = $tail.Count - 1; $i -ge 0; $i--) {
        if ($tail[$i] -match "daemon crashing|Worker crashed|FATAL ERROR|Allocation failed|heap out of memory") { $lastIdx = $i; break }
    }
    if ($lastIdx -ge 0) {
        $from = [Math]::Max(0, $lastIdx - 60)
        $to = [Math]::Min($tail.Count - 1, $lastIdx + 15)
        $window = @()
        for ($i = $from; $i -le $to; $i++) { $window += ("[{0,5}] {1}" -f ($i + 1), $tail[$i]) }
        Write-Lines @("", "=== 60 lines before and 15 after the LAST crash marker ===") "Magenta"
        Write-Lines $window
    } else {
        Write-Lines @("", "No crash marker found in the last 6000 log lines.") "Yellow"
    }

    # Usage fetch lines: how often the plugin reached the source
    $usageLines = @()
    for ($i = 0; $i -lt $tail.Count; $i++) {
        if ($tail[$i] -match "[Uu]sage") { $usageLines += ("[{0,5}] {1}" -f ($i + 1), $tail[$i]) }
    }
    Write-Lines @("", "=== last 40 usage-related log lines ===") "Magenta"
    Write-Lines @($usageLines | Select-Object -Last 40)
}

# ------------------------------------------------------------ 6. Windows events
Write-Section "6. Windows Application event log (node.exe / devin.exe crashes)"
try {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = "Application"; Id = 1000, 1001, 1026 } -MaxEvents 60 -ErrorAction Stop |
        Where-Object { $_.Message -match "node\.exe|devin\.exe|irix" })
    if ($events.Count -eq 0) {
        Write-Lines @("No matching Application events (1000/1001/1026) for node.exe/devin.exe/irix in the recent log.") "Yellow"
    } else {
        $lines = @()
        foreach ($e in $events) {
            $msg = ($e.Message -replace "`r`n", " | ")
            if ($msg.Length -gt 700) { $msg = $msg.Substring(0, 700) + "..." }
            $lines += "$($e.TimeCreated)  id=$($e.Id)  $msg"
        }
        Write-Lines $lines
    }
} catch {
    Write-Lines @("Could not read the Application event log: $($_.Exception.Message)") "Yellow"
}

# --------------------------------------------------------------- 7. live agents
Write-Section "7. Live agents (irix agent ls)"
$irixCmd = Get-Command irix -ErrorAction SilentlyContinue
if (-not $irixCmd) {
    Write-Lines @("'irix' is not on PATH in this shell.") "Yellow"
} else {
    Write-Lines @("irix: $($irixCmd.Source)")
    $agentOut = Try-Get { (& irix agent ls -a -g 2>&1 | Out-String) } "(irix agent ls failed)"
    Write-Lines @($agentOut -split "`r?`n")
}

# --------------------------------------------------- 8. daemon memory / handles
Write-Section "8. Daemon worker resource use"
$workerProcs = @()
foreach ($kv in $allProc.GetEnumerator()) {
    $cmd = [string]$kv.Value.CommandLine
    if ($cmd -match "daemon-worker") { $workerProcs += $kv.Value }
}
if ($workerProcs.Count -eq 0) {
    Write-Lines @("No daemon-worker process found.") "Yellow"
} else {
    foreach ($p in $workerProcs) {
        $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if ($gp) {
            $mb = [math]::Round($gp.WorkingSet64 / 1MB, 1)
            $pm = [math]::Round($gp.PrivateMemorySize64 / 1MB, 1)
            Write-Lines @("PID $($p.ProcessId)  working set ${mb} MB  private ${pm} MB  handles $($gp.HandleCount)  threads $($gp.Threads.Count)  started $($p.CreationDate)")
        }
    }
}

# ------------------------------------------------------------------- 9. summary
Write-Section "SUMMARY"
$summary = @()
$summary += "devin.exe total                : $($devinProcs.Count)"
$summary += "  orphans                      : $orphanCount"
$summary += "  attached to a live daemon    : $attachedCount"
foreach ($k in $byKind.Keys) { $summary += "  kind '$k'                  : $($byKind[$k])" }
$summary += "devin.exe at start              : $($devinProcs.Count)"
$summary += "devin.exe at end of sampling    : $lastCount (delta $($lastCount - $firstCount))"
$summary += "devin.exe memory                : $devinMemMB MB"
$summary += "free physical RAM               : $(Get-FreeMemMB) MB"
if (Test-Path $LOG_PATH) { $summary += "log                            : $LOG_PATH" }
$summary += "report                         : $ReportPath"
$summary += ""
$summary += "Reading the result:"
$summary += "  many ORPHAN 'acp-session' + restarts in the log  -> daemon crashes, the"
$summary += "     supervisor restarts it, and the dead daemon's devin.exe survive."
$summary += "  growing 'version-probe' rows, delta > 0          -> the usage plugin's"
$summary += "     'devin --version' probe is leaking (see usage.ts)."
$summary += "  kill leftovers with: taskkill /F /IM devin.exe"
Write-Lines $summary "White"

$script:Report | Out-File -FilePath $ReportPath -Encoding utf8
Write-Host ""
Write-Host "Report written to $ReportPath" -ForegroundColor Green

# The folder is zipped next to itself so it can be sent as one file.
try {
    $zip = Join-Path $ScriptDir ("irix-diag-$Stamp.zip")
    Compress-Archive -Path (Join-Path $OutDir "*") -DestinationPath $zip -Force
    Write-Host "Zip written to      $zip" -ForegroundColor Green
} catch {
    Write-Host "Zip failed: $($_.Exception.Message)" -ForegroundColor Yellow
}
Write-Host "Send the report (or the zip) back." -ForegroundColor Green
