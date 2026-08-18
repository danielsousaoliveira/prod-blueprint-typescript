import { Module } from '@nestjs/common';
import { APPOINTMENT_REPOSITORY } from '../appointments/domain/appointment.repository';
import { MongoAppointmentRepository } from '../appointments/persistence/mongo-appointment.repository';
import { AvailabilityCache } from './application/availability.cache';
import { AvailabilityService } from './application/availability.service';
import { AVAILABILITY_REPOSITORY } from './domain/availability.repository';
import { MongoAvailabilityRepository } from './persistence/mongo-availability.repository';

@Module({
  providers: [
    AvailabilityService,
    AvailabilityCache,
    { provide: AVAILABILITY_REPOSITORY, useClass: MongoAvailabilityRepository },
    // Availability needs to know which slots are taken. Bound here rather than imported
    // from AppointmentsModule to avoid a circular module dependency — AppointmentsModule
    // imports this one for the booking pre-check.
    { provide: APPOINTMENT_REPOSITORY, useClass: MongoAppointmentRepository },
  ],
  exports: [AvailabilityService, AvailabilityCache, AVAILABILITY_REPOSITORY],
})
export class AvailabilityModule {}
