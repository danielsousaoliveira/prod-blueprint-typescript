import { createParamDecorator, type ExecutionContext, HttpStatus } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ProblemException, problems } from '../../shared/http/problem-details';
import { ACTOR_PROPERTY, type RequestWithActor } from './auth.guard';
import type { Actor } from './domain/user';

/**
 * Injects the authenticated `Actor` into a handler parameter.
 *
 * ============================================================================
 * WHY THIS THROWS INSTEAD OF RETURNING `undefined`
 * ============================================================================
 *
 * The guard has already run by the time a parameter decorator executes, so on a
 * protected route the actor is always present and this throw is unreachable. It exists
 * for the case that is NOT unreachable: someone marks a handler `@Public()` and also
 * asks for `@CurrentActor()`.
 *
 * If this returned `undefined`, the handler's parameter would be typed `Actor` and hold
 * `undefined` — a lie the type system cannot catch, which then flows into an
 * authorization check as `actor.profileId === appointment.doctorId`, i.e. `undefined ===
 * 'doctor-1'`. That comparison is `false`, so it fails closed by luck rather than by
 * design, and on a different check shape it would fail open.
 *
 * Throwing turns a subtle authorization bug into an immediate 500 on the first request
 * in development. A handler that genuinely wants "the actor if there is one" uses
 * `@OptionalActor()` below and gets a type that admits `undefined`, so the compiler
 * forces the null check.
 * ============================================================================
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const actor = actorFromContext(context);

    if (!actor) {
      throw new ProblemException({
        type: problems.unauthenticated,
        title: 'Authentication required',
        status: HttpStatus.UNAUTHORIZED,
      });
    }

    return actor;
  },
);

/** For handlers that behave differently when signed in, but do not require it. */
export const OptionalActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor | undefined =>
    actorFromContext(context),
);

/**
 * Mirrors `getRequest` in auth.guard.ts, and for the same reason — a parameter decorator
 * sees the same two-shaped `ExecutionContext` the guard does. Duplicated deliberately
 * rather than shared, because importing the guard's helper here would create a cycle
 * (the guard imports this module's `Actor` type); the duplication is four lines and both
 * copies are covered by the GraphQL authz test.
 */
function actorFromContext(context: ExecutionContext): Actor | undefined {
  if (context.getType<'graphql' | 'http'>() === 'graphql') {
    const gqlContext = GqlExecutionContext.create(context).getContext<{
      req?: RequestWithActor;
    }>();
    return gqlContext.req?.[ACTOR_PROPERTY];
  }

  return context.switchToHttp().getRequest<RequestWithActor>()[ACTOR_PROPERTY];
}
