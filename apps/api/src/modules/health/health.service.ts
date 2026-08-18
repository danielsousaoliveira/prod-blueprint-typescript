import { Injectable, Logger } from '@nestjs/common';
import { MongoService } from '../../infra/mongo.service';
import { RedisService } from '../../infra/redis.service';

export type DependencyStatus =
  { status: 'up'; latencyMs: number } | { status: 'down'; error: string };

export interface HealthReport {
  status: 'healthy' | 'unhealthy';
  uptimeSeconds: number;
  dependencies: {
    mongo: DependencyStatus;
    redis: DependencyStatus;
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly mongo: MongoService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Checks each dependency separately and reports them separately.
   *
   * The corner that would normally be cut here is returning a hardcoded `{ ok: true }`.
   * That is worse than useless in Phase 8: Cloud Run uses this endpoint to decide
   * whether to route traffic to the instance, so an endpoint that answers "healthy"
   * while MongoDB is unreachable actively causes the outage it is supposed to prevent.
   *
   * Checks run in parallel — they are independent, and a serial version makes the
   * endpoint's worst case the SUM of both timeouts rather than the max.
   */
  async check(): Promise<HealthReport> {
    const [mongo, redis] = await Promise.all([
      this.probe('mongo', () => this.mongo.ping()),
      this.probe('redis', () => this.redis.ping()),
    ]);

    const healthy = mongo.status === 'up' && redis.status === 'up';

    return {
      status: healthy ? 'healthy' : 'unhealthy',
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: { mongo, redis },
    };
  }

  private async probe(
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<DependencyStatus> {
    const startedAt = performance.now();
    try {
      await fn();
      return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Health probe failed for ${name}: ${message}`);
      return { status: 'down', error: message };
    }
  }
}
