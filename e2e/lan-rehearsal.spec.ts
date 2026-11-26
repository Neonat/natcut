import { expect, test } from '@playwright/test';
import { buildDevConfig } from '../scripts/dev-config.mjs';

const lan = process.env.NATCUT_E2E_LAN === '1';
const config = buildDevConfig({ lan });
const alias = 'natcut-rehearsal.test';
const origin = lan ? config.visitorOrigin : `http://${alias}:4174`;

test.use({
  launchOptions: lan ? {} : {
    args: [`--host-resolver-rules=MAP ${alias} 127.0.0.1`, '--no-proxy-server'],
  },
});

test('submits and refreshes an acknowledged fixture from insecure HTTP', async ({ page }) => {
  if (!lan) {
    // The alias exercises the browser security context with a loopback-only stack.
    // Translate its origin at the submission boundary. LAN mode exercises real CORS.
    await page.route('http://127.0.0.1:8088/**', async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), origin: config.visitorOrigin },
      });
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'access-control-allow-origin': origin },
      });
    });
  }

  await page.goto(`${origin}/edit?fixture=overlap`);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => globalThis.crypto?.subtle === undefined)).toBe(true);
  await expect(page.getByText(/simulation rehearsal/i)).toBeVisible();

  await page.getByRole('button', { name: /custom/i }).click();
  await page.getByRole('slider', { name: /custom cut border/i }).fill('2.4');
  await expect(page.getByRole('alert')).toContainText(/overlap|touch|merge/i);
  const accepted = page.waitForResponse((response) =>
    response.url().endsWith('/v1/submissions') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Print anyway' }).click();
  expect((await accepted).status()).toBe(201);
  await expect(page).toHaveURL(/\/queue\/[^#]+#token=/);
  await expect(page.getByText(/simulation rehearsal/i)).toBeVisible();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText(/Queue #\d+/)).toBeVisible();
  await page.getByRole('button', { name: 'Leave queue' }).click();
  await expect(page.getByRole('heading', { name: 'You left the queue' })).toBeVisible();
});

test('LAN listeners are reachable only as intended', async ({ request }) => {
  test.skip(!lan, 'Requires an assigned LAN IPv4 address and the opt-in LAN runner.');
  const api = config.visitorEnv.VITE_NATCUT_SUBMISSION_API_URL;
  const auth = config.visitorEnv.VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL;
  const allowed = await request.get(`${api}/health`, { headers: { origin } });
  expect(allowed.ok()).toBeTruthy();
  expect(allowed.headers()['access-control-allow-origin']).toBe(origin);
  const other = await request.get(`${api}/health`, { headers: { origin: 'http://127.0.0.1:4174' } });
  expect(other.headers()['access-control-allow-origin']).toBeUndefined();
  expect((await request.get(`${auth}/emulator/v1/projects/demo-natcut/config`)).ok()).toBeTruthy();
  expect((await request.get('http://127.0.0.1:8090/health')).ok()).toBeTruthy();
  for (const port of [8080, 8090]) {
    await expect(request.get(`http://${config.address}:${port}/`, { timeout: 2_000 })).rejects.toThrow();
  }
});
