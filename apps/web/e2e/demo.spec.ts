import { expect, Page, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { totp } from '../../api/src/common/crypto';

const PASSWORD = 'Demo-Passw0rd!2026';
const MFA_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function signIn(page: Page, who: string, mfa = false) {
  await page.goto('/login');
  await page.getByRole('button', { name: who, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (mfa) {
    await page.getByLabel('Authenticator code').fill(totp(MFA_SECRET));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: /Welcome/ })).toBeVisible();
}

test('login page shows demo banner and is accessible', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('note')).toContainText('DEMO');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('invalid credentials show an error and no session', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('parent@greenwood.demo');
  await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /invalid credentials/i })).toBeVisible();
  await page.goto('/students');
  await expect(page).toHaveURL(/\/login/);
});

test('parent sees only linked children, their fees and homework; pays an invoice via the simulated gateway', async ({ page }) => {
  await signIn(page, 'parent');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Students' })).toHaveCount(0);  // no staff menus
  await expect(page.getByText('Missing homework').first()).toBeVisible();
  const cards = page.locator('section.card', { has: page.getByRole('link', { name: 'Open profile' }) });
  await expect(cards).toHaveCount(2);                                     // seeded family has two children
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.goto('/finance');
  await expect(page.getByRole('heading', { name: 'Invoices for your children' })).toBeVisible();
  const before = await page.getByRole('button', { name: 'Pay (demo)' }).count();
  expect(before).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pay (demo)' }).first().click();
  await expect(page.getByText(/Simulated payment recorded/)).toBeVisible();
  await expect(page.getByText(/DEMO \/ SIMULATED payment/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay (demo)' })).toHaveCount(before - 1);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Pay (demo)' })).toHaveCount(before - 1);   // persisted
});

test('parent cannot open another family’s student record by URL', async ({ page, request }) => {
  await signIn(page, 'parent');
  const token = await page.evaluate(() => sessionStorage.getItem('lms_token'));
  const adminLogin = await request.post('http://localhost:3001/auth/login', { data: { tenant: 'greenwood', email: 'registrar@greenwood.demo', password: PASSWORD } });
  const reg = (await adminLogin.json()).token;
  const list = await (await request.get('http://localhost:3001/students?limit=200', { headers: { authorization: `Bearer ${reg}` } })).json();
  const mine = await (await request.get('http://localhost:3001/me/children', { headers: { authorization: `Bearer ${token}` } })).json();
  const other = list.find((s: any) => !mine.some((m: any) => m.id === s.id));
  await page.goto(`/students/${other.id}`);
  await expect(page.getByRole('alert').filter({ hasText: /not found/i })).toBeVisible();
});

test('teacher marks attendance and the change persists', async ({ page }) => {
  await signIn(page, 'teacher');
  await page.goto('/attendance');
  await page.getByLabel('Class').selectOption({ index: 1 });
  const first = page.locator('table select').first();
  await expect(first).toBeVisible();
  await first.selectOption('absent');
  await page.getByRole('button', { name: 'Save attendance' }).click();
  await expect(page.getByText(/Attendance saved/)).toBeVisible();
  await page.reload();
  await page.getByLabel('Class').selectOption({ index: 1 });
  await expect(page.locator('table select').first()).toHaveValue('absent');
});

test('warden handles leave: approves a request, sees overdue boarders', async ({ page }) => {
  await signIn(page, 'warden');
  await expect(page.getByText('Overdue returns').first()).toBeVisible();
  await page.goto('/hostel');
  await expect(page.getByRole('heading', { name: 'Hostel desk' })).toBeVisible();
  await expect(page.getByText('overdue').first()).toBeVisible();
  const approve = page.getByRole('button', { name: 'Approve' });
  const n = await approve.count();
  expect(n).toBeGreaterThan(0);
  await approve.first().click();
  await expect(page.getByText(/Request approved/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(n - 1);
});

test('admissions officer enrols the accepted applicant (MFA)', async ({ page }) => {
  await signIn(page, 'admissions', true);
  await page.goto('/admissions');
  await page.getByRole('button', { name: 'Enrol…' }).click();
  await page.getByLabel('Class section').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Confirm enrolment' }).click();
  await expect(page.getByRole('heading', { name: 'Enrolled' })).toBeVisible();
  await expect(page.getByText('GIA-00301')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enrol…' })).toHaveCount(0);
});

test('gate staff hand over a day scholar only after ID confirmation', async ({ page }) => {
  await signIn(page, 'gate');
  await page.goto('/dismissal');
  await page.getByRole('button', { name: 'Hand over…' }).first().click();
  const confirm = page.getByRole('button', { name: 'Confirm handover' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Person collecting').selectOption({ index: 1 });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/checked this person/).check();
  await confirm.click();
  await expect(page.getByText(/Handover recorded/)).toBeVisible();
});

test('principal dashboard shows derived school metrics and hides safeguarding cases', async ({ page }) => {
  await signIn(page, 'principal', true);
  await expect(page.getByText('Active students')).toBeVisible();
  await expect(page.getByText('Overdue returns').first()).toBeVisible();
  await page.goto('/incidents');
  await expect(page.getByText('Welfare concern raised by staff')).toHaveCount(0);
});

test('mobile layout: menu toggles and nothing overflows horizontally', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await signIn(page, 'student');
  await expect(page.getByRole('button', { name: /Menu/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.getByRole('button', { name: /Menu/ }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Learning' })).toBeVisible();
});
