import { expect, test, type Page } from '@playwright/test';

const desk = 'http://127.0.0.1:8090';

async function join(page: Page) {
  await page.goto('/edit');
  await page.getByRole('button', { name: 'Join print queue' }).click();
  await expect(page.getByRole('heading', { name: 'In the print queue' })).toBeVisible();
  return Number((await page.getByText(/Queue #\d+/).innerText()).match(/\d+/)![0]);
}

test('two desk tabs collect one simulated ticket while the next visitor can start', async ({ page, browser }) => {
  const operator = page;
  await operator.goto(desk);
  await expect(operator.getByRole('heading', { name: 'Simulator desk' })).toBeVisible({ timeout: 2500 });
  const secondTab = await operator.context().newPage();
  await secondTab.goto(desk);

  const alice = await browser.newPage();
  const bob = await browser.newPage();
  const first = await join(alice);
  const next = await join(bob);
  expect(next).toBe(first + 1);
  await operator.getByRole('button', { name: 'Refresh' }).click();
  const row = (tab: Page, number: number) => tab.getByRole('row').filter({ has: tab.getByRole('cell', { name: '#' + number, exact: true }) });
  await expect(row(operator, first)).toContainText('Queued');
  await operator.getByRole('button', { name: 'Claim next' }).click();
  await alice.getByRole('button', { name: 'Refresh' }).click();
  await expect(alice.getByRole('heading', { name: 'You’re next' })).toBeVisible();
  await expect(alice.getByRole('button', { name: 'Leave queue' })).toBeDisabled();
  await operator.getByRole('button', { name: 'Start simulation' }).click();
  await expect.poll(async () => {
    await operator.getByRole('button', { name: 'Refresh' }).click();
    return row(operator, first).innerText();
  }).toContain('Mark collected');
  await alice.getByRole('button', { name: 'Refresh' }).click();
  await expect(alice.getByRole('heading', { name: /ready for pickup/i })).toBeVisible();
  await operator.getByRole('button', { name: 'Claim next' }).click();
  await expect(row(operator, next)).toContainText('Next');
  await secondTab.getByRole('button', { name: 'Refresh' }).click();
  await expect(row(secondTab, first).getByRole('button', { name: 'Mark collected' })).toBeEnabled();
  const collections = [operator, secondTab].map(async (tab) => {
    const response = tab.waitForResponse((r) => r.url().includes('/collect/') && r.request().method() === 'POST');
    await row(tab, first).getByRole('button', { name: 'Mark collected' }).click();
    return (await response).status();
  });
  expect(await Promise.all(collections)).toEqual([200, 200]);
  await alice.getByRole('button', { name: 'Refresh' }).click();
  await expect(alice.getByRole('heading', { name: /collected/i })).toBeVisible();
  await operator.getByRole('button', { name: 'Start simulation' }).click();
  await expect.poll(async () => {
    await bob.getByRole('button', { name: 'Refresh' }).click();
    return bob.getByRole('heading').innerText();
  }).toMatch(/ready for pickup/i);
});
