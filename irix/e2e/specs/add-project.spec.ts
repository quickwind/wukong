// changes-from-upstream.md: B.7 (company GitLab is the only forge; Add project offers Clone from
// GitLab in place of GitHub).
import { expect, test } from "@playwright/test";
import { baseUrl, expectNotShown } from "../support/navigation";

test("Add project offers Clone from GitLab and not GitHub", async ({ page }) => {
  await page.goto(baseUrl());
  await page.getByTestId("sidebar-add-project").click();

  const flow = page.getByTestId("add-project-flow");
  await expect(flow).toBeVisible();
  await expect(flow.getByText("Clone from GitLab")).toBeVisible();
  // Upstream's "Clone from GitHub" row reuses the `...-method-github` testID for the GitLab row,
  // so only the visible text tells them apart.
  await expectNotShown(flow.getByText(/github/i));

  // The other methods Irix keeps.
  await expect(flow.getByText("Open folder")).toBeVisible();
  await expect(flow.getByText("New directory")).toBeVisible();
});
