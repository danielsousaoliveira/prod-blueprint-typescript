/**
 * MSW intercepting the external notification provider, AT THE NETWORK BOUNDARY.
 *
 * ============================================================================
 * WHY MSW RATHER THAN A FAKE PROVIDER CLASS
 * ============================================================================
 *
 * The obvious alternative is binding `NOTIFICATION_PROVIDER` to a fake class in the e2e
 * environment. That is easier and it tests less: it swaps out the real
 * `HttpNotificationProvider`, so nothing verifies the URL it builds, the headers it sends,
 * the JSON it serialises, or how it interprets a 500 versus a 400.
 *
 * MSW intercepts at the HTTP layer instead. The REAL provider runs, unmodified, and the
 * request it produces is inspected. If someone breaks the `idempotency-key` header or the
 * body shape, a fake class would keep passing; this catches it.
 *
 * The second alternative is a stub HTTP server on localhost, which requires pointing the
 * app at a different URL than production uses — so the configuration under test is not
 * the configuration that ships.
 *
 * ============================================================================
 * onUnhandledRequest: 'error' — THE IMPORTANT SETTING
 * ============================================================================
 *
 * Any outbound HTTP request that is NOT explicitly handled fails the run loudly.
 *
 * The default ('warn', or bypass) is what makes mocked test suites quietly meaningless: a
 * request escapes to the real internet, the test still passes, and nobody notices until
 * CI is sending real emails or a third party rate-limits the build. "Error" turns every
 * unmocked call into an immediate, obvious failure — which also means adding a new
 * outbound dependency cannot happen silently.
 *
 * ============================================================================
 * WHY THE msw IMPORT IS DYNAMIC — AND WHY THIS FILE HAS NO TOP-LEVEL IMPORT OF IT
 * ============================================================================
 *
 * `msw` is a devDependency. The production image prunes devDependencies, so a STATIC
 * `import ... from 'msw/node'` here makes the production container crash on boot with
 * "Cannot find module 'msw/node'" — because `main.ts` imports this file unconditionally,
 * and a static import is resolved at load time regardless of whether the code runs.
 *
 * That is exactly what happened. It was invisible to every test and every local run,
 * because `npm run dev` has the dev dependencies installed; it only appeared when the
 * built image was actually started. The dynamic import defers resolution to the moment
 * the mock is genuinely being enabled, so the module is never looked up in production.
 * ============================================================================
 */

export interface CapturedNotification {
  readonly to: string;
  readonly channel: string;
  readonly template: string;
  readonly idempotencyKey: string | null;
  readonly authorization: string | null;
  readonly data: Record<string, unknown>;
}

/** Everything the provider was asked to send during a run, for assertions. */
export const capturedNotifications: CapturedNotification[] = [];

interface MswServer {
  close(): void;
}

let server: MswServer | undefined;

/**
 * Started before Nest boots, so the very first notification is already intercepted.
 *
 * Guarded by an environment variable rather than by NODE_ENV: the e2e run uses
 * `NODE_ENV=production` to exercise the production code paths (structured logging,
 * introspection disabled), so keying on NODE_ENV would either disable the mock or enable
 * it in real production. An explicit opt-in flag cannot be triggered by accident.
 */
export async function startNotificationMock(baseUrl: string): Promise<void> {
  if (process.env.MOCK_NOTIFICATIONS !== '1') return;

  // Dynamic — see the note above. This line never executes in production, so `msw` is
  // never resolved there.
  const [{ setupServer }, { http, HttpResponse }] = await Promise.all([
    import('msw/node'),
    import('msw'),
  ]);

  const handlers = [
    http.post(`${baseUrl}/v1/messages`, async ({ request }) => {
      const body = (await request.json()) as {
        to: string;
        channel: string;
        template: string;
        data: Record<string, unknown>;
      };

      capturedNotifications.push({
        to: body.to,
        channel: body.channel,
        template: body.template,
        // Captured so a test can assert the provider really sends a deduplication key —
        // the thing that makes at-least-once delivery acceptable end to end. A fake
        // provider class could not observe this at all.
        idempotencyKey: request.headers.get('idempotency-key'),
        authorization: request.headers.get('authorization'),
        data: body.data,
      });

      return HttpResponse.json(
        { id: `msg-${capturedNotifications.length}` },
        { status: 202 },
      );
    }),
  ];

  const instance = setupServer(...handlers);
  instance.listen({ onUnhandledRequest: 'error' });
  server = instance;

  console.log(`[msw] intercepting ${baseUrl} — unhandled requests will FAIL`);
}

export function stopNotificationMock(): void {
  server?.close();
}
