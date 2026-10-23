# Windows diagnostics

Read-only PowerShell scripts for a Windows machine that runs the Irix daemon. They kill nothing and
change nothing. Each writes a report folder and a `.zip` of it next to where you run it; look
through the folder before you send it on.

| Script                         | Use it when                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collect-irix-diagnostics.ps1` | The daemon crashed or Windows ran out of memory. One run covers the machine, the daemon and plugin processes, every `devin.exe` with its parent chain and whether it is an orphan, a 3-minute growth check, crash lines from `daemon.log`, the Windows event log and `irix agent ls`. |
| `devin-proc-diag.ps1`          | `devin.exe` processes pile up. Samples every `-IntervalSec` seconds for `-Samples` rounds and records which `devin.exe` appeared and which went away, with its parent, so you can tell a leak from a live chat. Redacts tokens and keys in the log lines it copies.                   |

```powershell
powershell -ExecutionPolicy Bypass -File .\devin-proc-diag.ps1 -Samples 30 -IntervalSec 30
powershell -ExecutionPolicy Bypass -File .\collect-irix-diagnostics.ps1
```

Both read the daemon log from `%USERPROFILE%\.irix`. `collect-irix-diagnostics.ps1` takes no parameters;
pass `-IrixHome` to `devin-proc-diag.ps1` if `IRIX_HOME` points elsewhere.
