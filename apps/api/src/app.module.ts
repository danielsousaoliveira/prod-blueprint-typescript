import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { InfraModule } from './infra/infra.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AuthModule } from './modules/auth/auth.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { DoctorsModule } from './modules/doctors/doctors.module';
import { GraphQLApiModule } from './modules/graphql/graphql.module';
import { HealthModule } from './modules/health/health.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { testSupportModules } from './test-support/test-support.controller';

@Module({
  imports: [
    ConfigModule,
    InfraModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          // Structured JSON in production so a log aggregator can index the fields;
          // human-readable in development because nobody reads raw JSON by choice.
          //
          // Spread rather than `transport: cond ? x : undefined` because
          // exactOptionalPropertyTypes distinguishes "property absent" from "property
          // present and undefined", and pino's types only accept the former. This is
          // the flag paying for itself: passing an explicit undefined here would have
          // been accepted by plain `strict` and is a real mismatch.
          ...(env.NODE_ENV === 'development'
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
          // Health checks run every few seconds. Logging them at info level buries
          // everything that matters.
          autoLogging: {
            ignore: (req) => req.url?.startsWith('/health') ?? false,
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
      }),
    }),
    HealthModule,
    // Before the feature modules: it registers the global APP_GUARD, so everything
    // imported after it is protected by default.
    AuthModule,
    DoctorsModule,
    AvailabilityModule,
    AppointmentsModule,
    JobsModule,
    GraphQLApiModule,
    // Empty in every real deployment — see test-support.controller.ts.
    ...testSupportModules(),
  ],
})
export class AppModule {}
