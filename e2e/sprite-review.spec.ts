import { expect, test } from '@playwright/test';
import { assetPngFilename } from '@natcut/render';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const exec = promisify(execFile);

test.skip(process.platform !== 'darwin', 'Building the review packet requires macOS.');

const review = test.extend<{ packets: { url: string; directory: string } }>({
  async packets({}, use) {
    const directory = await mkdtemp(path.join(tmpdir(), 'natcut-sprite-review-e2e-'));
    const server = createServer(async (request, response) => {
      const match = /^\/(first|second|wrapped)\/(index\.html|[a-f0-9]{64}\.(?:jpg|png))$/.exec(request.url ?? '');
      if (!match) {
        response.writeHead(404).end();
        return;
      }
      try {
        const file = path.join(directory, match[0]);
        const extension = path.extname(file);
        const types = new Map([['.html', 'text/html; charset=utf-8'], ['.jpg', 'image/jpeg'], ['.png', 'image/png']]);
        const contents = await readFile(file);
        response.writeHead(200, { 'Content-Type': types.get(extension) ?? 'application/octet-stream' }).end(contents);
      } catch {
        response.writeHead(404).end();
      }
    });
    try {
      const input = path.join(directory, 'source');
      await mkdir(input);
      const artwork = (id: string) => path.join(root, 'packages/render/catalog/artwork', assetPngFilename(id));
      const monstera = artwork('sprite/monstera-v1');
      const pear = artwork('sprite/c7e71948f761c05d6361441293e262f6f11ed44de8dee2e3956a39281e91b966');
      await Promise.all([
        sharp(monstera).withIccProfile('srgb').png().toFile(path.join(input, 'monstera-a.png')),
        sharp(monstera).flop().withIccProfile('p3').png().toFile(path.join(input, 'monstera-b.png')),
        sharp(monstera).modulate({ hue: 37 }).withIccProfile('srgb').png().toFile(path.join(input, 'monstera-c.png')),
        sharp(pear).withIccProfile('srgb').png().toFile(path.join(input, 'pear.png')),
        sharp(monstera).resize(640, 480, { fit: 'contain', background: '#adbc99' })
          .flatten({ background: '#adbc99' }).jpeg().toFile(path.join(input, 'monstera.jpg')),
        sharp(pear).resize(640, 480, { fit: 'contain', background: '#d0bc91' })
          .flatten({ background: '#d0bc91' }).jpeg().toFile(path.join(input, 'pear.jpg')),
      ]);
      const manifest = path.join(input, 'manifest.json');
      const plants = [
        { name: 'Monstera', scientificName: 'Monstera deliciosa', reference: 'monstera.jpg', candidates: ['monstera-a.png', 'monstera-b.png', 'monstera-c.png'] },
        { name: 'Prickly pear with an intentionally long common name for narrow screens', reference: 'pear.jpg', candidates: ['pear.png'] },
      ];
      await writeFile(manifest, JSON.stringify({ version: 1, plants }));
      const build = (out: string) => exec(process.execPath, ['scripts/sprite-review.ts', '--input', manifest, '--out', path.join(directory, out)], { cwd: root });
      await build('first');
      await sharp(pear).flop().withIccProfile('p3').png().toFile(path.join(input, 'pear.png'));
      await build('second');
      const variants = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
        const filename = `variant-${index}.png`;
        await sharp(monstera).modulate({ hue: (index + 2) * 37 }).withIccProfile('srgb').png().toFile(path.join(input, filename));
        return filename;
      }));
      await writeFile(manifest, JSON.stringify({ version: 1, plants: plants.map((plant) =>
        plant.name === 'Monstera' ? { ...plant, candidates: variants } : plant) }));
      await build('wrapped');

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address.');
      await use({ directory, url: `http://127.0.0.1:${address.port}` });
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
});

review('compares, scores, replaces an approval and exports the exact importer roster', async ({ page, packets }, info) => {
  const first = `${packets.url}/first/index.html`;
  const outsideRequests: string[] = [];
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === packets.url) return route.continue();
    outsideRequests.push(route.request().url());
    await route.abort();
  });
  await page.goto(first);
  const exportButton = page.getByRole('button', { name: 'Export roster' });
  await expect(exportButton).toBeDisabled({ timeout: 1_500 });
  const progress = page.getByRole('status');
  const monstera = page.getByRole('region', { name: 'Monstera', exact: true });
  const pear = page.getByRole('region', { name: /^Prickly pear/ });
  expect((await monstera.locator('header').innerText()).split(/\n+/)).toEqual(['Monstera', 'Monstera deliciosa']);
  await expect(monstera.getByRole('img', { name: 'Reference photo of Monstera' })).toBeVisible();
  const images = page.getByRole('img');
  await expect(images).toHaveCount(6);
  await expect.poll(() => images.evaluateAll((items) => items.every((item) => item instanceof HTMLImageElement && item.naturalWidth > 0)))
    .toBe(true);
  expect(outsideRequests).toEqual([]);

  const candidate = monstera.getByRole('article').first();
  const cuteness = candidate.getByRole('group', { name: 'Cuteness' });
  const accuracy = candidate.getByRole('group', { name: 'Accuracy' });
  await expect(cuteness.getByRole('radio')).toHaveCount(5);
  await expect(accuracy.getByRole('radio')).toHaveCount(5);
  const cuteOne = cuteness.getByRole('radio', { name: '1', exact: true });
  const cuteTwo = cuteness.getByRole('radio', { name: '2', exact: true });
  await page.keyboard.press('Tab');
  await expect(cuteOne).toBeFocused();
  await expect(cuteOne.locator('..')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('ArrowRight');
  await expect(cuteTwo).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(accuracy.getByRole('radio', { name: '1', exact: true })).toBeFocused();
  const accurateFive = accuracy.getByRole('radio', { name: '5', exact: true });
  await accurateFive.check();

  const approve = monstera.getByRole('radio', { name: /^Approve/ });
  await approve.nth(0).check();
  await expect(progress).toContainText('1 of 2');
  await approve.nth(1).check();
  await expect(approve.nth(0)).not.toBeChecked();
  await expect(approve.nth(1)).toBeChecked();
  await expect(approve.nth(1).locator('..')).toHaveText('Approved sprite', { useInnerText: true });
  await expect(progress).toContainText('0 of 2');
  const missingScores = progress.getByText('Score both fields on approved sprites.');
  await expect(missingScores).toBeVisible();
  await expect(exportButton).toBeDisabled();
  await page.reload();
  await expect(cuteTwo).toBeChecked();
  await expect(accurateFive).toBeChecked();
  await expect(approve.nth(1)).toBeChecked();
  await expect(progress).toContainText('0 of 2 plants complete');

  const second = monstera.getByRole('article').nth(1);
  await second.getByRole('group', { name: 'Cuteness' }).getByRole('radio', { name: '4' }).check();
  await expect(progress).toContainText('0 of 2 plants complete');
  await second.getByRole('group', { name: 'Accuracy' }).getByRole('radio', { name: '5' }).check();
  await expect(progress).toContainText('1 of 2 plants complete');
  await expect(missingScores).toBeHidden();

  await page.goto(`${packets.url}/second/index.html`);
  await expect(cuteTwo).not.toBeChecked();
  await expect(approve.nth(1)).not.toBeChecked();
  await expect(progress).toContainText('0 of 2 plants complete');
  await page.goto(first);
  await expect(progress).toContainText('1 of 2 plants complete');
  await pear.getByRole('radio', { name: /^Approve/ }).check();
  await expect(exportButton).toBeDisabled();
  await pear.getByRole('group', { name: 'Cuteness' }).getByRole('radio', { name: '3' }).check();
  await expect(exportButton).toBeDisabled();
  await pear.getByRole('group', { name: 'Accuracy' }).getByRole('radio', { name: '5' }).check();
  await expect(progress).toContainText('2 of 2 plants complete');
  await expect(exportButton).toBeEnabled();

  await approve.nth(2).check();
  await expect(exportButton).toBeDisabled();
  await expect(progress).toContainText('1 of 2 plants complete');
  await page.reload();
  await expect(approve.nth(2)).toBeChecked();
  await expect(exportButton).toBeDisabled();
  await approve.nth(1).check();
  await expect(exportButton).toBeEnabled();

  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  expect(download.suggestedFilename()).toBe('roster.json');
  const roster = path.join(packets.directory, 'first', 'roster.json');
  await download.saveAs(roster);
  const selected = async (item: typeof monstera, index: number) => {
    const source = await item.getByRole('article').nth(index).getByRole('img').getAttribute('src');
    if (!source) throw new Error('Expected candidate image file.');
    return path.basename(source);
  };
  const packet = JSON.parse(await page.locator('#review-packet').textContent() ?? '');
  const selectedMonstera = await selected(monstera, 1);
  const selectedPear = await selected(pear, 0);
  expect(JSON.parse(await readFile(roster, 'utf8'))).toEqual([
    { name: 'Monstera', scientificName: 'Monstera deliciosa', file: selectedMonstera,
      reviewedSource: packet.plants[0].candidateSources[selectedMonstera] },
    { name: 'Prickly pear with an intentionally long common name for narrow screens', file: selectedPear,
      reviewedSource: packet.plants[1].candidateSources[selectedPear] },
  ]);
  const catalog = path.join(packets.directory, 'imported');
  await exec(process.execPath, ['scripts/import-sprites.mjs', '--input', roster, '--out', catalog], { cwd: root });
  expect(JSON.parse(await readFile(path.join(catalog, 'index.json'), 'utf8')).sprites).toHaveLength(2);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ fullPage: true, path: info.outputPath('desktop-review.png') });
});

review('opens directly from disk and fits a narrow touch viewport', async ({ page, packets }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(pathToFileURL(path.join(packets.directory, 'first/index.html')).href);
  const monstera = page.getByRole('region', { name: 'Monstera', exact: true });
  const pearHeading = page.getByRole('heading', { name: /^Prickly pear/ });
  const approval = monstera.getByRole('radio', { name: 'Approve sprite' }).first();
  await expect(approval).toBeVisible({ timeout: 1_500 });
  await approval.check();
  await page.reload();
  await expect(monstera.getByRole('radio', { name: 'Approved sprite' })).toBeChecked();
  await expect(page.getByRole('status')).toContainText('0 of 2');
  await expect(monstera.getByRole('figure', { name: 'Reference photo' })).toHaveCSS('position', 'static');
  await expect.poll(() => page.getByRole('img').evaluateAll((images) => images.every((image) =>
    image instanceof HTMLImageElement && image.naturalWidth > 0))).toBe(true);

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  const lineCount = await pearHeading.evaluate((heading) => heading.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(heading).lineHeight));
  expect(lineCount).toBeGreaterThanOrEqual(2);
  const targets = await page.locator('label, button').evaluateAll((elements) => elements.map((element) => {
    const { width, height } = element.getBoundingClientRect();
    return Math.min(width, height);
  }));
  expect(Math.min(...targets)).toBeGreaterThanOrEqual(44);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('mobile-review.png') });
  await page.setViewportSize({ width: 320, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

review('keeps the reference visible beside later rows and within its plant on desktop', async ({ page, packets }, info) => {
  await page.goto(`${packets.url}/wrapped/index.html`);
  const monstera = page.getByRole('region', { name: 'Monstera', exact: true });
  const first = monstera.getByRole('article').first();
  const last = monstera.getByRole('article').last();
  const reference = monstera.getByRole('figure', { name: 'Reference photo' });
  const firstCard = await first.boundingBox();
  const lastCard = await last.boundingBox();
  if (!firstCard || !lastCard) throw new Error('Expected candidate cards to be visible.');
  expect(lastCard.y).toBeGreaterThan(firstCard.y + firstCard.height);
  await page.evaluate((top) => scrollTo(0, top), firstCard.y + firstCard.height);
  const toolbarBottom = await page.getByRole('banner').evaluate((element) => element.getBoundingClientRect().bottom);
  await expect.poll(() => reference.evaluate((element) => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(toolbarBottom);
  expect(await reference.evaluate((element) => element.getBoundingClientRect().top)).toBeLessThan(toolbarBottom + 25);
  await page.screenshot({ path: info.outputPath('desktop-sticky-reference.png') });

  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  const plantBottom = await monstera.evaluate((element) => element.getBoundingClientRect().bottom);
  const end = await reference.evaluate((element) => element.getBoundingClientRect().toJSON());
  expect(end.bottom).toBeLessThanOrEqual(plantBottom);
  expect(end.top).toBeLessThan(toolbarBottom);
});
