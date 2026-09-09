import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Inject, Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { ENV, type Env } from '../../config/env';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AvailabilityModule } from '../availability/availability.module';
import { DoctorsModule } from '../doctors/doctors.module';
import {
  DOCTOR_REPOSITORY,
  PATIENT_REPOSITORY,
  type DoctorRepository,
  type PatientRepository,
} from '../doctors/domain/doctor.repository';
import { AuthService } from '../auth/application/auth.service';
import { AppointmentsResolver, DoctorResolver } from './appointments.resolver';
import { ComplexityPlugin } from './complexity.plugin';
import { createLoaders, type GraphQLContext } from './dataloaders';
import { MAX_DEPTH, depthLimit } from './query-guards';

/**
 * Minimal cookie parsing for the WebSocket upgrade.
 *
 * `cookie-parser` is Express middleware and the upgrade request never passes through the
 * Express stack, so `request.cookies` does not exist here. Fifteen lines rather than a
 * second cookie dependency for one call site.
 *
 * `decodeURIComponent` matters: session ids are base64url and never need escaping, but a
 * cookie value that HAS been escaped and is not unescaped produces a hash miss and a
 * mystifying "your session is invalid" for a session that is perfectly fine.
 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return undefined;
}

@Module({
  imports: [
    AppointmentsModule,
    AvailabilityModule,
    DoctorsModule,
    NestGraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [DoctorsModule],
      inject: [ENV, DOCTOR_REPOSITORY, PATIENT_REPOSITORY, AuthService],
      useFactory: (
        env: Env,
        doctors: DoctorRepository,
        patients: PatientRepository,
        auth: AuthService,
      ): ApolloDriverConfig => ({
        /**
         * Code-first: the SDL is generated from the decorated classes.
         *
         * In DEVELOPMENT it is written to `schema.gql`, which makes the schema reviewable
         * in pull requests — schema-first's main benefit (a visible contract with a
         * visible diff) without the drift risk of hand-maintaining it.
         *
         * In PRODUCTION it is generated IN MEMORY (`true`), because writing it fails:
         * the container runs as a non-root user in a root-owned directory, and Cloud
         * Run's filesystem is read-only apart from /tmp. Nothing reads the file at
         * runtime — it is a build-time artefact — so writing it in production was pure
         * cost with a crash attached.
         *
         * Found by running the built image, not by any test: every local run and every
         * integration test writes the file happily as the owning user.
         */
        autoSchemaFile: env.NODE_ENV === 'production' ? true : 'schema.gql',
        sortSchema: true,

        /**
         * THE PER-REQUEST CONTEXT.
         *
         * This factory runs once per request, so every request gets its own loaders and
         * therefore its own cache. Hoisting `createLoaders(...)` outside this function
         * would be a cross-request data leak, not an optimisation — see dataloaders.ts.
         */
        context: (ctx: { req?: unknown }): GraphQLContext => ({
          loaders: createLoaders(doctors, patients),
          /**
           * The request is passed through so the guard and `@CurrentActor()` can reach
           * it. Previously this factory took no arguments at all, which meant a Nest
           * guard asking for the HTTP request during a GraphQL operation got
           * `undefined` — see the long comment in `auth.guard.ts` about why that is the
           * single most dangerous line in the auth module.
           */
          req: ctx.req,
        }),

        // Introspection and the playground are development-only. In production they hand
        // an attacker the complete shape of the API, including fields a client was never
        // meant to discover. Disabling them is not security by itself — the depth and
        // complexity limits do the real work — but there is no reason to publish a map.
        introspection: env.NODE_ENV !== 'production',
        playground: false,

        // Validation rules run before execution, so a rejected query costs nothing.
        validationRules: [depthLimit(MAX_DEPTH)],

        subscriptions: {
          // graphql-ws, not the deprecated subscriptions-transport-ws.
          //
          // Cloud Run handles long-lived WebSockets poorly — it bills for connection
          // duration, caps request timeout, and does not do session affinity by default.
          // Combined with the in-process PubSub in the resolver (which does not fan out
          // across instances), production polls instead. documented design choice.
          'graphql-ws': {
            /**
             * ============================================================================
             * A WEBSOCKET AUTHENTICATES ONCE, AT CONNECTION TIME
             * ============================================================================
             *
             * This hook is easy to omit and its absence is silent. HTTP requests carry a
             * cookie on every call, so the guard re-checks identity continuously. A
             * WebSocket sends its headers exactly once, during the upgrade — after that,
             * messages arrive on an already-open socket with no headers at all.
             *
             * Without this, `context.actor` in the subscription filter is always
             * undefined. That fails CLOSED here (the filter returns false and nobody
             * receives anything), which is the lucky direction — but a filter written to
             * fall back to the id-only check when no actor is present would fail OPEN and
             * silently restore the leak this phase closed.
             *
             * The cookie is parsed manually because `cookie-parser` is Express middleware
             * and the WebSocket upgrade does not pass through the Express stack.
             *
             * THE LIMITATION, stated plainly: identity is fixed for the life of the
             * connection. Logging out does not close an open socket, so a subscription
             * established before logout keeps receiving updates until the client
             * disconnects. Fixing that properly means tracking sockets per session and
             * closing them on logout. Not built — this project polls in production
             * (documented design choice), so the subscription is a demonstration rather than a
             * shipped path, and pretending otherwise by half-building it would be worse
             * than saying so.
             * ============================================================================
             */
            onConnect: async (context: unknown): Promise<Record<string, unknown>> => {
              // `graphql-ws`'s Context type does not describe `extra`, which is where the
              // driver stashes the upgrade request. Narrowed here rather than fought with
              // — the shape is checked at every step, so a change in the library surfaces
              // as "no actor" (fails closed) rather than a crash.
              const extra = (context as { extra?: unknown }).extra;
              const request = (extra as { request?: unknown } | undefined)?.request;
              const headers = (request as { headers?: unknown } | undefined)?.headers;
              const cookieHeader = (headers as { cookie?: unknown } | undefined)?.cookie;

              const sessionId =
                typeof cookieHeader === 'string'
                  ? readCookie(cookieHeader, env.SESSION_COOKIE_NAME)
                  : undefined;
              if (!sessionId) return { actor: undefined };

              const actor = await auth.resolve(sessionId);
              return { actor: actor ?? undefined };
            },
          },
        },

        formatError: (error) => ({
          message: error.message,
          // `extensions.code` is the stable, machine-readable part — deliberately the
          // same vocabulary as the REST problem `type` URIs.
          extensions: { code: error.extensions?.code ?? 'INTERNAL_ERROR' },
          ...(error.path ? { path: error.path } : {}),
        }),
      }),
    }),
  ],
  providers: [AppointmentsResolver, DoctorResolver, ComplexityPlugin],
})
export class GraphQLApiModule {
  constructor(@Inject(ENV) _env: Env) {}
}
