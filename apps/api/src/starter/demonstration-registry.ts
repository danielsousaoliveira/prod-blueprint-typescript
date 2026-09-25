import type { Type } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Db } from 'mongodb';
import { AppointmentsModule } from '../demonstration/modules/appointments/appointments.module';
import { AvailabilityModule } from '../demonstration/modules/availability/availability.module';
import { DoctorsModule } from '../demonstration/modules/doctors/doctors.module';
import {
  DOCTOR_REPOSITORY,
  PATIENT_REPOSITORY,
  type Doctor,
  type DoctorRepository,
  type Patient,
  type PatientRepository,
} from '../demonstration/modules/doctors/domain/doctor.repository';
import {
  NOTIFICATION_PROVIDER,
  HttpNotificationProvider,
  type NotificationProvider,
} from '../demonstration/modules/notifications/domain/notification.provider';
import { ReminderScheduler } from '../demonstration/modules/notifications/application/reminder.scheduler';
import {
  AppointmentsResolver,
  DoctorResolver,
} from '../demonstration/graphql/appointments.resolver';
import { runMigrations } from '../demonstration/persistence/migrations';
import { MongoAppointmentRepository } from '../demonstration/modules/appointments/persistence/mongo-appointment.repository';

export type {
  Doctor,
  DoctorRepository,
  Patient,
  PatientRepository,
  NotificationProvider,
};
export {
  DOCTOR_REPOSITORY,
  PATIENT_REPOSITORY,
  NOTIFICATION_PROVIDER,
  ReminderScheduler,
};

/**
 * The one sanctioned edge from starter to demonstration.
 *
 * Every place the foundation needs to know something about the example domain is named
 * here, and nowhere else in `starter/`. When `demonstration/` is deleted, this file's
 * bodies are replaced with empty arrays and no-op factories — the shape stays, the
 * implementation goes, and the app still boots into a working (if feature-empty)
 * foundation.
 */
export interface DemonstrationRegistry {
  /** Nest modules imported into `AppModule`. */
  readonly appModules: readonly Type<unknown>[];

  /** Nest modules the GraphQL module must import so its resolvers can resolve deps. */
  readonly graphqlModules: readonly Type<unknown>[];

  /** Resolver classes registered as GraphQL providers. */
  readonly graphqlResolvers: readonly Type<unknown>[];

  /** Builds the outbound notification adapter used by the notification worker. */
  createNotificationProvider(baseUrl: string, apiKey: string): NotificationProvider;

  /** Builds the reminder scheduler bound to the reminders queue. */
  createReminderScheduler(reminderQueue: Queue): ReminderScheduler;

  /** Runs the demonstration's Mongo migration/seed sequence. */
  runMigrations(db: Db, log: (message: string) => void): Promise<string[]>;

  /** Explain plans for the demonstration's hot queries, for `npm run db:explain`. */
  explainQueries(db: Db): readonly { readonly name: string; run(): Promise<unknown> }[];
}

export const demonstrationRegistry: DemonstrationRegistry = {
  appModules: [DoctorsModule, AvailabilityModule, AppointmentsModule],
  graphqlModules: [DoctorsModule, AvailabilityModule, AppointmentsModule],
  graphqlResolvers: [AppointmentsResolver, DoctorResolver],

  createNotificationProvider: (baseUrl, apiKey) =>
    new HttpNotificationProvider(baseUrl, apiKey),

  createReminderScheduler: (reminderQueue) => new ReminderScheduler(reminderQueue),

  runMigrations,
  explainQueries: (db) => MongoAppointmentRepository.explainQueries(db),
};
