import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV, type Env } from '../config/env';

/**
 * Owns the Redis connection lifecycle.
 *
 * `lazyConnect` keeps the constructor side-effect-free, so instantiating the service in
 * a unit test does not open a socket. The connection is established explicitly by the
 * first command, or by the health check at boot.
 *
 * Phase 6 will add BullMQ, which requires its OWN connections with
 * `maxRetriesPerRequest: null` — blocking commands cannot share a client with ordinary
 * request/response traffic. This one stays dedicated to caching.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.client = new Redis(this.env.REDIS_URL, { lazyConnect: true });
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing Redis connection');
    await this.client.quit();
  }
}
