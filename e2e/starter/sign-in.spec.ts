import { expect, test } from '@playwright/test';
import { seedUser, uniqueSuffix } from '../support/starter/seed';
import { signIn } from '../support/starter/login';

/**
 * The starter/foundation project.
 *
 * ============================================================================
 * WHAT THIS COVERS TODAY, AND WHY IT STOPS HERE
 * ============================================================================
 *
 * DAN-91 splits the e2e suite into a starter project and a demonstration project, but the
 * starter shell itself only has sign-in, the authenticated layout, navigation and an empty
 * settings page so far — there is no registration or organisation-creation flow to test
 * yet. Writing tests against those would mean fabricating behaviour the app doesn't have.
 *
 * So this file covers exactly what exists: signing in through the real login form lands
 * on the authenticated shell, with its navigation and sign-out control, independent of
 * whatever demonstration screens happen to be registered. It is a placeholder that is
 * meant to grow — as registration, organisation creation and multi-tenant identity land,
 * this project is where their journeys belong, not `e2e/demonstration`.
 *
 * No two-browser-context pattern here: a sign-in test is about one identity, not two
 * parties transacting, so there is nothing for a second context to prove. No timezone
 * assertion either — this project's timezone pin (see `playwright.config.ts`) exists so a
 * future session-expiry-at-midnight or account-creation-timestamp test can rely on it, but
 * plain sign-in has no timezone-sensitive rendering to exercise yet.
 * ============================================================================
 */

test.describe('starter shell sign-in', () => {
  test('signing in lands on the authenticated shell', async ({ page }) => {
    const suffix = uniqueSuffix('shell');
    const account = await seedUser('patient', suffix);

    await signIn(page, account.email, account.password);

    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('settings is reachable from the authenticated shell', async ({ page }) => {
    const suffix = uniqueSuffix('settings');
    const account = await seedUser('patient', suffix);

    await signIn(page, account.email, account.password);
    await page.getByRole('link', { name: 'Settings' }).click();

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('an unauthenticated visitor gets the login form, not the shell', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  });

  test('signing out ends the session', async ({ page }) => {
    const suffix = uniqueSuffix('signout');
    const account = await seedUser('patient', suffix);

    await signIn(page, account.email, account.password);
    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    // Really gone server-side, not just cleared client-side: a reload does not restore it.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
