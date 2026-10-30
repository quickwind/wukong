// changes-from-upstream.md: A.38 (web UI served by the daemon), B.1 (egress), B.3 (no upstream
// links, no What's new row).
import { expect, test } from "@playwright/test";
import { recordNetwork } from "../support/network";
import { baseUrl, expectNotShown, openHostSection, openSettings } from "../support/navigation";

// The brand ("Irix") is applied to a throwaway checkout at pack time (irix/scripts/brand.mjs),
// never in the source this harness builds. A branded build is checked with IRIX_E2E_TITLE=Irix.
const EXPECTED_TITLE = process.env.IRIX_E2E_TITLE ?? "Paseo";

test("the daemon serves the web UI and the page title is the product name", async ({ page }) => {
  await page.goto(baseUrl());
  await expect(page.getByTestId("sidebar-settings")).toBeVisible();
  await expect(page).toHaveTitle(EXPECTED_TITLE);
});

test("no request leaves localhost on load or while navigating", async ({ page }) => {
  const network = recordNetwork(page);

  await page.goto(baseUrl());
  await expect(page.getByTestId("sidebar-add-project")).toBeVisible();
  expect(network.urls.length).toBeGreaterThan(0);

  await openSettings(page);
  await openHostSection(page, "host");
  await expect(page.getByTestId("host-page-identity")).toBeVisible();
  await page.getByTestId("settings-back-to-workspace").click();

  await page.getByTestId("sidebar-add-project").click();
  await expect(page.getByTestId("add-project-flow")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("add-project-flow")).toBeHidden();

  await page.getByTestId("sidebar-global-new-workspace").click();
  await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible();

  // Let late requests (usage polling, avatars, fonts) happen before judging.
  await page.waitForTimeout(2_000);
  expect(network.offHost(), "requests to hosts other than loopback").toEqual([]);
  // The page talks to its own daemon over a WebSocket, which must have been seen as well.
  expect(network.urls.some((url) => /^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url))).toBe(true);
});

test("no community or help links, and no What's new row", async ({ page }) => {
  await page.goto(baseUrl());
  await expect(page.getByTestId("sidebar-help")).toBeVisible();

  // Help menu: Keyboard shortcuts and Run diagnostics only.
  await page.getByTestId("sidebar-help").click();
  await expect(page.getByText("Keyboard shortcuts")).toBeVisible();
  const upstreamLinkText = /discord|github|twitter|x\.com|changelog|what'?s new|community|docs/i;
  await expectNotShown(page.getByText(upstreamLinkText));
  await page.keyboard.press("Escape");

  // No anchor anywhere points off the machine, on the pages that carry links upstream.
  for (const openPage of [
    async () => openSettings(page),
    async () => page.goto(`${baseUrl()}/settings/about`),
    async () => openHostSection(page, "host"),
  ]) {
    await openPage();
    await page.waitForTimeout(500);
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href));
    const external = hrefs.filter((href) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(href));
    expect(external).toEqual([]);
  }

  await page.goto(`${baseUrl()}/settings/about`);
  await expect(page.getByText("App version")).toBeVisible();
  await expectNotShown(page.getByText(/what'?s new/i));
  await expectNotShown(page.getByText(/discord|join the community/i));
});
