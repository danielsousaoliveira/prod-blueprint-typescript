// Must be first: populates process.env before anything reads it. In production nothing
// loads a .env file — the platform injects real environment variables — but the Zod
// schema in config/env.ts validates both paths identically, so there is no
// "works locally, missing in prod" gap.
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { Logger as PinoLogger } from 'nestjs-pino';
import { VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './shared/http/problem-details';
import { startNotificationMock } from './test-support/notification-mock';
import { ENV, type Env } from './config/env';

async function bootstrap(): Promise<void> {
  // BEFORE Nest boots, so the very first outbound notification is already intercepted.
  // A no-op unless MOCK_NOTIFICATIONS=1.
  await startNotificationMock(
    process.env.NOTIFICATION_PROVIDER_URL ?? 'https://notifications.example',
  );

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  /**
   * Parses `Cookie` into `request.cookies`, which is where `AuthGuard` reads the session
   * id from. Registered before everything else so it is in place for the first request.
   *
   * NOT signed (`cookieParser(secret)`). A signature would let the server detect a
   * tampered cookie — but the session id is 256 bits of CSPRNG output looked up in Redis,
   * so a tampered value simply fails to resolve. Signing would add a secret to manage for
   * a check the store already performs, and a secret that exists is a secret that can
   * leak or be misconfigured.
   */
  app.use(cookieParser());

  // Replace Nest's default logger with Pino so framework logs and request logs land in
  // one structured stream rather than two differently-shaped ones.
  app.useLogger(app.get(PinoLogger));

  // Wires SIGTERM/SIGINT to `onApplicationShutdown` on every provider — which is how
  // MongoService and RedisService get to close their connections. Phase 8 extends this
  // into full request draining; without it, connections leak on every redeploy.
  app.enableShutdownHooks();

  // URI versioning: /v1/appointments. Chosen over header or media-type versioning because
  // it is visible in logs and curl, and trivially cacheable — a URL is the cache key.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Every error leaves as RFC 7807 problem+json, including unhandled ones (which become a
  // generic 500 with the detail logged, never returned).
  app.useGlobalFilters(new ProblemDetailsFilter());

  const env = app.get<Env>(ENV);
  const logger = app.get(PinoLogger);

  await app.listen(env.PORT);
  logger.log(`API listening on port ${env.PORT} [${env.NODE_ENV}]`);

  /**
   * GRACEFUL SHUTDOWN — three distinct steps, in this order.
   *
   * Cloud Run and Kubernetes both send SIGTERM and then hard-kill after a grace period
   * (10 seconds on Cloud Run by default). Exiting immediately on SIGTERM drops every
   * in-flight request, which during a rolling deploy means a burst of 502s for users who
   * did nothing wrong.
   *
   *   1. STOP ACCEPTING new connections — `app.close()` closes the HTTP listener, so the
   *      load balancer's next health check fails and it stops routing here.
   *   2. DRAIN in-flight work — `close()` waits for open requests to finish, and Nest's
   *      shutdown hooks let the BullMQ workers finish their current jobs rather than
   *      abandoning them mid-notification.
   *   3. CLOSE dependencies — MongoDB and Redis, via onApplicationShutdown.
   *
   * The timeout is the safety net: if a request hangs, exiting at SHUTDOWN_TIMEOUT_MS is
   * better than being SIGKILLed, because a self-inflicted exit still runs the connection
   * cleanup and logs why.
   */
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second SIGTERM must not start a second shutdown — Cloud Run will happily send
    // one, and two concurrent close() calls produce confusing errors on the way out.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`${signal} received — draining in-flight requests`);

    const forceExit = setTimeout(() => {
      logger.error(
        `Shutdown exceeded ${env.SHUTDOWN_TIMEOUT_MS}ms — exiting with work still in flight`,
      );
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    // Do not let the timer itself keep the process alive once draining finishes.
    forceExit.unref();

    try {
      await app.close();
      logger.log('Drained cleanly');
      process.exit(0);
    } catch (error) {
      logger.error(`Shutdown failed: ${String(error)}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
