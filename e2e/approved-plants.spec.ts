import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });

test('visitor can choose an approved plant, inspect its cuts, and join the queue', async ({ page }, info) => {
  await page.goto('/plant');
  await page.getByRole('button', { name: 'Browse approved sprites' }).click();
  await expect(page.getByRole('heading', { name: 'Your sprite sticker' })).toBeVisible();
  await page.getByRole('radio', { name: /Strawberry/i }).check();
  await page.getByRole('button', { name: 'Three stickers' }).click();
  await expect(page.locator('.sticker-preview path').first()).toBeVisible();
  const join = page.getByRole('button', { name: 'Join print queue' });
  await expect(join).toBeEnabled();
  await page.screenshot({ path: info.outputPath('approved-strawberry-preview.png'), fullPage: true });
  await join.click();
  await expect(page.getByRole('heading', { name: 'In the print queue' })).toBeVisible();
});
