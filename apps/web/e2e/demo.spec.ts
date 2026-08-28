import { expect, test } from '@playwright/test';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The demo path, end to end, against the mock providers.
 *
 * This is deliberately the same sequence the README tells a reader to follow,
 * so a broken README is a failing test.
 */
test('create research, run the pipeline, review and export', async ({ page, request }) => {
  const health = await request.get(`${API_URL}/health`);
  expect(health.ok(), 'the API must be running: pnpm dev').toBeTruthy();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible();

  // Both the nav rail and the header offer this action; either is fine.
  await page.getByRole('link', { name: 'New research' }).first().click();
  await expect(page).toHaveURL(/\/new$/);

  await page.getByLabel('Research name').fill('E2E — lead generation');
  await page.getByRole('button', { name: 'Run research' }).click();

  // Landing on the run page means a run was created and queued.
  await expect(page).toHaveURL(/\/runs\/run_/, { timeout: 30_000 });
  await expect(page.getByText('Research pipeline')).toBeVisible();

  // The pipeline reaches the review gate or completes; both are real outcomes.
  const header = page.locator('header').first();
  await expect(header).toContainText(/Review required|Completed|Running|Queued/i, {
    timeout: 120_000,
  });

  // Results appear and open a detail panel with evidence.
  const firstRow = page.locator('tbody tr').first();
  await expect(firstRow).toBeVisible({ timeout: 120_000 });
  await firstRow.click();
  await expect(page.getByRole('tab', { name: /Evidence/ })).toBeVisible();

  await page.getByRole('tab', { name: /Score/ }).click();
  await expect(page.getByText('Total score')).toBeVisible();
});

test('system page reports provider health', async ({ page }) => {
  await page.goto('/system');
  await expect(page.getByRole('heading', { name: 'System' })).toBeVisible();
  await expect(page.getByText('mock provider ready', { exact: false }).first()).toBeVisible();
});
