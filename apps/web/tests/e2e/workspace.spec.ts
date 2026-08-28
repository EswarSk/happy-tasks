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
