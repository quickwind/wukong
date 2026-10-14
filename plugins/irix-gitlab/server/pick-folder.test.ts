import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  folderDialogCommands,
  parseDialogOutput,
  pickFolder,
  windowsDialogScript,
} from "./pick-folder.js";

describe("folderDialogCommands", () => {
  it("uses the Explorer folder dialog on Windows through an encoded PowerShell script", () => {
    const [command] = folderDialogCommands("win32", "Pick it");
    expect(command?.file).toBe("powershell.exe");
    expect(command?.args).toEqual(
      expect.arrayContaining(["-NoProfile", "-STA", "-EncodedCommand"]),
    );
    const encoded = command?.args.at(-1) ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain("FolderBrowserDialog");
  });

  it("hides only PowerShell's console, never the dialog, and does not set windowsHide", () => {
    const [command] = folderDialogCommands("win32", "t");
    expect(command?.args).toEqual(expect.arrayContaining(["-WindowStyle", "Hidden"]));
    expect(readFileSync(new URL("./pick-folder.ts", import.meta.url), "utf8")).not.toMatch(
      /windowsHide:\s*true/,
    );
  });

  it("shows the owner window before the dialog, so the dialog opens in front", () => {
    const script = windowsDialogScript("t");
    expect(script.indexOf("$owner.Show()")).toBeGreaterThan(-1);
    expect(script.indexOf("$owner.Show()")).toBeLessThan(script.indexOf("ShowDialog($owner)"));
    expect(script).toContain("$owner.TopMost = $true");
  });

  it("does not pass -NonInteractive to PowerShell", () => {
    expect(folderDialogCommands("win32", "t")[0]?.args).not.toContain("-NonInteractive");
  });

  it("doubles typographic single quotes as well, which PowerShell also reads as quotes", () => {
    expect(windowsDialogScript("Bob\u2019s")).toContain("'Bob\u2019\u2019s'");
  });

  it("quotes a title with an apostrophe in the PowerShell script", () => {
    expect(windowsDialogScript("Bob's folder")).toContain("'Bob''s folder'");
  });

  it("uses Finder's chooser on macOS and escapes the title", () => {
    const [command] = folderDialogCommands("darwin", 'Say "hi"');
    expect(command?.file).toBe("osascript");
    expect(command?.args[1]).toContain('prompt "Say \\"hi\\""');
  });

  it("tries zenity, then kdialog, on Linux", () => {
    expect(folderDialogCommands("linux", "t").map((command) => command.file)).toEqual([
      "zenity",
      "kdialog",
    ]);
  });
});

describe("parseDialogOutput", () => {
  it("treats empty output as a cancelled dialog", () => {
    expect(parseDialogOutput("", "win32")).toBeNull();
    expect(parseDialogOutput("\n", "linux")).toBeNull();
  });

  it("keeps a Windows path as printed and trims macOS's trailing slash", () => {
    expect(parseDialogOutput("C:\\Users\\me\\proj", "win32")).toBe("C:\\Users\\me\\proj");
    expect(parseDialogOutput("/Users/me/proj/\n", "darwin")).toBe("/Users/me/proj");
    expect(parseDialogOutput("/\n", "darwin")).toBe("/");
  });
});

describe("pickFolder", () => {
  it("returns the chosen path", async () => {
    const path = await pickFolder("t", "win32", async () => ({
      stdout: "D:\\work\\app",
      stderr: "",
      code: 0,
      missing: false,
    }));
    expect(path).toBe("D:\\work\\app");
  });

  it("returns null when the user cancels", async () => {
    expect(
      await pickFolder("t", "darwin", async () => ({
        stdout: "",
        stderr: "",
        code: 1,
        missing: false,
      })),
    ).toBeNull();
  });

  it("falls through to the next Linux dialog when the first is not installed", async () => {
    const tried: string[] = [];
    const path = await pickFolder("t", "linux", async (file) => {
      tried.push(file);
      return file === "zenity"
        ? { stdout: "", stderr: "", code: "ENOENT", missing: true }
        : { stdout: "/home/me/p\n", stderr: "", code: 0, missing: false };
    });
    expect(tried).toEqual(["zenity", "kdialog"]);
    expect(path).toBe("/home/me/p");
  });

  it("says what to install when no Linux dialog exists", async () => {
    await expect(
      pickFolder("t", "linux", async () => ({
        stdout: "",
        stderr: "",
        code: "ENOENT",
        missing: true,
      })),
    ).rejects.toThrow(/zenity or kdialog/);
  });

  it("reports a failing dialog instead of treating it as a cancel", async () => {
    await expect(
      pickFolder("t", "win32", async () => ({
        stdout: "",
        stderr: "Add-Type : Could not load System.Windows.Forms\nat line 1",
        code: 1,
        missing: false,
      })),
    ).rejects.toThrow("Could not load System.Windows.Forms");
  });

  it("treats macOS's 'User canceled' as a cancel", async () => {
    const result = await pickFolder("t", "darwin", async () => ({
      stdout: "",
      stderr: "execution error: User canceled. (-128)",
      code: 1,
      missing: false,
    }));
    expect(result).toBeNull();
  });
});
