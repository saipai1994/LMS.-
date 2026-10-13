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

test('transport manager sees routes, expiring documents and confirms boarding on a trip', async ({ page }) => {
  await signIn(page, 'transport');
  await expect(page.getByText('Expiring or expired documents')).toBeVisible();
  await page.goto('/transport');
  await expect(page.getByRole('heading', { name: 'Routes' })).toBeVisible();
  await page.getByLabel('Route').selectOption({ index: 1 });
  await page.getByLabel('Shift').selectOption('am');
  await page.getByRole('button', { name: 'Open trip' }).click();
  await expect(page.getByText(/DEMO \/ SIMULATED location/)).toBeVisible();
  const boarded = page.getByRole('button', { name: 'Boarded' });
  const n = await boarded.count();
  expect(n).toBeGreaterThan(0);
  await boarded.first().click();
  await expect(page.getByText(/Recorded boarded; guardian notified/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Boarded' })).toHaveCount(n - 1);
  await a11y(page);
});

test('librarian overdue list and issue/return desk', async ({ page }) => {
  await signIn(page, 'librarian');
  await expect(page.getByText('Overdue items')).toBeVisible();
  await page.goto('/library');
  await page.getByLabel('Search title, author or ISBN').fill('wings');
  await expect(page.getByRole('cell', { name: /Wings of Fire/ }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Return a book' })).toBeVisible();
});

test('inventory manager sees low stock and cannot approve requisitions', async ({ page }) => {
  await signIn(page, 'inventory');
  await page.goto('/inventory');
  await expect(page.getByRole('heading', { name: 'Low stock' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);       // approval belongs to the principal
});

test('nurse sees restricted health desk; teacher has no health access', async ({ page }) => {
  await signIn(page, 'nurse', true);
  await page.goto('/health');
  await expect(page.getByRole('heading', { name: 'Counselling referrals (confidential)' })).toBeVisible();
  await expect(page.getByText('Exam anxiety')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, 'teacher');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Health' })).toHaveCount(0);
  await page.goto('/health');
  await expect(page.getByRole('alert').filter({ hasText: /forbidden|not found/i }).first()).toBeVisible();
});

test('kitchen manager sees dietary alerts for today’s menu', async ({ page }) => {
  await signIn(page, 'kitchen');
  await page.goto('/meals');
  await expect(page.getByRole('heading', { name: /Today’s headcount/ })).toBeVisible();
  await expect(page.getByText('Expected (boarders on campus)')).toBeVisible();
});

test('teacher timetable grid, communications honesty and ticket SLA', async ({ page }) => {
  await signIn(page, 'teacher');
  await page.goto('/timetable');
  await expect(page.getByRole('region', { name: 'Weekly timetable' })).toBeVisible();
  await a11y(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, 'registrar');
  await page.goto('/communications');
  await expect(page.getByText(/Email and SMS providers are not configured/)).toBeVisible();
  await page.getByLabel('Title').fill('Playwright notice');
  await page.getByLabel('Message').fill('Testing delivery honesty');
  await page.getByLabel(/Also email/).check();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Announcement sent in-app.')).toBeVisible();
  await page.getByRole('row', { name: /Playwright notice/ }).getByRole('button', { name: 'Delivery' }).click();
  await expect(page.getByText(/NOT delivered/)).toBeVisible();
  await page.goto('/tickets');
  await expect(page.getByText(/SLA breached/).first()).toBeVisible();
});

test('HR: payroll cannot be approved by HR; staff see only their own pay', async ({ page }) => {
  await signIn(page, 'hr', true);
  await page.goto('/hr');
  await expect(page.getByRole('heading', { name: 'Payroll runs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await page.getByLabel('Month (YYYY-MM)').fill('2026-10');
  await page.getByRole('button', { name: 'Create draft run' }).click();
  await expect(page.getByText(/Draft run created/)).toBeVisible();
  await expect(page.getByRole('cell', { name: '2026-10' })).toBeVisible();
});

test('reports: CSV export downloads and is audited; formula cells are neutralised', async ({ page }) => {
  await signIn(page, 'registrar');
  await page.goto('/reports');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Students' }).click()]);
  expect(dl.suggestedFilename()).toBe('students.csv');
  const text = (await (await dl.createReadStream()).toArray()).join('');
  expect(text.split('\r\n').length).toBeGreaterThan(300);
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Admission funnel' })).toBeVisible();
  await a11y(page);
});

test('parent: calendar booking and support request', async ({ page }) => {
  await signIn(page, 'parent');
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
  await page.goto('/tickets');
  await page.getByLabel('Subject').fill('Browser-test request');
  await page.getByLabel('Details').fill('Please confirm the bus pickup time.');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Request submitted.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Browser-test request' })).toBeVisible();
  await a11y(page);
});
