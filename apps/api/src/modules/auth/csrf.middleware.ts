import { HttpStatus, Injectable, type NestMiddleware, Inject } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ENV, type Env } from '../../config/env';
import { ProblemException, problems } from '../../shared/http/problem-details';

/**
 * CSRF defence in depth.
 *
 * ============================================================================
 * WHY COOKIE AUTH NEEDS THIS AND HEADER AUTH DOES NOT
 * ============================================================================
 *
 * This is the cost of choosing a cookie over `Authorization: Bearer`, and it is the
 * honest downside of design rationale.
 *
 * Browsers attach cookies to requests **automatically, by destination**, with no regard
 * for what site initiated them. So `evil.example` can host a form that POSTs to our API,
 * the browser helpfully includes the session cookie, and the request executes with the
 * victim's identity. The attacker never sees the response — the same-origin policy still
 * blocks reading it — but for a state-changing call they do not need to. "Cancel this
 * appointment" succeeds just fine unread.
 *
 * A token in a header is immune to this by construction: JavaScript on `evil.example`
 * cannot read our token, and nothing attaches it automatically. That immunity is exactly
 * what you give up in exchange for `HttpOnly` protecting the token from XSS. Neither
 * choice is free — the question is which attack you would rather have to defend against
 * deliberately, and XSS is the more common and more total compromise.
 *
 * ---
 *
 * THE PRIMARY DEFENCE IS `SameSite=Lax` ON THE COOKIE, not this middleware. Lax tells the
 * browser not to send the cookie on cross-site POSTs at all, which kills the attack at
 * the source and is supported everywhere.
 *
 * So why this as well? Because `SameSite` is enforced by the *client*, and a security
 * control that runs entirely on the attacker's side of the wire is worth backing up. An
 * old browser, an embedded webview with its own cookie policy, or a future relaxation of
 * the rules would all silently remove the protection with no signal on the server.
 * Checking `Origin` is a server-side check of the same property.
 *
 * ---
 *
 * WHY NOT A DOUBLE-SUBMIT OR SYNCHRONISER TOKEN? Those are the textbook answer, and for
 * a form-post application they are right. Here the API is JSON-only and consumed by a
 * fetch client, which means: (a) `SameSite=Lax` plus an `Origin` check already covers the
 * forgeable request shapes, and (b) a token would need issuing, storing, rotating, and
 * threading through every mutation — real complexity whose marginal benefit over these
 * two layers is small. If this API ever accepted `application/x-www-form-urlencoded` from
 * a real `<form>`, that calculus changes and a token becomes worth it.
 *
 * ---
 *
 * THE ONE THAT WOULD BITE: a permissive CORS policy would undo all of this, because it
 * would let the attacker's page read responses too. There is deliberately no
 * `app.enableCors()` in `main.ts` — the frontend is served same-origin via the Vite proxy
 * in development and same-origin ingress in production. Adding CORS later means revisiting
 * this file, which is why it is written down here rather than assumed.
 * ============================================================================
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  /** Methods that cannot change state, so a forged one achieves nothing. */
  private static readonly SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  constructor(@Inject(ENV) private readonly env: Env) {}

  use(request: Request, _response: Response, next: NextFunction): void {
    if (CsrfMiddleware.SAFE_METHODS.has(request.method)) {
      next();
      return;
    }

    const origin = request.get('origin');

    /**
     * A MISSING `Origin` IS ALLOWED, and that deserves justification because it looks
     * like a hole.
     *
     * Browsers always send `Origin` on cross-origin requests, and modern ones send it on
     * same-origin state-changing requests too. What legitimately arrives without one:
     * `curl`, server-to-server calls, and our own integration tests via supertest.
     *
     * The attack this middleware defends against is *browser-driven* — it depends on the
     * browser automatically attaching a cookie. A client that omits `Origin` is not a
     * browser, and therefore has no cookie jar to be abused. It has to supply the session
     * cookie explicitly, which means it already holds a stolen credential, at which point
     * CSRF is not the problem being solved.
     *
     * Rejecting originless requests would break every non-browser client for no security
     * gain. `Sec-Fetch-Site`, checked below, is the stricter modern signal.
     */
    if (origin !== undefined && !this.env.ALLOWED_ORIGINS.includes(origin)) {
      throw new ProblemException({
        type: problems.crossOrigin,
        title: 'Cross-origin request rejected',
        status: HttpStatus.FORBIDDEN,
        detail: 'State-changing requests must originate from an allowed origin.',
      });
    }

    /**
     * `Sec-Fetch-Site` is set by the browser and cannot be spoofed by page JavaScript —
     * it is on the forbidden-header list. `cross-site` here means a browser is telling us
     * directly that another site initiated this, which is precisely the CSRF signature.
     *
     * `same-origin`, `same-site` and `none` (a user typing a URL) are all fine. Absent
     * means a non-browser client, handled by the same reasoning as above.
     */
    if (request.get('sec-fetch-site') === 'cross-site') {
      throw new ProblemException({
        type: problems.crossOrigin,
        title: 'Cross-origin request rejected',
        status: HttpStatus.FORBIDDEN,
        detail: 'State-changing requests must originate from an allowed origin.',
      });
    }

    next();
  }
}
