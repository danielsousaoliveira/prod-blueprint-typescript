import type { Browser, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Sign in through the REAL login form.
 *
 * Not by inserting a session into Redis, and not through a test-only endpoint. Both would
 * be faster and both would mean the login path — the argon2 verification, the cookie
 * attributes, the guard reading the cookie — is never exercised end to end by anything.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  /**
   * Wait for something that is true ONLY after login succeeds — see the long-form note in
   * `support/demonstration/login.ts`. "Sign out" exists only in the signed-in shell.
   */
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/** A page signed in as the given account, in its own browser context. */
export async function signedInPage(
  browser: Browser,
  email: string,
  password: string,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, password);
  return page;
}
