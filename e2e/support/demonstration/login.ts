import type { Browser, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { SeededDoctor } from './seed';
import { signedInPage, signIn } from '../starter/login';

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
 * The sign-in mechanics themselves (fill the form, wait for "Sign out") live in
 * `support/starter/login.ts` — that part is generic to any authenticated account, not
 * specific to doctors and patients, and is shared with the starter project.
 * ============================================================================
 */

export { signIn };

/** A page signed in as the seeded patient, in its own context. */
export async function patientPage(browser: Browser, seeded: SeededDoctor): Promise<Page> {
  const page = await signedInPage(browser, seeded.patientEmail, seeded.password);

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
  const page = await signedInPage(browser, seeded.doctorEmail, seeded.password);

  // No doctorId needed: a doctor's calendar is their own, taken from the session.
  await expect(page.getByRole('heading', { name: 'Appointment requests' })).toBeVisible();

  return page;
}
