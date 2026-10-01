import { expect, test } from '@playwright/test';

test.describe('organisation subdomains in local development', () => {
  test('an unknown organisation subdomain reaches the API through the dev server and is not found', async ({
    page,
  }) => {
    const response = await page.goto('http://nobody-here.localtest.me:5173/');
    expect(response?.status()).toBe(200);

    const status = await page.evaluate(async () => (await fetch('/v1/auth/me')).status);

    expect(status).toBe(404);
  });

  test('a reserved host resolves no organisation and is served normally', async ({
    page,
  }) => {
    await page.goto('http://app.localtest.me:5173/');

    const status = await page.evaluate(async () => (await fetch('/v1/auth/me')).status);

    expect(status).toBe(200);
  });
});
