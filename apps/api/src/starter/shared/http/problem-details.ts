import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  PipeTransform,
  Injectable,
  type ArgumentMetadata,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError, type ZodType } from 'zod';

/**
 * RFC 7807 `application/problem+json`.
 *
 * A registered, self-describing error format rather than a bespoke `{ error: "..." }`
 * envelope. The payoff is `type`: a stable URI that clients branch on, instead of
 * string-matching human-readable messages that change the moment someone improves the
 * wording.
 */
export interface ProblemDetails {
  /** Stable identifier for the error class. The only field clients should branch on. */
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Extension member — RFC 7807 permits these. */
  errors?: { path: string; message: string }[];
}

const PROBLEM_BASE = 'https://tenantforge.example/problems';

export const problems = {
  validation: `${PROBLEM_BASE}/validation-failed`,
  slotTaken: `${PROBLEM_BASE}/slot-taken`,
  slotUnavailable: `${PROBLEM_BASE}/slot-unavailable`,
  illegalTransition: `${PROBLEM_BASE}/illegal-transition`,
  notFound: `${PROBLEM_BASE}/not-found`,
  contended: `${PROBLEM_BASE}/contended`,
  idempotencyMismatch: `${PROBLEM_BASE}/idempotency-key-reuse`,
  idempotencyInFlight: `${PROBLEM_BASE}/idempotency-key-in-flight`,
  internal: `${PROBLEM_BASE}/internal-error`,

  /**
   * 401 — no valid session. The client should authenticate and retry.
   *
   * Note there is deliberately no separate type for "session expired": telling a client
   * that a session id it presented *used to be valid* confirms the id was real, which is
   * an oracle for anyone testing guessed values. Absent, expired and revoked all look
   * identical from outside.
   */
  unauthenticated: `${PROBLEM_BASE}/unauthenticated`,
  /**
   * 403 — authenticated, is a party to the resource, but not permitted this action.
   *
   * Used ONLY when the caller already knows the resource exists. A caller who is not a
   * party gets 404 from `notFound` instead — see documented design choice, and the long comment in
   * the appointments controller.
   */
  forbidden: `${PROBLEM_BASE}/forbidden`,
  /** 429 — too many failed login attempts. */
  rateLimited: `${PROBLEM_BASE}/rate-limited`,
  /** 403 — a state-changing request whose Origin is not one we serve. */
  crossOrigin: `${PROBLEM_BASE}/cross-origin-request`,
} as const;

/** Thrown by controllers; rendered as problem+json by the filter below. */
export class ProblemException extends HttpException {
  constructor(readonly problem: ProblemDetails) {
    super(problem, problem.status);
  }
}

/**
 * Validation pipe driven by a Zod schema.
 *
 * Returns the PARSED value, not the raw input — so transformations declared in the schema
 * (ISO string to epoch milliseconds) actually take effect, and the controller receives
 * data in the shape the service expects.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ProblemException({
        type: problems.validation,
        title: 'Request validation failed',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        // Field-level detail so a client can highlight the offending input rather than
        // showing a generic failure.
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}

/**
 * Renders every error as problem+json.
 *
 * Deliberately does NOT forward arbitrary exception messages to the client. An unexpected
 * error becomes a generic 500 with the detail logged server-side — an unhandled exception
 * message frequently contains a connection string, a query, or a stack path, and leaking
 * that is a real disclosure bug rather than a helpful error message.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    /**
     * ============================================================================
     * GRAPHQL ERRORS MUST PASS STRAIGHT THROUGH. THIS WAS A REAL BUG.
     * ============================================================================
     *
     * `@Catch()` with no argument catches EVERYTHING, and `useGlobalFilters` applies to
     * every execution context — not just HTTP. So this filter was also intercepting every
     * error thrown by a GraphQL resolver, where `switchToHttp().getRequest()` returns
     * `undefined` and reading `.url` off it throws.
     *
     * The result: every deliberate GraphQL error — `SLOT_TAKEN`, `ILLEGAL_TRANSITION`,
     * `FORBIDDEN` — was replaced in production by
     *
     *     { message: "Cannot read properties of undefined (reading 'url')",
     *       extensions: { code: "INTERNAL_SERVER_ERROR" } }
     *
     * ...so the entire carefully-built error vocabulary reached no client, and every
     * failure looked like a server crash. Present since Phase 5, when GraphQL was added
     * alongside the Phase 4 filter.
     *
     * It survived two phases of GraphQL tests because the GraphQL integration suite
     * builds its own Nest application and never registers this filter — the suite was
     * testing a configuration that production does not run. Found in Phase 10 only
     * because the new authorization suite registers BOTH, which is what production
     * actually does.
     *
     * Rethrowing hands the error back to Apollo, which formats it with the schema's
     * `formatError` — the code path the GraphQL error mapping was written for.
     * ============================================================================
     */
    if (host.getType<'graphql' | 'http'>() !== 'http') {
      throw exception;
    }

    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<{ url?: string }>();

    const problem = this.toProblem(exception, request.url);

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown, instance?: string): ProblemDetails {
    if (exception instanceof ProblemException) {
      return { ...exception.problem, ...(instance ? { instance } : {}) };
    }

    // A Zod error that escaped a pipe — e.g. thrown inside a service.
    if (exception instanceof ZodError) {
      return {
        type: problems.validation,
        title: 'Request validation failed',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: exception.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
        ...(instance ? { instance } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: status === 404 ? problems.notFound : `${PROBLEM_BASE}/http-${status}`,
        title: exception.message,
        status,
        ...(instance ? { instance } : {}),
      };
    }

    this.logger.error('Unhandled exception', exception);
    return {
      type: problems.internal,
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      ...(instance ? { instance } : {}),
    };
  }
}
