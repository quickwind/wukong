// changes-from-upstream.md: B.2 (no pairing), B.6 (Claude Code and Devin only), and the wording
// fixes made by the brand step. The Open project page is what a fresh home shows.
//
// The harness serves the unbranded build, where the brand step's wording fixes are not applied
// (irix/scripts/brand.test.mjs covers them). Set IRIX_E2E_TITLE=Irix when the build under test is
// the branded one to check the wording here too.
import { expect, test } from "@playwright/test";
import { baseUrl, expectNotShown } from "../support/navigation";

test("the Open project page offers no pairing", async ({ page }) => {
  await page.goto(baseUrl());
  await expect(page.getByTestId("open-project-setup-providers")).toBeVisible();
  // Pairing reaches the public relay; Irix has none of it.
  await expectNotShown(page.getByTestId("open-project-pair-device"));
});

test("the Open project page names only Claude Code and Devin (branded build)", async ({ page }) => {
  test.skip(process.env.IRIX_E2E_TITLE !== "Irix", "needs the branded build");
  await page.goto(baseUrl());
  await expect(page.getByTestId("open-project-setup-providers")).toContainText(
    "Configure Claude Code and Devin",
  );
  await expect(page.getByTestId("open-project-import-session")).toContainText(
    "Claude Code or Devin session",
  );
  await expectNotShown(page.getByText(/codex/i));
});
