import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { httpLoggerOptions } from './config/http-logger';
import { InfraModule } from './infra/infra.module';
import { demonstrationRegistry } from './demonstration-registry';
import { AuthModule } from './modules/auth/auth.module';
import { GraphQLApiModule } from './modules/graphql/graphql.module';
import { HealthModule } from './modules/health/health.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { testSupportModules } from './test-support/test-support.controller';

@Module({
  imports: [
    ConfigModule,
    InfraModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: httpLoggerOptions(env),
      }),
    }),
    HealthModule,
    TenancyModule,
    // Before the feature modules: it registers the global APP_GUARD, so everything
    // imported after it is protected by default.
    AuthModule,
    ...demonstrationRegistry.appModules,
    JobsModule,
    GraphQLApiModule,
    // Empty in every real deployment — see test-support.controller.ts.
    ...testSupportModules(),
  ],
})
export class AppModule {}
