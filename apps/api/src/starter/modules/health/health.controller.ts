import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/auth.guard';
import { HealthService, type HealthReport } from './health.service';

/**
 * VERSION_NEUTRAL: served at `/health`, NOT `/v1/health`.
 *
 * Health checks are infrastructure, not API surface. Orchestrators, load balancers and
 * uptime monitors are configured with a fixed path, so if the endpoint moved every time
 * the API version changed, a `/v2` release would silently break readiness probes and
 * Cloud Run would stop routing traffic to healthy instances.
 *
 * Caught by re-running the Phase 1 manual verification after Phase 4 enabled URI
 * versioning — which had quietly moved this endpoint and broken it.
 */
/**
 * `@Public()` on the class, covering both endpoints.
 *
 * Health probes are made by Cloud Run, load balancers and uptime monitors — none of which
 * have a session, and none of which can be given one. An authenticated readiness probe
 * fails permanently, the orchestrator concludes every instance is unhealthy, and it stops
 * routing traffic to a perfectly working service. That is a total outage caused entirely
 * by adding authentication, and it is exactly the failure the global deny-by-default
 * guard makes possible — which is the point: the guard forced this decision to be made
 * explicitly rather than leaving the endpoints open by omission.
 *
 * The endpoints disclose dependency status and uptime. That is a small amount of
 * information, and at 100x I would keep readiness public (the orchestrator needs it) and
 * move the detailed per-dependency latencies behind auth, exposing only `{status}` here.
 */
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Readiness: reports whether this instance can actually serve traffic.
   *
   * Returns 503 when a dependency is down, because orchestrators route on the status
   * code, not the body. A 200 with `{"status":"unhealthy"}` would keep traffic flowing
   * to a broken instance.
   */
  @Get()
  async readiness(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.health.check();
    res.status(
      report.status === 'healthy' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return report;
  }

  /**
   * Liveness: is the process itself alive and its event loop responsive.
   *
   * Deliberately does NOT check dependencies. Conflating the two is a classic outage
   * amplifier: if liveness failed when MongoDB was briefly unreachable, the orchestrator
   * would restart every instance simultaneously — turning a recoverable database blip
   * into a full restart storm at exactly the moment the database is least able to cope.
   */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'alive' } {
    return { status: 'alive' };
  }
}
