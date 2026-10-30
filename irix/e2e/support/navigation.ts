import { expect, type Locator, type Page } from "@playwright/test";
import { readDaemonState } from "./env";

export type HostSection =
  | "host"
  | "projects"
  | "connections"
  | "agents"
  | "metadata"
  | "voice"
  | "workspaces"
  | "providers"
  | "usage"
  | "terminals"
  | "plugins";

export function baseUrl(): string {
  return process.env.IRIX_E2E_BASE_URL ?? readDaemonState().baseUrl;
}

/** Opens Settings (the app picks the General section) and waits for the sidebar. */
export async function openSettings(page: Page): Promise<void> {
  await page.goto(`${baseUrl()}/settings`);
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
}

/**
 * Opens a section of the local host's settings page. The host is the daemon that served the page,
 * so its id is not known up front; the sidebar lists its sections.
 */
export async function openHostSection(page: Page, section: HostSection = "host"): Promise<void> {
  await openSettings(page);
  await page.getByTestId(`settings-host-section-${section}`).click();
  await expect(page).toHaveURL(new RegExp(`/settings/hosts/[^/]+/${section}$`));
  await expect(page.getByTestId("settings-detail-scroll-body")).toBeVisible();
}

/**
 * The element React Native Web renders for a Switch carrying `testID`: a `role="switch"` div with
 * `aria-checked` and `aria-disabled`.
 */
export function switchOf(page: Page, testID: string): Locator {
  return page.getByTestId(testID);
}

/** Asserts no element matching `locator` is visible. A display:none row counts as absent. */
export async function expectNotShown(locator: Locator): Promise<void> {
  await expect(locator.filter({ visible: true })).toHaveCount(0);
}

/** Waits until the app has connected to the daemon (the Overview shows it online). */
export async function waitForHostOnline(page: Page): Promise<void> {
  await openHostSection(page, "host");
  await expect(page.getByTestId("host-page-identity")).toBeVisible();
}
