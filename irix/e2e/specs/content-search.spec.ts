// changes-from-upstream.md: 30 (irix-content-search: ripgrep-backed search and replace in the
// Files panel). The daemon's plugin looks for `rg` on PATH (IRIX_RG_PATH is not passed through by
// global-setup), so these tests skip when ripgrep is not installed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createFixtureWorkspace,
  openFilesPanel,
  openWorkspace,
  type FixtureWorkspace,
} from "../support/workspace-fixture";

const hasRipgrep = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
test.skip(!hasRipgrep, "ripgrep not available");

const A_TXT = [
  "first line",
  "second line",
  "the needle is here",
  "fourth line",
  "the Needle with a capital",
  "sixth line",
  "many needles in a row",
  "eighth line",
  "",
].join("\n");

const B_LINES = Array.from({ length: 150 }, (_, index) => `filler ${index + 1}`);
B_LINES[119] = "deep needle on line 120";
const B_TXT = `${B_LINES.join("\n")}\n`;

let workspace: FixtureWorkspace;

test.beforeAll(async () => {
  workspace = await createFixtureWorkspace({
    "src/a.txt": A_TXT,
    "src/b.txt": B_TXT,
    "c.txt": "nothing to see\n",
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

function results(page: Page) {
  return page.getByTestId("content-search-result").filter({ visible: true });
}

function fileRows(page: Page) {
  return page.getByTestId("content-search-file").filter({ visible: true });
}

async function openSearch(page: Page, query: string): Promise<void> {
  await openWorkspace(page, workspace);
  await openFilesPanel(page);
  await page.getByTestId("files-search").filter({ visible: true }).click();
  const input = page.getByTestId("content-search-input").filter({ visible: true });
  await expect(input).toBeVisible();
  await input.fill(query);
}

test("results are grouped by file with the match line, and the toggles change them", async ({
  page,
}) => {
  await openSearch(page, "needle");

  // Two files hold the word; c.txt does not.
  await expect(fileRows(page)).toHaveCount(2);
  await expect(fileRows(page).filter({ hasText: "a.txt" })).toHaveCount(1);
  await expect(fileRows(page).filter({ hasText: "b.txt" })).toHaveCount(1);
  await expect(fileRows(page).filter({ hasText: "c.txt" })).toHaveCount(0);

  // Case-insensitive by default: needle, Needle and needles in a.txt, one line in b.txt.
  await expect(results(page)).toHaveCount(4);
  // The order of the file groups is ripgrep's (it searches in parallel), so compare sorted.
  const lineNumbers = async () =>
    (
      await page
        .getByTestId("content-search-line-number")
        .filter({ visible: true })
        .allTextContents()
    )
      .map(Number)
      .sort((a, b) => a - b);
  await expect.poll(lineNumbers).toEqual([3, 5, 7, 120]);
  await expect(results(page).filter({ hasText: "the needle is here" })).toHaveCount(1);

  // Match case drops "Needle".
  await page.getByTestId("content-search-case").filter({ visible: true }).click();
  await expect(results(page)).toHaveCount(3);
  await expect.poll(lineNumbers).toEqual([3, 7, 120]);
  await page.getByTestId("content-search-case").filter({ visible: true }).click();
  await expect(results(page)).toHaveCount(4);

  // Whole word drops "needles".
  await page.getByTestId("content-search-word").filter({ visible: true }).click();
  await expect(results(page)).toHaveCount(3);
  await expect.poll(lineNumbers).toEqual([3, 5, 120]);
  await page.getByTestId("content-search-word").filter({ visible: true }).click();
  await expect(results(page)).toHaveCount(4);

  // `n.edle` is literal text until the regex switch is on.
  await page.getByTestId("content-search-input").filter({ visible: true }).fill("n.edle");
  await expect(results(page)).toHaveCount(0);
  await page.getByTestId("content-search-regex").filter({ visible: true }).click();
  await expect(results(page)).toHaveCount(4);
});

test("opening a result opens the file at the match line", async ({ page }) => {
  await openSearch(page, "deep needle");
  await expect(results(page)).toHaveCount(1);
  await results(page).first().click();

  // b.txt is 150 lines, so line 120 is only on screen if the editor scrolled to it.
  const editor = page.locator(".cm-editor").filter({ visible: true }).first();
  await expect(editor).toBeVisible();
  const line = editor.locator(".cm-line", { hasText: "deep needle on line 120" });
  await expect(line).toBeVisible();
  await expect(line).toBeInViewport();
  await expect(editor.locator(".cm-line", { hasText: /^filler 1$/ })).toHaveCount(0);
});

test("replace previews, replaces one match on disk and leaves the rest alone", async ({ page }) => {
  await openSearch(page, "needle");
  await expect(results(page)).toHaveCount(4);

  await page.getByTestId("content-search-replace-toggle").filter({ visible: true }).click();
  await page.getByTestId("content-search-replace-input").filter({ visible: true }).fill("pin");

  // The preview shows the replacement after the struck-out match.
  const previews = page.getByTestId("content-search-preview").filter({ visible: true });
  await expect(previews).toHaveCount(4);
  await expect(previews.first()).toContainText("pin");
  await expect(
    page.getByTestId("content-search-replace-plan").filter({ visible: true }),
  ).toHaveText("Replace 4 in 2 files");
  // Previewing writes nothing.
  expect(readFileSync(path.join(workspace.directory, "src/a.txt"), "utf8")).toBe(A_TXT);

  // Replace only line 3 of a.txt.
  const lineThree = results(page).filter({ hasText: /^3(?!\d)/ });
  await expect(lineThree).toHaveCount(1);
  await lineThree.hover();
  await lineThree.getByTestId("content-search-replace-match").click();
  await expect(
    page.getByTestId("content-search-replace-summary").filter({ visible: true }),
  ).toBeVisible();

  const expectedA = A_TXT.replace("the needle is here", "the pin is here");
  await expect
    .poll(() => readFileSync(path.join(workspace.directory, "src/a.txt"), "utf8"))
    .toBe(expectedA);
  // The other matches of a.txt, the other file and the file without matches are byte-identical.
  expect(readFileSync(path.join(workspace.directory, "src/b.txt"), "utf8")).toBe(B_TXT);
  expect(readFileSync(path.join(workspace.directory, "c.txt"), "utf8")).toBe("nothing to see\n");
  expect(expectedA).toContain("the Needle with a capital");
  expect(expectedA).toContain("many needles in a row");

  // The panel searches again: three matches are left.
  await expect(results(page)).toHaveCount(3);
});
