import { expect, test } from '@playwright/test';

const controlUrl = 'http://127.0.0.1:8090';

async function submit(page: import('@playwright/test').Page) {
  await page.goto('/edit');
  await page.getByRole('button', { name: 'Join print queue' }).click();
  await expect(page).toHaveURL(/\/queue\/[^#]+#token=/);
  await expect(page.getByRole('heading', { name: 'In the print queue' })).toBeVisible();
}

test('leaving cancels the immutable job and rejoining goes behind the next visitor', async ({ browser, request }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await submit(first);
  await submit(second);

  const secondQueueText = await second.getByText(/Queue #\d+/).textContent();
  const secondQueueNumber = Number(secondQueueText?.match(/\d+/)?.[0]);

  await first.getByRole('button', { name: 'Leave queue' }).click();
  await expect(first.getByRole('heading', { name: 'You left the queue' })).toBeVisible();
  await first.getByRole('button', { name: 'Rejoin queue' }).click();
  await expect(first.getByRole('heading', { name: 'In the print queue' })).toBeVisible();
  const rejoinedQueueText = await first.getByText(/Queue #\d+/).textContent();
  const rejoinedQueueNumber = Number(rejoinedQueueText?.match(/\d+/)?.[0]);
  expect(rejoinedQueueNumber).toBeGreaterThan(secondQueueNumber);

  const claim = await request.post(`${controlUrl}/claim`);
  expect(claim.ok()).toBeTruthy();
  await second.getByRole('button', { name: 'Refresh' }).click();
  await expect(second.getByRole('heading', { name: 'You’re next' })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Leave queue' })).toBeDisabled();

  const start = await request.post(`${controlUrl}/start`);
  expect(start.status()).toBe(202);
  await expect.poll(async () => {
    await second.getByRole('button', { name: 'Refresh' }).click();
    return second.getByRole('heading').first().textContent();
  }, { timeout: 20_000 }).toContain('Ready for pickup');
  await first.getByRole('button', { name: 'Leave queue' }).click();
  await expect(first.getByRole('heading', { name: 'You left the queue' })).toBeVisible();

  await firstContext.close();
  await secondContext.close();
});
