// The system folder dialog, shown on the machine the daemon runs on. Wukong's daemon listens on
// loopback only, so that is the machine the user is sitting at. Windows uses the Explorer folder
// dialog, macOS the Finder one, Linux zenity or kdialog.

import { execFile } from "node:child_process";

const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

export interface DialogCommand {
  file: string;
  args: string[];
}

export function windowsDialogScript(title: string): string {
  // PowerShell reads the typographic single quotes (U+2018 to U+201B) as quotes too.
  const quoted = title.replace(/['\u2018\u2019\u201A\u201B]/gu, (quote) => quote + quote);
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    // The owner must be a shown, topmost window. A dialog owned by a window that was never shown
    // opens behind the browser with no taskbar button, so it looks like nothing happened. The
    // owner is a transparent 1x1 pixel in the middle of the screen.
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.FormBorderStyle = 'None'",
    "$owner.StartPosition = 'CenterScreen'",
    "$owner.Opacity = 0",
    "$owner.Size = New-Object System.Drawing.Size(1, 1)",
    "$owner.Show()",
    "$owner.Activate()",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = '${quoted}'`,
    "$dialog.ShowNewFolderButton = $true",
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Close()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  ].join("; ");
}

/** The commands to try, in order, for a platform. The first one that exists is used. */
export function folderDialogCommands(platform: NodeJS.Platform, title: string): DialogCommand[] {
  if (platform === "win32") {
    const encoded = Buffer.from(windowsDialogScript(title), "utf16le").toString("base64");
    return [
      {
        file: "powershell.exe",
        // -WindowStyle Hidden hides only PowerShell's own console, not the folder dialog.
        args: ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      },
    ];
  }
  if (platform === "darwin") {
    const prompt = title.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return [
      {
        file: "osascript",
        args: ["-e", `POSIX path of (choose folder with prompt "${prompt}")`],
      },
    ];
  }
  return [
    { file: "zenity", args: ["--file-selection", "--directory", `--title=${title}`] },
    { file: "kdialog", args: ["--getexistingdirectory", ".", "--title", title] },
  ];
}

/** Dialog output to a path: trims the newline, drops macOS's trailing slash, empty means cancel. */
export function parseDialogOutput(stdout: string, platform: NodeJS.Platform): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const isRoot = trimmed === "/" || /^[A-Za-z]:[\\/]?$/u.test(trimmed);
  return !isRoot && platform === "darwin" ? trimmed.replace(/\/+$/u, "") : trimmed;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | string | null;
  missing: boolean;
}

type Exec = (file: string, args: string[]) => Promise<ExecResult>;

const defaultExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      // No windowsHide: on Windows it hides the dialog's window as well as the console.
      { timeout: DIALOG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code ?? null;
        resolve({ stdout, stderr, code, missing: code === "ENOENT" });
      },
    );
  });

/** Cancelling shows up as a non-zero exit (osascript: -128, zenity: 1); anything else is a failure. */
function failureMessage(result: ExecResult): string | null {
  const stderr = result.stderr.trim();
  if (!result.code || !stderr || /cancel|-128/iu.test(stderr)) return null;
  return stderr.split(/\r?\n/u)[0] ?? stderr;
}

export async function pickFolder(
  title = "Choose a folder",
  platform: NodeJS.Platform = process.platform,
  exec: Exec = defaultExec,
): Promise<string | null> {
  for (const command of folderDialogCommands(platform, title)) {
    const result = await exec(command.file, command.args);
    if (result.missing) continue;
    const failure = failureMessage(result);
    if (failure) throw new Error(failure);
    return parseDialogOutput(result.stdout, platform);
  }
  throw new Error(
    platform === "linux"
      ? "No folder dialog is available. Install zenity or kdialog."
      : "The system folder dialog could not be started.",
  );
}
