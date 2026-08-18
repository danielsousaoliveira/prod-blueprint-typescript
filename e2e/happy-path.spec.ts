import { expect, test, type APIRequestContext } from '@playwright/test';
import { findAppointments, seedDoctor } from './support/seed';
import { doctorPage, patientPage, signIn } from './support/login';

/**
 * End-to-end: a real browser, a real API, a real MongoDB and Redis.
 *
 * ============================================================================
 * LOCATOR POLICY: getByRole and getByLabel ONLY. No CSS selectors, no test ids.
 * ============================================================================
 *
 * Two reasons, and the second matters more:
 *
 *   1. A test that finds a button by its accessible name breaks when that NAME changes —
 *      a user-visible change worth failing on. A test that finds it by `.btn-primary`
 *      breaks when someone renames a class, which is a refactor, and keeps passing when
 *      the label changes to something meaningless.
 *   2. It means the e2e suite can only reach what a screen reader can reach. An
 *      unlabelled control is an untestable control, so accessibility stops being a
 *      separate task someone remembers and becomes a precondition for shipping.
 *
 * This policy is what made adding Tailwind in Phase 10 a non-event: every locator here
 * targets a role or an accessible name, so hundreds of `className` attributes changed
 * and not one test needed editing. A suite built on CSS selectors would have been
 * rewritten wholesale.
 *
 * ============================================================================
 * PHASE 10: TWO BROWSER CONTEXTS, BECAUSE ONE SESSION IS ONE IDENTITY
 * ============================================================================
 *
 * These tests used to drive both parties through a single page, clicking a tab to switch
 * between the patient view and the doctor inbox. Real authentication makes that
 * impossible — and the replacement is a better test: two independent browser contexts,
 * two cookie jars, two people transacting with each other.
 *
 * The browser timezone is pinned to America/New_York (playwright.config.ts) while the
 * clinic is in Europe/Lisbon, so every test here exercises the cross-timezone rendering
 * path rather than the trivial same-zone case.
 * ============================================================================
 */

test.describe('appointment lifecycle', () => {
  test('patient requests, doctor counter-proposes, patient accepts', async ({
    browser,
  }) => {
    // THE headline journey from the spec — now genuinely between two people.
    const seeded = await seedDoctor('happy');
    const patient = await patientPage(browser, seeded);
    const doctor = await doctorPage(browser, seeded);

    // --- Patient books ------------------------------------------------------
    // Asserting on the accessible name proves BOTH times reach a screen-reader user, not
    // just a sighted one.
    const firstSlot = patient.getByRole('button', { name: /^Book \d{2}:\d{2}/ }).first();
    await expect(firstSlot).toBeVisible();
    const slotName = (await firstSlot.getAttribute('aria-label')) ?? '';
    expect(slotName).toMatch(/clinic time/);

    await firstSlot.click();

    const dialog = patient.getByRole('dialog', { name: /Confirm your appointment/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm booking' }).click();

    // The dialog closes on a CONFIRMED booking — the Phase 7 regression, now covered
    // end to end as well as in a component test. Still asserted with `toBeHidden`, which
    // is why the Phase 10 modal styling had to keep the dialog conditionally mounted
    // rather than fading an always-present overlay.
    await expect(dialog).toBeHidden();

    // --- Doctor counter-proposes -------------------------------------------
    // A different browser, a different session. The doctor's inbox polls every 10s, and
    // `toBeVisible` auto-waits, so no explicit refresh is needed.
    await expect(
      doctor.getByRole('button', { name: /^Accept \d{2}:\d{2} request/ }),
    ).toBeVisible({ timeout: 15_000 });

    await doctor.getByRole('button', { name: /^Propose a new time/ }).click();

    // A real <label for>, found by its text — not a placeholder pretending to be a label.
    await doctor.getByLabel(/New time/).fill(`${seeded.bookingDate}T07:00`);
    await doctor.getByRole('button', { name: 'Send proposal' }).click();

    await expect(
      doctor.getByRole('heading', { name: /Awaiting patient \(1\)/ }),
    ).toBeVisible();

    // NOTE ON THE TIME ABOVE: `datetime-local` is interpreted in the BROWSER's timezone,
    // which this suite pins to America/New_York. So the doctor typing 07:00 means 07:00
    // THEIR time — 11:00Z, and 12:00 on the clinic's Lisbon clock. That is exactly what
    // the field's label promises ("New time (your timezone)"), and it is why the
    // assertion below is 11:00Z rather than the 06:00Z I first assumed.

    // --- Patient accepts the counter-proposal -------------------------------
    const proposals = patient.getByRole('list', { name: /Proposed alternative times/ });
    await expect(proposals).toBeVisible({ timeout: 15_000 });
    // Both times shown, so the patient can compare what they asked for with what was
    // offered.
    await expect(proposals).toContainText('You asked for');

    await patient.getByRole('button', { name: /^Accept the proposed time/ }).click();

    // --- Confirmed on the PROPOSED slot -------------------------------------
    await expect(doctor.getByRole('heading', { name: /Confirmed \(1\)/ })).toBeVisible({
      timeout: 15_000,
    });

    // Verified in the DATABASE, not only on screen: one appointment, confirmed, holding
    // the doctor's proposed time rather than the original request.
    const stored = await findAppointments(seeded.doctorId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('CONFIRMED');
    expect(stored[0]?.startsAt.toISOString()).toBe(`${seeded.bookingDate}T11:00:00.000Z`);
  });

  test('a declined request frees its slot for rebooking', async ({ browser }) => {
    const seeded = await seedDoctor('decline');
    const patient = await patientPage(browser, seeded);
    const doctor = await doctorPage(browser, seeded);

    /**
     * WAIT before counting.
     *
     * `locator.count()` is one of the few Playwright APIs with NO auto-waiting — it
     * answers immediately with however many elements exist right now. Called before the
     * calendar query resolves it returns 0, and the test then asserts against a baseline
     * of zero and fails intermittently. This was flaky roughly one run in two.
     *
     * `expect(...).toBeVisible()` DOES auto-wait, so establishing that at least one slot
     * has rendered makes the subsequent count deterministic. Every later assertion uses
     * `toHaveCount`, which also auto-waits and retries.
     */
    await expect(patient.getByRole('button', { name: /^Book / }).first()).toBeVisible();
    const slotsBefore = await patient.getByRole('button', { name: /^Book / }).count();
    expect(slotsBefore).toBeGreaterThan(0);

    await patient
      .getByRole('button', { name: /^Book / })
      .first()
      .click();
    await patient.getByRole('button', { name: 'Confirm booking' }).click();

    await expect(patient.getByRole('button', { name: /^Book / })).toHaveCount(
      slotsBefore - 1,
    );

    // Doctor declines, from their own session...
    await doctor
      .getByRole('button', { name: /^Decline \d{2}:\d{2} request/ })
      .click({ timeout: 15_000 });
    await expect(
      doctor.getByRole('heading', { name: /Awaiting your response \(0\)/ }),
    ).toBeVisible();

    // ...and the slot comes back for the patient. The partial unique index's filter,
    // working end to end: a terminal appointment releases its slot rather than burning it.
    await expect(patient.getByRole('button', { name: /^Book / })).toHaveCount(
      slotsBefore,
      { timeout: 15_000 },
    );
  });

  test('the same slot cannot be booked twice', async ({ browser, request }) => {
    const seeded = await seedDoctor('conflict');
    const patient = await patientPage(browser, seeded);

    const firstSlot = patient.getByRole('button', { name: /^Book / }).first();
    await expect(firstSlot).toBeVisible();

    /**
     * Read the target instant FROM THE UI rather than computing it.
     *
     * The `<time datetime>` attribute is the machine-readable instant the page is
     * actually offering, so the interloper below is guaranteed to take the same slot the
     * user is about to confirm. Computing the date independently is what broke the first
     * version of this test: the fixture and the UI disagreed about which day was on
     * screen, so the "conflict" test booked two different slots and no conflict happened.
     */
    const startsAt = (await firstSlot.locator('time').getAttribute('datetime')) ?? '';
    expect(startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await firstSlot.click();
    await expect(patient.getByRole('dialog')).toBeVisible();

    /**
     * Another patient takes the slot out from under this one, via the API.
     *
     * Phase 10 changed how this works, and the change is the point: the interloper can no
     * longer simply assert `patientId: 'interloper'` in the request body — that field is
     * gone. They have to AUTHENTICATE first, which is exactly the hole this phase closed.
     * The test now proves the conflict happens between two genuinely different signed-in
     * patients rather than between one patient and a forged identity.
     */
    const other = await seedDoctor('conflict-rival');
    const interloper = await signInViaApi(request, other.patientEmail, other.password);

    const stolen = await request.post('http://localhost:3000/v1/appointments', {
      headers: { cookie: interloper },
      data: {
        doctorId: seeded.doctorId,
        startsAt,
        endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
      },
    });
    expect(stolen.ok()).toBeTruthy();

    await patient.getByRole('button', { name: 'Confirm booking' }).click();

    // The UI ANNOUNCES the loss via role=alert rather than failing silently.
    const alert = patient.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/just taken|not available/i);

    // Exactly one appointment exists. No double booking, end to end.
    const stored = await findAppointments(seeded.doctorId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.startsAt.toISOString()).toBe(startsAt);
    expect(stored[0]?.status).toBe('REQUESTED');
  });
});

test.describe('authentication', () => {
  test('an unauthenticated visitor gets the login form, not the app', async ({
    page,
  }) => {
    // The whole premise of the phase, asserted at the front door: no session, no app.
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Available appointments' }),
    ).toBeHidden();
  });

  test('a query parameter can no longer forge an identity', async ({ page }) => {
    /**
     * The regression test for the hole this phase closed.
     *
     * `?doctorId=…&patientId=…` used to BE the identity system. Landing on that URL
     * signed you in as whoever you named. It must now do nothing at all without a
     * session.
     */
    const seeded = await seedDoctor('forge');
    await page.goto(`/?doctorId=${seeded.doctorId}&patientId=${seeded.patientId}`);

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Appointment requests' }),
    ).toBeHidden();
  });

  test('signing out ends the session', async ({ browser }) => {
    const seeded = await seedDoctor('signout');
    const patient = await patientPage(browser, seeded);

    await patient.getByRole('button', { name: 'Sign out' }).click();
    await expect(patient.getByRole('button', { name: 'Sign in' })).toBeVisible();

    // And it is really gone server-side, not just cleared in the UI: a reload does not
    // restore the session. This is what distinguishes a real logout from a client-side
    // one, and it is the reason for choosing server-side sessions over a JWT.
    await patient.reload();
    await expect(patient.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('rejects a wrong password without revealing whether the account exists', async ({
    page,
  }) => {
    const seeded = await seedDoctor('badpass');

    await page.goto('/');
    await page.getByLabel('Email').fill(seeded.patientEmail);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    const knownAccountMessage = await alert.textContent();

    // Now an address that does not exist at all. The message must be identical — a
    // difference here is a user-enumeration oracle, and "is this person a patient at this
    // clinic" is itself sensitive information.
    await page.getByLabel('Email').fill('nobody-at-all@e2e.test');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(alert).toBeVisible();

    expect(await alert.textContent()).toBe(knownAccountMessage);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});

test.describe('notifications', () => {
  test('a booking sends a notification carrying a deduplication key', async ({
    browser,
    request,
  }) => {
    // The MSW assertion. The REAL HttpNotificationProvider ran, so this checks the
    // request it actually produced — which a fake provider class could never verify.
    const seeded = await seedDoctor('notify');
    const patient = await patientPage(browser, seeded);

    await patient
      .getByRole('button', { name: /^Book / })
      .first()
      .click();
    await patient.getByRole('button', { name: 'Confirm booking' }).click();
    await expect(patient.getByRole('dialog')).toBeHidden();

    // The outbox relay polls once a second, so the notification is not instant. Polling
    // for the CONDITION rather than sleeping a fixed time — a sleep is either flaky or
    // slow, and usually both.
    await expect
      .poll(
        async () => {
          const response = await request.get(
            'http://localhost:3000/__test__/notifications',
          );
          const body = (await response.json()) as {
            notifications: { data: Record<string, unknown> }[];
          };
          return body.notifications.filter((n) => n.data?.aggregateId !== undefined)
            .length;
        },
        { timeout: 25_000, message: 'expected the booking to produce a notification' },
      )
      .toBeGreaterThanOrEqual(1);

    const response = await request.get('http://localhost:3000/__test__/notifications');
    const body = (await response.json()) as {
      notifications: {
        template: string;
        idempotencyKey: string | null;
        authorization: string | null;
      }[];
    };

    expect(body.notifications.length).toBeGreaterThan(0);

    for (const notification of body.notifications) {
      // The dedupe key is what makes at-least-once delivery produce exactly one visible
      // message.
      expect(notification.idempotencyKey).toBeTruthy();
      // And the real provider really does send its credentials.
      expect(notification.authorization).toContain('Bearer');
    }
  });
});

/**
 * Sign in over HTTP and return the cookie header.
 *
 * Used only where a test needs a second actor without paying for a second browser — the
 * conflict test. It goes through the real `/v1/auth/login`, so it is not a bypass; it is
 * the same request the form makes, without the form.
 */
async function signInViaApi(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const response = await request.post('http://localhost:3000/v1/auth/login', {
    data: { email, password },
  });
  expect(response.ok()).toBeTruthy();

  const setCookie = response.headers()['set-cookie'] ?? '';
  return setCookie.split(';')[0] ?? '';
}

// Referenced so the import is used even if a test above is skipped during debugging.
void signIn;
