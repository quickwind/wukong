import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chromium, defineConfig, devices } from "@playwright/test";

const here = __dirname;

/**
 * Playwright wants the exact browser build of its own version. When that build is not installed
 * but another one is (the cache often holds an older release), use the newest installed one rather
 * than downloading a browser. IRIX_E2E_CHROMIUM overrides everything.
 */
function browserExecutable(): string | undefined {
  if (process.env.IRIX_E2E_CHROMIUM) return process.env.IRIX_E2E_CHROMIUM;
  const interactive = process.argv.includes("--headed") || process.argv.includes("--ui");
  if (!interactive && existsSync(chromium.executablePath())) return undefined;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    path.join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const newest = (prefix: string) =>
    readdirSync(cache)
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  const candidates = [
    ...(interactive
      ? []
      : newest("chromium_headless_shell-").map((dir) => [dir, "headless_shell"])),
    ...newest("chromium-").map((dir) => [dir, "Chromium.app/Contents/MacOS/Chromium"]),
  ];
  for (const [dir, binary] of candidates) {
    const root = path.join(cache, dir);
    for (const arch of readdirSync(root).filter((name) => name.startsWith("chrome-"))) {
      const file = path.join(root, arch, binary);
      if (existsSync(file)) return file;
    }
  }
  return undefined;
}
const executablePath = browserExecutable();

// Irix browser acceptance. Run from the repo root:
//   npx playwright test -c irix/e2e/playwright.config.ts
// global-setup builds the Irix web UI when needed and starts a real Irix daemon in a temp home.
export default defineConfig({
  testDir: path.join(here, "specs"),
  outputDir: path.join(here, ".output", "test-results"),
  globalSetup: path.join(here, "global-setup.ts"),
  globalTeardown: path.join(here, "global-teardown.ts"),
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // The setup builds the web UI (minutes on a cold run); its own timeout is the global one.
  globalTimeout: 30 * 60_000,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { executablePath },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
  ],
});
