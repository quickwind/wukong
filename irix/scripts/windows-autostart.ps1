# Starts the Irix daemon in the background every time you sign in to Windows.
# Needs no administrator rights: it only puts a shortcut in your own Startup folder.
#
#   powershell -ExecutionPolicy Bypass -File windows-autostart.ps1 install
#   powershell -ExecutionPolicy Bypass -File windows-autostart.ps1 status
#   powershell -ExecutionPolicy Bypass -File windows-autostart.ps1 remove
#
# `irix daemon start` hides the daemon and returns once it is ready; running it again while a
# daemon is up does nothing, so a sign-in start is safe.
param(
  [Parameter(Position = 0)]
  [ValidateSet("install", "remove", "status")]
  [string]$Action = "status"
)

$link = Join-Path ([Environment]::GetFolderPath("Startup")) "Irix daemon.lnk"

switch ($Action) {
  "install" {
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
    $shortcut.TargetPath = $env:ComSpec
    $shortcut.Arguments = "/c irix daemon start"
    $shortcut.WindowStyle = 7 # minimized; the window closes when the command returns
    $shortcut.Description = "Starts the Irix daemon in the background at sign-in"
    $shortcut.Save()
    Write-Host "Installed: $link"
    Write-Host "It runs at your next sign-in. To start it now: irix daemon start"
  }
  "remove" {
    if (Test-Path $link) {
      Remove-Item $link
      Write-Host "Removed: $link"
    } else {
      Write-Host "Not installed"
    }
  }
  "status" {
    if (Test-Path $link) { Write-Host "Start at sign-in: installed ($link)" } else { Write-Host "Start at sign-in: not installed" }
    irix daemon status
  }
}
