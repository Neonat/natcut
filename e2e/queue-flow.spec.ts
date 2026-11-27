import { expect, test } from '@playwright/test';

import { command } from './operator-client.ts';

test('submits an acknowledged design and reaches pickup-ready through the simulator', async ({ page, request }) => {
  await page.goto('/edit?fixture=overlap');
  await expect(page.getByRole('heading', { name: 'Your sprite sticker' })).toBeVisible();
  await page.getByRole('button', { name: /custom/i }).click();
  await page.getByRole('slider', { name: /custom cut border/i }).fill('2.4');
  await expect(page.getByText('2.4 mm', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/overlap|touch|merge/i);
  await page.getByRole('button', { name: 'Print anyway' }).click();

  await expect(page).toHaveURL(/\/queue\/[^#]+#token=/);
  await expect(page.getByRole('slider')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'In the print queue' })).toBeVisible();

  const claim = await command(request, 'claim');
  expect(claim.ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('heading', { name: 'You’re next' })).toBeVisible();

  const start = await command(request, 'start');
  expect(start.status()).toBe(202);
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Refresh' }).click();
    return page.getByRole('heading').first().textContent();
  }).toContain('being made');
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Refresh' }).click();
    return page.getByRole('heading').first().textContent();
  }, { timeout: 20_000 }).toContain('Ready for pickup');
  await expect(page.getByText(/simulation rehearsal/i)).toBeVisible();
  await expect(page.getByText(/no physical sticker was made/i)).toBeVisible();
});
