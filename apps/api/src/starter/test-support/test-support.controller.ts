import { Controller, Get, Module, VERSION_NEUTRAL } from '@nestjs/common';
import { Public } from '../modules/auth/auth.guard';
import { capturedNotifications } from './notification-mock';

/**
 * A test-only surface exposing what the mocked notification provider received.
 *
 * Playwright drives a browser; it cannot read the API process's memory. So the assertions
 * about notifications — that a booking actually produced one, with a deduplication key —
 * need a way out of the process, and an HTTP endpoint is the simplest one that does not
 * involve sharing a database table purely for test bookkeeping.
 *
 * REGISTERED ONLY WHEN `MOCK_NOTIFICATIONS=1`. That guard is the whole reason this is
 * acceptable: in a real deployment the module is never imported, so the route does not
 * exist rather than existing-but-protected. An endpoint that leaks internal state and is
 * merely hidden behind a flag check is one misconfiguration away from being public.
 */
/**
 * `@Public()` — and this is the ONE place in the codebase where opting out of
 * authentication deserves a second look rather than a shrug.
 *
 * It is safe here for a reason that has nothing to do with this decorator: the entire
 * module is only registered when `MOCK_NOTIFICATIONS=1` (see `testSupportModules()`
 * below), so in any real deployment these routes do not exist at all. `@Public()` on a
 * route that is not mounted cannot expose anything.
 *
 * If that guard on registration were ever removed, this decorator would become an
 * unauthenticated endpoint dumping every notification the system has sent — which is why
 * the two must be read together, and why this comment is here rather than a bare
 * decorator.
 */
@Public()
@Controller({ path: '__test__', version: VERSION_NEUTRAL })
export class TestSupportController {
  @Get('notifications')
  notifications() {
    return {
      count: capturedNotifications.length,
      notifications: capturedNotifications,
    };
  }
}

@Module({ controllers: [TestSupportController] })
export class TestSupportModule {}

/** Imported conditionally by AppModule — see the guard note above. */
export const testSupportModules = () =>
  process.env.MOCK_NOTIFICATIONS === '1' ? [TestSupportModule] : [];
