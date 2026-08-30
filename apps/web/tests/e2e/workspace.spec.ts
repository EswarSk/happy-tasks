import { expect, test } from "@playwright/test";

test("opens a task dependency map from the virtualized workspace", async ({ page }) => {
  await page.goto("/");
  const task = page.locator('button[aria-label^="Open ATL-"]:visible').first();
  await expect(task).toBeVisible({ timeout: 15_000 });
  await task.click();

  await expect(page).toHaveURL(/\/projects\/[^/]+\/tasks\/[^/]+/, { timeout: 15_000 });
  await expect(page.locator('h2:has-text("Dependency map"):visible')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".dependency-map-canvas:visible")).toBeVisible();
  await expect(page.locator('h2:has-text("Properties"):visible')).toBeVisible();
});

test("filters the task list by tag", async ({ page }) => {
  await page.goto("/");
  const tagFilter = page.getByRole("textbox", { name: "Filter by tag" });
  await tagFilter.fill("Realtime");
  await expect(page.locator('button[aria-label^="Open ATL-"]:visible').first()).toBeVisible({ timeout: 15_000 });
});

test("keeps the task visible after attaching a file", async ({ page }) => {
  await page.goto("/");
  await page.locator('button[aria-label^="Open ATL-"]:visible').first().click();

  const details = page.getByLabel(/Task details for/);
  await expect(details).toBeVisible({ timeout: 15_000 });
  await expect(details).toHaveCount(1);

  await page.locator('input[type="file"]').setInputFiles({
    name: "acceptance-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("The task must remain visible after upload."),
  });

  await expect(page.getByText("File attached")).toBeVisible();
  await expect(details).toBeVisible();
  await expect(page.getByRole("link", { name: /acceptance-notes\.txt/ })).toBeVisible();
});
