// changes-from-upstream.md: B.2 (no pairing), B.4 (no self-update), B.5 (no connected hosts),
// B.12 (subagent approval locked), B.14 (hidden cards), A.8 (idle release switch).
import { expect, test } from "@playwright/test";
import {
  baseUrl,
  expectNotShown,
  openHostSection,
  switchOf,
  type HostSection,
} from "../support/navigation";

const HOST_SECTIONS: HostSection[] = [
  "host",
  "projects",
  "connections",
  "agents",
  "metadata",
  "voice",
  "workspaces",
  "providers",
  "usage",
  "terminals",
  "plugins",
];

test("the hidden cards are not shown anywhere on the local host's pages", async ({ page }) => {
  for (const section of HOST_SECTIONS) {
    await openHostSection(page, section);
    // Give the section its content before judging that something is absent.
    await expect(page.getByTestId("settings-detail-header-title")).toBeVisible();
    await page.waitForTimeout(800);

    const where = `section ${section}`;
    const absent = {
      "Update daemon card": page.getByTestId("host-page-update-card"),
      "Update daemon button": page.getByTestId("host-page-update-button"),
      "Remove host card": page.getByTestId("host-page-remove-host-button"),
      "browser tools card": page.getByTestId("host-page-browser-tools-card"),
      "agent skills card": page.getByTestId("host-agent-skills-card"),
      "agent skills (unavailable) card": page.getByTestId("host-agent-skills-unavailable"),
      "agent tools card": page.getByTestId("host-page-agent-tools-card"),
      "pair device row": page.getByTestId("host-page-pair-device-row"),
      "pair device card": page.getByTestId("host-page-pair-device-card"),
    };
    for (const [name, locator] of Object.entries(absent)) {
      await expect(locator.filter({ visible: true }), `${name} on ${where}`).toHaveCount(0);
    }
    await expectNotShown(page.getByText(/update daemon/i));
    await expectNotShown(page.getByText(/remove host/i));
    await expectNotShown(page.getByText(/pair device|pairing/i));
    await expectNotShown(page.getByText(/orchestration skills|browser tools/i));
  }
});

test("the host page keeps Restart daemon", async ({ page }) => {
  await openHostSection(page, "host");
  await expect(page.getByTestId("host-page-restart-button")).toBeVisible();
});

test("Add host offers a direct connection only, no pairing link", async ({ page }) => {
  await page.goto(baseUrl());
  await page.getByTestId("sidebar-hosts-trigger").click();
  await page.getByText("Add host", { exact: true }).click();

  const modal = page.getByTestId("add-host-method-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("add-host-method-direct")).toBeVisible();
  await expect(page.getByTestId("add-host-method-pair-link")).toHaveCount(0);
  await expectNotShown(modal.getByText(/pair|scan|qr|link|relay/i));
});

test("the idle agent release switch persists across a reload", async ({ page }) => {
  await openHostSection(page, "agents");
  const idle = switchOf(page, "host-page-idle-runtime-cleanup-switch");
  await expect(idle).toBeVisible();
  const initial = await idle.getAttribute("aria-checked");
  expect(initial).toBe("true"); // upstream's default is on

  try {
    await idle.click();
    await expect(idle).toHaveAttribute("aria-checked", "false");
    await expect(idle).toBeEnabled();

    await page.reload();
    const afterReload = switchOf(page, "host-page-idle-runtime-cleanup-switch");
    await expect(afterReload).toBeVisible();
    await expect(afterReload).toHaveAttribute("aria-checked", "false");
  } finally {
    // Leave the daemon as found for the specs that follow.
    const current = switchOf(page, "host-page-idle-runtime-cleanup-switch");
    if ((await current.getAttribute("aria-checked")) === "false") {
      await current.click();
      await expect(current).toHaveAttribute("aria-checked", "true");
    }
  }
});

test("subagent approval is on and locked", async ({ page }) => {
  await openHostSection(page, "agents");
  await expect(page.getByTestId("host-page-subagent-approval-card")).toBeVisible();
  const approval = switchOf(page, "host-page-subagent-approval-switch");
  await expect(approval).toHaveAttribute("aria-checked", "true");
  await expect(approval).toHaveAttribute("aria-disabled", "true");

  // A click must change nothing, here or after a reload.
  await approval.click({ force: true });
  await page.waitForTimeout(500);
  await expect(approval).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(switchOf(page, "host-page-subagent-approval-switch")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
