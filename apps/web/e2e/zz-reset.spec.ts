import { expect, test } from '@playwright/test';
import { totp } from '../../api/src/common/crypto';

test('administrator can reset the demo back to the known seeded state', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'admin', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Authenticator code').fill(totp('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Welcome/ })).toBeVisible();
  await page.getByRole('button', { name: 'Reset demo data…' }).click();
  await page.getByRole('button', { name: 'Yes, wipe and reseed' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
  // after the reset, the accepted applicant exists again (Scenario A repeatable)
  await page.getByRole('button', { name: 'admissions', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Authenticator code').fill(totp('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Welcome/ })).toBeVisible();
  await page.goto('/admissions');
  await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enrol…' })).toHaveCount(1);
});
