import { Global, MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ENV, type Env } from '../../config/env';
import { AuthController } from './api/auth.controller';
import { AuthService } from './application/auth.service';
import { LoginRateLimiter } from './application/login-rate-limiter';
import { RedisSessionStore, SESSION_STORE } from './application/session.store';
import { AuthGuard } from './auth.guard';
import { CsrfMiddleware } from './csrf.middleware';
import { USER_REPOSITORY } from './domain/user.repository';
import { MongoUserRepository } from './persistence/mongo-user.repository';

/**
 * `@Global` because `AuthService` is needed by the guard, which runs for every module's
 * handlers. Without it, every feature module would have to import `AuthModule` — and the
 * one that forgot would fail at boot with a dependency-resolution error rather than
 * silently skipping authentication, so this is ergonomics rather than safety. It matches
 * `ConfigModule`, `InfraModule` and `DoctorsModule`, which are global for the same reason.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginRateLimiter,
    { provide: USER_REPOSITORY, useClass: MongoUserRepository },
    { provide: SESSION_STORE, useClass: RedisSessionStore },
    /**
     * ============================================================================
     * THE GUARD IS BOUND HERE, AND THAT IS THE SECURITY BOUNDARY
     * ============================================================================
     *
     * `APP_GUARD` registers it for EVERY handler in the application — REST controllers
     * and GraphQL resolvers alike — so the default for any new endpoint is "requires
     * authentication". Deleting these five lines silently unauthenticates the entire
     * application while every unit test keeps passing, which is precisely why the phase
     * plan requires removing them once and confirming the authorization integration
     * tests go red.
     *
     * `useFactory` rather than `useClass` only because the guard takes the cookie name
     * from config; reading `process.env` inside the guard would bypass the parse-once
     * discipline the config module exists to enforce.
     * ============================================================================
     */
    {
      provide: APP_GUARD,
      inject: [Reflector, AuthService, ENV],
      useFactory: (reflector: Reflector, auth: AuthService, env: Env) =>
        new AuthGuard(reflector, auth, env.SESSION_COOKIE_NAME),
    },
  ],
  exports: [AuthService],
})
export class AuthModule implements NestModule {
  /**
   * CSRF runs as middleware rather than as a guard, because it must reject the request
   * before any handler-specific logic — and, more importantly, before the body is acted
   * on. A guard would work too; middleware makes the ordering explicit and keeps a
   * transport-level concern out of the guard chain, which is about identity.
   *
   * Applied to every route including `@Public()` ones: login is a POST, and a forged
   * cross-site login is a real attack (it signs the victim into the *attacker's* account,
   * so their subsequent activity is recorded against it).
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CsrfMiddleware).forRoutes('*');
  }
}
