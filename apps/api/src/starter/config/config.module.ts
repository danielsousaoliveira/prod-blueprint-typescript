import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv, type Env } from './env';

/**
 * Global so every module can inject ENV without re-importing this module, which is the
 * one case where `@Global()` is justified: configuration is genuinely cross-cutting and
 * has no dependencies of its own.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
