import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const desk = 'http://127.0.0.1:8090';
const firestore = 'http://127.0.0.1:8080/v1/projects/demo-natcut/databases/(default)/documents';

type Ticket = { submissionId: string; queueNumber: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeFirestoreValue(value: unknown): unknown {
  if (!isRecord(value)) throw new Error('Invalid Firestore value');
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.timestampValue === 'string') return value.timestampValue;
  if (typeof value.integerValue === 'string') return Number(value.integerValue);
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  if (typeof value.booleanValue === 'boolean') return value.booleanValue;
  if ('nullValue' in value) return null;
  if (isRecord(value.mapValue)) {
    if (value.mapValue.fields === undefined) return {};
    if (!isRecord(value.mapValue.fields)) throw new Error('Invalid Firestore map');
    return Object.fromEntries(Object.entries(value.mapValue.fields).map(([key, nested]) => [key, decodeFirestoreValue(nested)]));
  }
  if (isRecord(value.arrayValue)) {
    if (value.arrayValue.values === undefined) return [];
    if (!Array.isArray(value.arrayValue.values)) throw new Error('Invalid Firestore array');
    return value.arrayValue.values.map(decodeFirestoreValue);
  }
  throw new Error('Unsupported Firestore value');
}

function decodeFields(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.fields)) throw new Error('Invalid Firestore document');
  return Object.fromEntries(Object.entries(value.fields).map(([key, nested]) => [key, decodeFirestoreValue(nested)]));
}

async function document(request: APIRequestContext, path: string) {
  const response = await request.get(`${firestore}/${path}`, { headers: { authorization: 'Bearer owner' } });
  if (!response.ok()) throw new Error(`Firestore read failed (${response.status()}): ${await response.text()}`);
  return decodeFields(await response.json());
}

async function collection(request: APIRequestContext, name: string) {
  const response = await request.get(`${firestore}/${name}`, { headers: { authorization: 'Bearer owner' } });
  if (response.status() === 404) return [];
  if (!response.ok()) throw new Error(`Firestore read failed (${response.status()}): ${await response.text()}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error('Invalid Firestore collection');
  if (payload.documents === undefined) return [];
  if (!Array.isArray(payload.documents)) throw new Error('Invalid Firestore collection');
  return payload.documents.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string') throw new Error('Invalid Firestore document name');
    return { id: entry.name.split('/').at(-1) ?? '', fields: decodeFields(entry) };
  });
}

async function join(page: Page): Promise<Ticket> {
  await page.goto('/edit');
  await page.getByRole('button', { name: 'Join print queue' }).click();
  await expect(page.getByRole('heading', { name: 'In the print queue' })).toBeVisible();
  const match = (await page.getByText(/Queue #\d+/).innerText()).match(/\d+/);
  const submissionId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '');
  if (!match || !submissionId) throw new Error('Accepted ticket did not expose its queue identity');
  return { submissionId, queueNumber: Number(match[0]) };
}

test('two anonymous visitors complete the simulated operator pickup and opt-out survey in order', async ({ page, browser, request }) => {
  const operator = page;
  await operator.goto(desk);
  await expect(operator.getByRole('heading', { name: 'Simulator desk' })).toBeVisible({ timeout: 2500 });

  const alice = await browser.newPage();
  const bob = await browser.newPage();
  const first = await join(alice);
  const next = await join(bob);
  expect(next.queueNumber).toBe(first.queueNumber + 1);

  const row = (number: number) => operator.getByRole('row').filter({
    has: operator.getByRole('cell', { name: '#' + number, exact: true }),
  });
  await operator.getByRole('button', { name: 'Refresh' }).click();
  await expect(row(first.queueNumber)).toContainText('Queued');
  await expect(row(next.queueNumber)).toContainText('Queued');

  await operator.getByRole('button', { name: 'Claim next' }).click();
  await expect(row(first.queueNumber)).toContainText('Next');
  await expect(row(next.queueNumber)).toContainText('Queued');
  await alice.getByRole('button', { name: 'Refresh' }).click();
  await expect(alice.getByRole('heading', { name: 'You’re next' })).toBeVisible();
  await expect(alice.getByRole('button', { name: 'Leave queue' })).toBeDisabled();

  await operator.getByRole('button', { name: 'Start simulation' }).click();
  await expect.poll(async () => {
    await operator.getByRole('button', { name: 'Refresh' }).click();
    return row(first.queueNumber).innerText();
  }).toContain('Mark collected');
  await expect(row(next.queueNumber)).toContainText('Queued');

  const completed = await document(request, `submissions/${first.submissionId}`);
  const executionLease = completed.executionLease;
  const completionFence = completed.completionFence;
  expect(completed.publicStatus).toBe('ready');
  expect(isRecord(executionLease)).toBe(true);
  expect(isRecord(completionFence)).toBe(true);
  if (!isRecord(executionLease) || !isRecord(completionFence) || !isRecord(executionLease.evidence)) {
    throw new Error('Completed ticket is missing exact execution evidence');
  }
  expect(executionLease.workerId).toBe('dev-mac');
  expect(executionLease.token).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  expect(executionLease.evidence).toEqual({
    receipt: completed.artifact,
    manifestHash: completed.manifestHash,
    validation: completed.validation,
  });
  expect(completionFence).toEqual({
    submissionId: first.submissionId,
    eventId: completed.eventId,
    workerId: 'dev-mac',
    executionToken: executionLease.token,
    receipt: completed.artifact,
    manifestHash: completed.manifestHash,
    validation: completed.validation,
    completedAt: completed.updatedAt,
  });
  const slot = await request.get(`${firestore}/workerSlots/${String(completed.eventId)}`, {
    headers: { authorization: 'Bearer owner' },
  });
  expect(slot.status()).toBe(404);

  await alice.getByRole('button', { name: 'Refresh' }).click();
  await expect(alice.getByRole('heading', { name: /ready for pickup/i })).toBeVisible();
  await expect(alice.getByText('Simulation complete. No physical sticker was made.')).toBeVisible();

  await operator.getByRole('button', { name: 'Claim next' }).click();
  await expect(row(next.queueNumber)).toContainText('Next');
  await row(first.queueNumber).getByRole('button', { name: 'Mark collected' }).click();
  await expect(row(next.queueNumber)).toContainText('Next');
  await alice.getByRole('button', { name: 'Refresh' }).click();
  await expect(alice.getByRole('heading', { name: /collected/i })).toBeVisible();

  await alice.getByRole('radio', { name: '4 stars' }).check();
  await alice.getByRole('button', { name: 'Send feedback' }).click();
  await expect(alice.getByText('Thanks for your feedback!')).toBeVisible();
  const surveys = (await collection(request, 'surveys')).filter((entry) =>
    entry.fields.stickerSubmissionId === first.submissionId);
  expect(surveys).toHaveLength(1);
  const survey = surveys[0];
  if (!survey) throw new Error('Opt-out survey was not stored');
  expect(survey.fields.email).toBeNull();
  const leads = (await collection(request, 'marketingLeads')).filter((entry) =>
    entry.fields.optionalSubmissionId === survey.id);
  expect(leads).toEqual([]);

  await operator.getByRole('button', { name: 'Start simulation' }).click();
  await expect.poll(async () => {
    await operator.getByRole('button', { name: 'Refresh' }).click();
    return row(next.queueNumber).innerText();
  }).toContain('Mark collected');
  await bob.getByRole('button', { name: 'Refresh' }).click();
  await expect(bob.getByRole('heading', { name: /ready for pickup/i })).toBeVisible();
  await expect(bob.getByText('Simulation complete. No physical sticker was made.')).toBeVisible();
  await row(next.queueNumber).getByRole('button', { name: 'Mark collected' }).click();
  await bob.getByRole('button', { name: 'Refresh' }).click();
  await expect(bob.getByRole('heading', { name: /collected/i })).toBeVisible();
});
