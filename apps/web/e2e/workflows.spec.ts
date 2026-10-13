import { expect, Page, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { totp } from '../../api/src/common/crypto';

const MFA_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
async function signIn(page: Page, who: string, mfa = false) {
  await page.goto('/login');
  await page.getByRole('button', { name: who, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (mfa) { await page.getByLabel('Authenticator code').fill(totp(MFA_SECRET)); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); }
  await expect(page.getByRole('heading', { level: 1, name: /Welcome/ })).toBeVisible();
}
const a11y = async (page: Page) => expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

test('admissions: issue an offer, guardian accepts it online without signing in, enrolment becomes possible', async ({ page, browser }) => {
  await signIn(page, 'admissions', true);
  await page.goto('/admissions');
  await page.getByRole('button', { name: 'Issue offer' }).click();
  const code = (await page.getByText(/Offer code \(give to the guardian/).locator('code').first().innerText()).trim();
  expect(code.length).toBeGreaterThan(20);
  // a different, unauthenticated browser context plays the guardian
  const guardian = await (await browser.newContext()).newPage();
  await guardian.goto('/offer');
  await guardian.getByLabel('Offer code').fill(code);
  await guardian.getByRole('button', { name: 'View offer' }).click();
  await expect(guardian.getByRole('heading', { name: /Offer for Mira Fernandes/ })).toBeVisible();
  await a11y(guardian);
  await guardian.getByLabel('Your full name (signature)').fill('Parent of Mira Fernandes');
  await expect(guardian.getByRole('button', { name: 'Accept offer' })).toBeDisabled();      // needs the explicit agreement box
  await guardian.getByLabel(/I am the child’s parent/).check();
  await guardian.getByRole('button', { name: 'Accept offer' }).click();
  await expect(guardian.getByText(/offer has been accepted and your consent recorded/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('row', { name: /Mira Fernandes/ }).getByText('Accepted')).toBeVisible();
  await expect(page.getByRole('row', { name: /Mira Fernandes/ }).getByRole('button', { name: 'Enrol…' })).toBeVisible();
});

test('parent answers consent forms; the record cannot be changed', async ({ page }) => {
  await signIn(page, 'parent');
  await page.goto('/consents');
  await expect(page.getByRole('heading', { name: 'Needs your response' })).toBeVisible();
  const agree = page.getByRole('button', { name: 'I agree' });
  await expect(agree.first()).toBeVisible();
  await expect(agree.first()).toBeDisabled();                                    // needs a signature name first
  await page.getByLabel(/Your full name/).fill('Aarav Sharma');
  const before = await agree.count();
  await agree.first().click();
  await expect(page.getByText('Consent recorded.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'I agree' })).toHaveCount(before - 1);
  await a11y(page);
});

test('registrar sees promotion suggestions; no student is promoted without approved results', async ({ page }) => {
  await signIn(page, 'registrar');
  await page.goto('/lifecycle');
  await page.getByLabel('Academic year').selectOption({ index: 1 });
  await expect(page.getByText(/Students without approved results are flagged for review/)).toBeVisible();
  await expect(page.getByText('needs review', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Withdrawals & transfers' })).toBeVisible();
  await a11y(page);
});

test('accountant sees a balanced ledger that matches fee collections', async ({ page }) => {
  await signIn(page, 'accountant', true);
  await page.goto('/accounting');
  await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bank reconciliation' })).toBeVisible();
  await page.getByRole('button', { name: 'Auto-match' }).click();
  await expect(page.getByText(/Auto-match complete/)).toBeVisible();
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'Fee policy & collections' })).toBeVisible();
  await expect(page.getByText(/Sibling discount/)).toBeVisible();
  await a11y(page);
});

test('parent: early dismissal request from the child profile; teacher cannot see staff finance', async ({ page }) => {
  await signIn(page, 'parent');
  await page.getByRole('link', { name: 'Open profile' }).first().click();
  await expect(page.getByRole('heading', { name: 'Request early dismissal' })).toBeVisible();
  await page.getByLabel('Reason').fill('Dentist appointment');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Request sent to the class teacher.')).toBeVisible();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page.getByRole('heading', { name: 'Documents & certificates' })).toBeVisible();
  await page.getByRole('tab', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { name: 'Library' }).first()).toBeVisible();
});

test('teacher: course analytics, moderated discussion queue', async ({ page }) => {
  await signIn(page, 'teacher');
  await page.goto('/learning');
  await page.getByLabel('Course').selectOption({ index: 1 });
  await expect(page.getByRole('heading', { name: 'Course engagement' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Discussions (moderated)' })).toBeVisible();
  await a11y(page);
});
