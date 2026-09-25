import type { Type } from '@nestjs/common';
import type DataLoader from 'dataloader';
import type { Db } from 'mongodb';
import { AppointmentsModule } from '../demonstration/modules/appointments/appointments.module';
import { AvailabilityModule } from '../demonstration/modules/availability/availability.module';
import { DoctorsModule } from '../demonstration/modules/doctors/doctors.module';
import {
  DOCTOR_REPOSITORY,
  PATIENT_REPOSITORY,
  type DoctorRepository,
  type PatientRepository,
} from '../demonstration/modules/doctors/domain/doctor.repository';
import { createDemonstrationLoaders } from '../demonstration/graphql/loaders';
import {
  AppointmentsResolver,
  DoctorResolver,
} from '../demonstration/graphql/appointments.resolver';
import { runMigrations } from '../demonstration/persistence/migrations';
import { MongoAppointmentRepository } from '../demonstration/modules/appointments/persistence/mongo-appointment.repository';

/**
 * The one sanctioned edge from starter to demonstration.
 *
 * Every place the foundation needs to know something about the example domain is named
 * here, and nowhere else in `starter/`. When `demonstration/` is deleted, this file's
 * bodies are replaced with empty arrays and no-op factories — the shape stays, the
 * implementation goes, and the app still boots into a working (if feature-empty)
 * foundation.
 *
 * Every member is typed in terms of starter-owned shapes only (Nest's `Type`, plain
 * `unknown`, generic DataLoader records) — never a demonstration-owned type such as
 * `Doctor` or `NotificationProvider`. A starter file that needed one of those would be
 * coupled to the tree this file exists to make deletable.
 */
export interface DemonstrationRegistry {
  /** Nest modules imported into `AppModule`. */
  readonly appModules: readonly Type<unknown>[];

  /** Nest modules the GraphQL module must import so its resolvers can resolve deps. */
  readonly graphqlModules: readonly Type<unknown>[];

  /** Resolver classes registered as GraphQL providers. */
  readonly graphqlResolvers: readonly Type<unknown>[];

  /**
   * Nest injection tokens for whatever `createLoaders` needs, in the order it expects
   * them. The starter's GraphQL context factory spreads these into its own `inject`
   * array without ever naming what they resolve to.
   */
  readonly loaderInjectionTokens: readonly unknown[];

  /**
   * Builds this request's DataLoaders from the resolved `loaderInjectionTokens`, keyed
   * by whatever name a resolver will look them up under (e.g. `"doctor"`).
   */
  createLoaders(
    ...deps: unknown[]
  ): Readonly<Record<string, DataLoader<string, unknown>>>;

  /** Runs the demonstration's Mongo migration/seed sequence. */
  runMigrations(db: Db, log: (message: string) => void): Promise<string[]>;

  /** Explain plans for the demonstration's hot queries, for `npm run db:explain`. */
  explainQueries(db: Db): readonly { readonly name: string; run(): Promise<unknown> }[];
}

export const demonstrationRegistry: DemonstrationRegistry = {
  appModules: [DoctorsModule, AvailabilityModule, AppointmentsModule],
  graphqlModules: [DoctorsModule, AvailabilityModule, AppointmentsModule],
  graphqlResolvers: [AppointmentsResolver, DoctorResolver],

  loaderInjectionTokens: [DOCTOR_REPOSITORY, PATIENT_REPOSITORY],
  createLoaders: (...deps) => {
    const [doctors, patients] = deps as [DoctorRepository, PatientRepository];
    return createDemonstrationLoaders(doctors, patients);
  },

  runMigrations,
  explainQueries: (db) => MongoAppointmentRepository.explainQueries(db),
};
