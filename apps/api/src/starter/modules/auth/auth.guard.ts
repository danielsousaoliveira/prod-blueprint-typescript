import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Request } from 'express';
import { ProblemException, problems } from '../../shared/http/problem-details';
import { AuthService } from './application/auth.service';
import type { Actor } from './domain/user';

export const IS_PUBLIC_KEY = 'auth:public';

/**
 * Opt a handler out of authentication.
 *
 * Named for what it means to a reader of the endpoint ("this is public"), and it must be
 * applied explicitly — see the deny-by-default argument on the guard below.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/** The property the guard hangs the resolved actor off. */
export const ACTOR_PROPERTY = 'actor';

/**
 * `cookies` is deliberately NOT redeclared here. Express's own `Request` already has it
 * (typed `any`, populated by `cookie-parser`), and narrowing it to
 * `Record<string, string | undefined>` makes this interface structurally incompatible
 * with `Request` — TS2430, because a narrowed property is not a valid override.
 *
 * The read site casts the value it pulls out instead, which is the honest shape: a cookie
 * value really is `unknown` until checked, since it arrives from the network.
 */
export interface RequestWithActor extends Request {
  [ACTOR_PROPERTY]?: Actor;
}

/**
 * Authentication for both API surfaces.
 *
 * ============================================================================
 * REGISTERED GLOBALLY, SO IT IS DENY-BY-DEFAULT
 * ============================================================================
 *
 * Bound via `APP_GUARD` in `app.module.ts` rather than applied per-controller with
 * `@UseGuards`. The difference is what happens to code nobody thought about:
 *
 *   - Opt-IN (`@UseGuards` per controller): a new endpoint is PUBLIC until someone
 *     remembers to protect it. The failure mode is silent, and it looks exactly like
 *     working code.
 *   - Opt-OUT (global + `@Public()`): a new endpoint is PROTECTED until someone
 *     deliberately opens it. The failure mode is a 401 in development, which is loud,
 *     immediate, and fixed in ten seconds.
 *
 * Both are one line of code. Only one of them fails safely, and "we forgot a decorator"
 * is a genuinely common root cause in breach write-ups.
 * ============================================================================
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly cookieName: string,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = getRequest(context);

    // A public route still RESOLVES a session when one is present, it just does not
    // require one. That is what lets `GET /v1/auth/me` distinguish "logged out" from
    // "logged in" without being two different endpoints.
    const cookies = request?.cookies as Record<string, unknown> | undefined;
    const sessionId = cookies?.[this.cookieName];

    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const actor = await this.auth.resolve(sessionId);
      if (actor && request) request[ACTOR_PROPERTY] = actor;
    }

    if (isPublic) return true;

    if (!request?.[ACTOR_PROPERTY]) {
      throw new ProblemException({
        type: problems.unauthenticated,
        title: 'Authentication required',
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Sign in to continue.',
      });
    }

    return true;
  }
}

/**
 * Get the underlying HTTP request, whichever surface we are on.
 *
 * ============================================================================
 * THIS FUNCTION IS THE MOST DANGEROUS CODE IN THE AUTH MODULE
 * ============================================================================
 *
 * A Nest guard receives an `ExecutionContext` that is NOT the same shape for REST and
 * GraphQL. The obvious implementation —
 *
 *     const request = context.switchToHttp().getRequest();
 *
 * — returns `undefined` for a GraphQL resolver, because a resolver's arguments are
 * `(root, args, ctx, info)`, not `(req, res)`. And `undefined` has no actor property,
 * which means the guard would...
 *
 *   ...still throw 401, actually. Which is the *lucky* version of this bug: it fails
 *   closed and someone notices in about a minute.
 *
 * The genuinely dangerous version is the inverse — a guard written to skip the check
 * when it cannot find a request ("it must not be an HTTP call"), which fails OPEN and
 * silently exempts the entire GraphQL surface from authentication while every REST test
 * passes. That is why there is a dedicated test asserting a GraphQL query is rejected
 * without a cookie, and why the phase plan calls for deleting the GraphQL branch below
 * and confirming that test goes red.
 *
 * `contextType` is checked explicitly rather than probing for a truthy request, so the
 * code says which surface it is handling instead of inferring it.
 * ============================================================================
 */
function getRequest(context: ExecutionContext): RequestWithActor | undefined {
  if (context.getType<'graphql' | 'http'>() === 'graphql') {
    const gqlContext = GqlExecutionContext.create(context).getContext<{
      req?: RequestWithActor;
    }>();
    return gqlContext.req;
  }

  return context.switchToHttp().getRequest<RequestWithActor>();
}

export { getRequest as getRequestForTesting };
