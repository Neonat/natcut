import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const firestore = 'http://127.0.0.1:8080/v1/projects/demo-natcut/databases/(default)/documents';

async function submitAndCollect(page: Page, request: APIRequestContext) {
  await page.goto('/edit');
  await page.getByRole('button', { name: 'Join print queue' }).click();
  await expect(page).toHaveURL(/\/queue\/[^#]+#token=/);
  const submissionId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  const response = await request.patch(`${firestore}/submissions/${submissionId}?updateMask.fieldPaths=publicStatus`, {
    headers: { authorization: 'Bearer owner' },
    data: { fields: { publicStatus: { stringValue: 'collected' } } },
  });
  if (!response.ok()) throw new Error(`Could not mark collected (${response.status()}): ${await response.text()}`);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('heading', { name: 'Sticker collected' })).toBeVisible();
  return submissionId;
}

async function collection(request: APIRequestContext, name: string) {
  const response = await request.get(`${firestore}/${name}`, { headers: { authorization: 'Bearer owner' } });
  if (response.status() === 404) return [];
  expect(response.ok()).toBe(true);
  return ((await response.json()).documents ?? []) as Array<{ name: string; fields: Record<string, Record<string, unknown>> }>;
}

test('stores feedback independently from an optional normalized marketing email', async ({ browser, request }) => {
  const optOutContext = await browser.newContext();
  const optOutPage = await optOutContext.newPage();
  const optOutSubmission = await submitAndCollect(optOutPage, request);
  await optOutPage.getByRole('radio', { name: '4 stars' }).check();
  await optOutPage.getByRole('button', { name: 'Send feedback' }).click();
  await expect(optOutPage.getByText('Thanks for your feedback!')).toBeVisible();

  const surveysAfterOptOut = await collection(request, 'surveys');
  const optOutSurvey = surveysAfterOptOut.find((document) => document.fields.stickerSubmissionId?.stringValue === optOutSubmission)!;
  expect(optOutSurvey.fields.email).toEqual({ nullValue: null });
  const optOutSurveyId = optOutSurvey.name.split('/').pop();
  expect((await collection(request, 'marketingLeads')).some((document) =>
    document.fields.optionalSubmissionId?.stringValue === optOutSurveyId)).toBe(false);
  await optOutPage.reload();
  await expect(optOutPage.getByText('Thanks for your feedback!')).toBeVisible();
  const sharedLinkContext = await browser.newContext();
  const sharedLinkPage = await sharedLinkContext.newPage();
  await sharedLinkPage.goto(optOutPage.url());
  await expect(sharedLinkPage.getByRole('heading', { name: 'Sticker collected' })).toBeVisible();
  await expect(sharedLinkPage.getByRole('checkbox', { name: /product updates/i })).toHaveCount(0);

  const optInContext = await browser.newContext();
  const optInPage = await optInContext.newPage();
  const optInSubmission = await submitAndCollect(optInPage, request);
  await optInPage.getByRole('radio', { name: '5 stars' }).check();
  await optInPage.getByRole('checkbox', { name: /email me sprout product updates/i }).check();
  await optInPage.getByRole('textbox', { name: 'Email' }).fill('Person@Example.COM');
  await optInPage.getByRole('button', { name: 'Send feedback' }).click();
  await expect(optInPage.getByText('Thanks for your feedback!')).toBeVisible();

  const surveys = await collection(request, 'surveys');
  const optInSurvey = surveys.find((document) => document.fields.stickerSubmissionId?.stringValue === optInSubmission)!;
  expect(optInSurvey.fields.email?.stringValue).toBe('person@example.com');
  const optInSurveyId = optInSurvey.name.split('/').pop();
  const lead = (await collection(request, 'marketingLeads')).find((document) =>
    document.fields.optionalSubmissionId?.stringValue === optInSurveyId)!;
  expect(lead.fields.email?.stringValue).toBe('person@example.com');
  expect(lead.fields.onboardedAt?.stringValue).toBeTruthy();

  await optOutContext.close();
  await optInContext.close();
  await sharedLinkContext.close();
});
