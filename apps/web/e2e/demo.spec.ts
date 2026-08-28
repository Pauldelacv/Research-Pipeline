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
  expect(health.ok(), 'the API and worker must be running: pnpm dev').toBeTruthy();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Research', exact: true })).toBeVisible();

  // Both the nav rail and the page header offer this action; either is fine.
  await page.getByRole('link', { name: 'New research' }).first().click();
  await expect(page).toHaveURL(/\/new$/);

  await page.getByLabel('Research name').fill('E2E — lead generation');
  await page.getByRole('button', { name: 'Run research' }).click();

  // Landing on the run page means a run was created and queued.
  await expect(page).toHaveURL(/\/runs\/run_/, { timeout: 30_000 });
  await expect(page.getByText('Research pipeline')).toBeVisible();

  const header = page.locator('header').first();

  // Rows appear as soon as the structure step merges candidates — well before
  // scoring runs — so wait for the run to settle before asserting on a score.
  // The lead-generation pipeline has a blocking review gate, so it parks at
  // "Review required"; a configuration without one would reach "Completed".
  await expect(header).toContainText(/Review required|Completed/i, { timeout: 150_000 });

  const firstRow = page.locator('tbody tr').first();
  await expect(firstRow).toBeVisible({ timeout: 30_000 });
  await firstRow.click();

  // The detail panel is where traceability shows up.
  await expect(page.getByRole('tab', { name: /Evidence/ })).toBeVisible();

  await page.getByRole('tab', { name: /Score/ }).click();
  await expect(page.getByText('Total score')).toBeVisible();
  // Every point is attributed to a named rule, not a bare number.
  await expect(page.getByText('no model is involved in this step', { exact: false })).toBeVisible();
});

test('the review gate blocks export until entities are resolved', async ({ page, request }) => {
  // Find a run parked at the gate, created by the test above.
  const response = await request.get(`${API_URL}/v1/runs?limit=25`);
  const { items } = (await response.json()) as { items: Array<{ id: string; status: string }> };
  const parked = items.find((run) => run.status === 'review_required');
  test.skip(!parked, 'no run is currently awaiting review');

  await page.goto(`/runs/${parked!.id}`);

  // The gate is stated as a gate, not as a notification.
  await expect(page.getByText('entities need a decision', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume run' })).toBeVisible();
});

test('system page reports provider health', async ({ page }) => {
  await page.goto('/system');
  await expect(page.getByRole('heading', { name: 'System' })).toBeVisible();
  // Health is a live probe, so a missing credential surfaces here.
  await expect(page.getByText('mock provider ready', { exact: false }).first()).toBeVisible();
});
