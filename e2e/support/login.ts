import type { Browser, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { SeededDoctor } from './seed';

/**
 * ============================================================================
 * TWO CONTEXTS, BECAUSE ONE SESSION IS ONE IDENTITY
 * ============================================================================
 *
 * Before Phase 10 the counter-proposal journey ran in a SINGLE page, clicking a tab to
 * switch between the patient view and the doctor inbox — because identity was a query
 * parameter and "who am I" was a client-side preference.
 *
 * With real sessions that is no longer expressible, and it should not be: a patient's
 * browser cannot become a doctor's. So the journey now runs across two independent
 * `BrowserContext`s, each with its own cookie jar.
 *
 * This is a strictly better test. The old one proved the two views rendered; this one
 * proves two different people, in two different browsers, can transact with each other —
 * which is the thing the product actually claims to do.
 * ============================================================================
 */

/**
 * Sign in through the REAL login form.
 *
 * Not by inserting a session into Redis, and not through a test-only endpoint. Both would
 * be faster and both would mean the login path — the argon2 verification, the cookie
 * attributes, the guard reading the cookie — is never exercised end to end by anything.
 * The one place a login bug would surface is the one place that skipped it.
 *
 * It costs roughly a second per context, paid once per test.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');

  // `getByLabel`, per the suite's locator policy — which also asserts the inputs have
  // real <label for> elements rather than placeholders.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  /**
   * ============================================================================
   * WAIT FOR SOMETHING THAT IS TRUE **ONLY AFTER** LOGIN SUCCEEDS
   * ============================================================================
   *
   * The obvious wait is wrong, and it cost an hour:
   *
   *     await expect(page.getByRole('heading', { name: 'Appointment scheduler' }))
   *       .toBeVisible();
   *     await expect(page.getByRole('button', { name: 'Sign in' })).toBeHidden();
   *
   * Both assertions pass while the login is STILL IN FLIGHT. The `<h1>` is identical on
   * the login page and the app, so the first proves nothing. And the submit button's
   * label changes to "Signing in…" while the mutation is pending — so a locator for the
   * name "Sign in" matches nothing, and `toBeHidden` reports success at exactly the
   * moment the request is mid-flight.
   *
   * The caller then navigated immediately, cancelling the in-flight POST before the
   * browser stored the `Set-Cookie`, and landed back on the login page. Five of eight
   * tests failed with "Available appointments not found" — an error pointing at the
   * calendar, three layers away from the actual cause.
   *
   * Same class of bug as the Phase 8 `locator.count()` flake: asserting on a condition
   * that is TRANSIENTLY true. The fix is to wait for a signal that cannot appear until
   * the thing you are waiting for has actually happened — "Sign out" exists only in the
   * signed-in shell.
   * ============================================================================
   */
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** A page signed in as the seeded patient, in its own context. */
export async function patientPage(browser: Browser, seeded: SeededDoctor): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, seeded.patientEmail, seeded.password);

  // The patient needs to know WHICH doctor to browse. That is a genuine client choice
  // (there is no doctor directory in this project), unlike the old `?patientId=` which
  // was an identity claim — see the comment in App.tsx.
  await page.goto(`/?doctorId=${seeded.doctorId}`);
  await expect(
    page.getByRole('heading', { name: 'Available appointments' }),
  ).toBeVisible();

  return page;
}

/** A page signed in as the seeded doctor, in its own context. */
export async function doctorPage(browser: Browser, seeded: SeededDoctor): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, seeded.doctorEmail, seeded.password);

  // No doctorId needed: a doctor's calendar is their own, taken from the session.
  await expect(page.getByRole('heading', { name: 'Appointment requests' })).toBeVisible();

  return page;
}
