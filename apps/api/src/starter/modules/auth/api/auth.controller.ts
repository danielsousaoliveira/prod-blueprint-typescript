import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UsePipes,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ENV, type Env } from '../../../config/env';
import {
  ProblemException,
  ZodValidationPipe,
  problems,
} from '../../../shared/http/problem-details';
import { AuthService } from '../application/auth.service';
import { OptionalActor } from '../actor.decorator';
import { Public } from '../auth.guard';
import type { Actor } from '../domain/user';
import {
  loginSchema,
  toSessionDto,
  type LoginBody,
  type SessionDto,
} from './auth.schemas';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Sign in.
   *
   * `@Public()` because requiring a session to create a session would be a nice deadlock.
   * It is one of exactly three public endpoints in the application — the other two are
   * the health probes — and that list is short by design (see the deny-by-default
   * argument on `AuthGuard`).
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(
    @Body() body: LoginBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const result = await this.auth.login(body.email, body.password, clientIp(request));

    if (!result.ok) {
      /**
       * ============================================================================
       * ONE MESSAGE FOR BOTH CREDENTIAL FAILURES. THIS IS NOT LAZINESS.
       * ============================================================================
       *
       * "No account with that email" and "wrong password for that account" are different
       * facts, and telling them apart is genuinely more helpful to a user who mistyped.
       * It is also a user-enumeration oracle: an attacker submits candidate addresses
       * with a junk password and learns which ones are registered. For a medical
       * scheduling system, "is this person a patient at this clinic" is sensitive on its
       * own — arguably more so than the password guarding it.
       *
       * The timing side of the same oracle is closed in `AuthService.login`, which
       * verifies against a dummy hash when the email is unknown so both paths cost the
       * same. A shared message with a giveaway timing difference would be theatre.
       *
       * The rate-limit case is deliberately DIFFERENT (429), because it discloses nothing
       * about whether the account exists — it is a statement about this client's recent
       * behaviour — and a client that cannot tell it is being throttled will hammer the
       * endpoint forever.
       * ============================================================================
       */
      if (result.reason === 'RATE_LIMITED') {
        throw new ProblemException({
          type: problems.rateLimited,
          title: 'Too many sign-in attempts',
          status: HttpStatus.TOO_MANY_REQUESTS,
          detail: 'Wait a few minutes before trying again.',
        });
      }

      throw new ProblemException({
        type: problems.unauthenticated,
        title: 'Invalid email or password',
        status: HttpStatus.UNAUTHORIZED,
      });
    }

    response.cookie(this.env.SESSION_COOKIE_NAME, result.sessionId, this.cookieOptions());

    return toSessionDto(result.actor);
  }

  /**
   * Sign out.
   *
   * Public, and that is deliberate rather than an oversight: logging out with an already
   * invalid session should succeed, not 401. A client whose session expired in a
   * background tab still needs to clear its cookie, and answering "you must be signed in
   * to sign out" is both useless and confusing.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    // Express types `cookies` as `any`; narrowed to `unknown` before use, because a
    // cookie value really is untrusted input regardless of what the types say.
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const sessionId = cookies?.[this.env.SESSION_COOKIE_NAME];

    if (typeof sessionId === 'string' && sessionId.length > 0) {
      await this.auth.logout(sessionId);
    }

    // Clear the cookie with the SAME attributes it was set with. A `clearCookie` whose
    // path or sameSite differs from the original does not match it, and the browser keeps
    // the old cookie — a logout that appears to work and does not. The server-side
    // destroy above is what actually ends the session, which is the point of server-side
    // sessions: correctness does not depend on the client cooperating.
    response.clearCookie(this.env.SESSION_COOKIE_NAME, this.cookieOptions());
  }

  /**
   * Who am I?
   *
   * Public with an OPTIONAL actor, so a signed-out caller gets `null` rather than a 401.
   * The frontend calls this on load to decide between the app and the login page; if it
   * threw, every first paint for a logged-out visitor would be an error the client has to
   * special-case, and "not signed in" is a normal answer to this question rather than a
   * failure.
   */
  @Public()
  @Get('me')
  me(@OptionalActor() actor: Actor | undefined): SessionDto | null {
    return actor ? toSessionDto(actor) : null;
  }

  private cookieOptions(): {
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    path: string;
    maxAge: number;
  } {
    return {
      /**
       * The whole reason for choosing a cookie over localStorage. JavaScript cannot read
       * this value, so an XSS that would otherwise exfiltrate a token gets nothing — it
       * can still *act* as the user while the page is open, but it cannot walk away with
       * a credential that works from anywhere for the next seven days.
       */
      httpOnly: true,
      /**
       * The primary CSRF defence. `Lax` (not `Strict`) because `Strict` also withholds
       * the cookie on ordinary top-level navigation *into* the site — a user following a
       * link from their email lands logged out, which they read as a broken session.
       * `Lax` still blocks the cross-site POST that CSRF actually needs.
       */
      sameSite: 'lax',
      /**
       * Defaults to true; explicitly disabled for local HTTP. A `Secure` cookie over
       * plain HTTP is silently discarded by the browser, so login appears to succeed,
       * returns 200, and every subsequent request is 401 with no error explaining why.
       * See the long note on `SESSION_COOKIE_SECURE` in config/env.ts — the e2e suite is
       * what forced this to become a flag rather than a derivation from NODE_ENV.
       */
      secure: this.env.SESSION_COOKIE_SECURE,
      path: '/',
      maxAge: this.env.SESSION_TTL_SECONDS * 1000,
    };
  }
}

/**
 * The client's address, for rate-limiting purposes.
 *
 * `x-forwarded-for` is CLIENT-CONTROLLED unless a trusted proxy overwrites it, so an
 * attacker can rotate it freely and walk straight past a per-IP limit. Express only
 * populates `request.ip` from it when `trust proxy` is configured, which this app
 * deliberately does not set — so `request.ip` here is the real socket address.
 *
 * Behind Cloud Run this needs revisiting: the socket address becomes the load balancer's,
 * every request looks like one client, and the per-IP counter becomes a global one that
 * locks out everybody. The correct fix there is `trust proxy` with a specific hop count,
 * never `true`. Flagged rather than guessed, because guessing wrong in either direction
 * is a real bug: too trusting and the limit is bypassable, too strict and it is a
 * self-inflicted outage.
 */
function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}
