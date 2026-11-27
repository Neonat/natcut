import { expect, test } from '@playwright/test';
import { sprites } from '@natcut/render/browser';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

test.use({ viewport: { width: 375, height: 812 }, isMobile: true, deviceScaleFactor: 1, reducedMotion: 'reduce' });

test('the selected rehearsal sprite survives a queue round trip and reproduces the worker contour offline', async ({ page, request }, info) => {
  await page.goto('/edit');
  const choices = page.getByRole('radio');
  test.skip(sprites.length < 2, 'Selection round trip needs at least two configured sprites.');
  await expect(choices).toHaveCount(sprites.length);
  const first = choices.first();
  const second = choices.nth(1);
  await expect(first).toBeChecked();
  const submit = page.getByRole('button', { name: 'Join print queue' });
  await expect(submit).toBeEnabled();
  const sprite = page.locator('.sticker-preview image').first();
  const original = await sprite.getAttribute('href');
  await second.check();
  await expect(sprite).not.toHaveAttribute('href', original!);
  await expect(submit).toBeEnabled();
  const selectedUrl = await sprite.getAttribute('href');
  const contourPaths = () => page.locator('.sticker-preview path').evaluateAll((paths) =>
    paths.map((p) => p.getAttribute('d')!.replace(/([ML]) /g, '$1')).join(' '));
  const contours = await contourPaths();
  expect(contours.length).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('mobile-picker.png') });
  await page.setViewportSize({ width: 1060, height: 820 });
  await page.screenshot({ path: info.outputPath('desktop-picker.png') });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: /Wide/ }).click();
  await expect(submit).toBeEnabled();
  const wideContours = await contourPaths();
  expect(wideContours).not.toEqual(contours);
  await page.screenshot({ path: info.outputPath('mobile-border.png') });
  const accepted = page.waitForResponse((r) => r.url().endsWith('/v1/submissions') && r.request().method() === 'POST');
  await submit.click();
  const response = await accepted;
  expect(response.status()).toBe(201);
  const manifest = response.request().postDataJSON().manifest;
  await expect(page.getByRole('heading', { name: 'In the print queue' })).toBeVisible();

  const submissionId = new URL(page.url()).pathname.split('/').pop();
  const document = await request.get(`http://127.0.0.1:8080/v1/projects/demo-natcut/databases/(default)/documents/submissions/${submissionId}`, {
    headers: { authorization: 'Bearer owner' },
  });
  expect(document.status()).toBe(200);
  const { fields } = await document.json();
  expect(fields.manifest.mapValue.fields.spriteAssetId.stringValue).toBe(manifest.spriteAssetId);
  const prove = async (out: string, design: typeof manifest) => {
    const file = info.outputPath(out + '.json');
    await writeFile(file, JSON.stringify(design));
    await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/proof-sheet.ts', '--manifest', file, '--out', info.outputPath(out)]);
    return JSON.parse(await readFile(info.outputPath(out, 'evidence.json'), 'utf8'));
  };
  const proof = await prove('submitted', manifest);
  expect(proof.manifestHash).toBe(fields.manifestHash.stringValue);
  expect(proof.cutMask.sha256).toBe(fields.validation.mapValue.fields.rasterHash.stringValue);
  const overlay = await readFile(info.outputPath('submitted', 'cut-overlay.svg'), 'utf8');
  expect([...overlay.matchAll(/<path d="([^"]+)"\/>/g)].map((m) => m[1]).join(' ')).toEqual(wideContours);
  await page.getByRole('button', { name: 'Leave queue' }).click();
  await page.getByRole('button', { name: 'Rejoin queue' }).click();
  await expect(second).toBeChecked();
  await expect(sprite).toHaveAttribute('href', selectedUrl!);
  await expect(page.getByRole('button', { name: /Wide/ })).toHaveAttribute('aria-pressed', 'true');
});

test('fetches only the planned artwork for geometry and can retry a failed image decode', async ({ page, context }) => {
  let failSelected = true;
  let selectedPath = '';
  const fetches: string[] = [];
  await context.route(/\/[a-f0-9]{64}\.png(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === 'fetch') {
      fetches.push(path);
    }
    if (failSelected && path === selectedPath) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'temporary failure' });
    await route.continue();
  });
  await page.goto('/edit');
  const choices = page.getByRole('radio');
  test.skip(sprites.length < 2, 'Retry selection needs at least two configured sprites.');
  await expect(choices).toHaveCount(sprites.length);
  const selected = choices.nth(1);
  selectedPath = new URL((await selected.locator('..').locator('img').getAttribute('src'))!, page.url()).pathname;
  const submit = page.getByRole('button', { name: 'Join print queue' });
  await expect(submit).toBeEnabled();
  expect(fetches).toHaveLength(2);
  expect(fetches).not.toContain(selectedPath);
  await page.getByRole('button', { name: /Tight/ }).click();
  await expect(submit).toBeEnabled();
  expect(fetches).toHaveLength(2);
  await selected.check();
  await expect(page.getByRole('alert')).toContainText(/preview/i);
  await expect(submit).toHaveCount(0);
  failSelected = false;
  await page.getByRole('button', { name: /Retry preview/i }).click();
  await expect(submit).toBeEnabled();
  expect(await selected.locator('..').locator('img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  expect(fetches.filter((url) => url === selectedPath)).toHaveLength(2);
});
