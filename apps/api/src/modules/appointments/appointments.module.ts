import { Module } from '@nestjs/common';
import {
  IDEMPOTENCY_STORE,
  RedisIdempotencyStore,
} from '../../shared/idempotency/idempotency.store';
import {
  DISTRIBUTED_LOCK,
  RedisDistributedLock,
} from '../../shared/locking/distributed-lock';
import { AvailabilityModule } from '../availability/availability.module';
import {
  AppointmentsController,
  AvailabilityController,
} from './api/appointments.controller';
import { AppointmentService } from './application/appointment.service';
import { APPOINTMENT_REPOSITORY } from './domain/appointment.repository';
import { MongoAppointmentRepository } from './persistence/mongo-appointment.repository';

/**
 * Every port is bound to an adapter here, and nowhere else.
 *
 * Consumers inject tokens (`APPOINTMENT_REPOSITORY`, `DISTRIBUTED_LOCK`,
 * `IDEMPOTENCY_STORE`) and receive interfaces — no service names a concrete class. That
 * is what makes the in-memory adapters usable in tests without touching the code under
 * test, and it is the concrete payoff of DECISIONS §1.
 */
@Module({
  imports: [AvailabilityModule],
  controllers: [AppointmentsController, AvailabilityController],
  providers: [
    AppointmentService,
    { provide: APPOINTMENT_REPOSITORY, useClass: MongoAppointmentRepository },
    { provide: DISTRIBUTED_LOCK, useClass: RedisDistributedLock },
    { provide: IDEMPOTENCY_STORE, useClass: RedisIdempotencyStore },
  ],
  exports: [AppointmentService, APPOINTMENT_REPOSITORY],
})
export class AppointmentsModule {}
