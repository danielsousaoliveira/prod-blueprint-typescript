import { Injectable } from '@nestjs/common';
import type { Collection } from 'mongodb';
import { MongoService } from '../../../infra/mongo.service';
import {
  AVAILABILITY_EXCEPTIONS_COLLECTION,
  AVAILABILITY_RULES_COLLECTION,
} from '../../../persistence/migrations';
import { interval } from '../../../shared/intervals/interval';
import type { RecurringAvailabilityRule } from '../../../shared/time/clinic-time';
import type { AvailabilityException } from '../domain/availability.engine';
import type {
  AvailabilityRepository,
  DoctorSchedule,
} from '../domain/availability.repository';

/**
 * `availability_rules` holds one document per DOCTOR with the rules embedded, and
 * `availability_exceptions` holds one document per exception.
 *
 * That asymmetry is the embed-vs-reference decision made concrete (documented design choice): rules
 * are bounded and always read with the doctor, exceptions grow without limit.
 */
interface ScheduleDocument {
  _id: string;
  timezone: string;
  slotDurationMinutes: number;
  rules: {
    id: string;
    weekday: number;
    startTime: { hour: number; minute: number };
    endTime: { hour: number; minute: number };
    timezone: string;
  }[];
}

interface ExceptionDocument {
  _id: string;
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
}

@Injectable()
export class MongoAvailabilityRepository implements AvailabilityRepository {
  constructor(private readonly mongo: MongoService) {}

  private get schedules(): Collection<ScheduleDocument> {
    return this.mongo.db.collection<ScheduleDocument>(AVAILABILITY_RULES_COLLECTION);
  }

  private get exceptions(): Collection<ExceptionDocument> {
    return this.mongo.db.collection<ExceptionDocument>(
      AVAILABILITY_EXCEPTIONS_COLLECTION,
    );
  }

  async findSchedule(doctorId: string): Promise<DoctorSchedule | null> {
    return (await this.findSchedules([doctorId])).get(doctorId) ?? null;
  }

  /**
   * Two queries total, regardless of how many doctors are requested.
   *
   * The naive version issues one query per doctor — the N+1 problem, at the persistence
   * layer rather than the API layer. Phase 5 solves the same shape with DataLoader for
   * GraphQL; here it is solved by simply having a batch method on the port, which is why
   * the port exposes one at all.
   */
  async findSchedules(
    doctorIds: readonly string[],
  ): Promise<Map<string, DoctorSchedule>> {
    if (doctorIds.length === 0) return new Map();

    const ids = [...doctorIds];
    const [scheduleDocs, exceptionDocs] = await Promise.all([
      this.schedules.find({ _id: { $in: ids } }).toArray(),
      this.exceptions.find({ doctorId: { $in: ids } }).toArray(),
    ]);

    // Bucket exceptions by doctor in one pass — same O(n) Map argument as the
    // availability engine, for the same reason.
    const exceptionsByDoctor = new Map<string, AvailabilityException[]>();
    for (const doc of exceptionDocs) {
      const bucket = exceptionsByDoctor.get(doc.doctorId);
      const mapped: AvailabilityException = {
        id: doc._id,
        doctorId: doc.doctorId,
        period: interval(doc.startsAt.getTime(), doc.endsAt.getTime()),
      };
      if (bucket) bucket.push(mapped);
      else exceptionsByDoctor.set(doc.doctorId, [mapped]);
    }

    const result = new Map<string, DoctorSchedule>();
    for (const doc of scheduleDocs) {
      result.set(doc._id, {
        doctorId: doc._id,
        timezone: doc.timezone,
        slotDurationMinutes: doc.slotDurationMinutes,
        rules: doc.rules.map((rule): RecurringAvailabilityRule => ({
          id: rule.id,
          doctorId: doc._id,
          weekday: rule.weekday as RecurringAvailabilityRule['weekday'],
          startTime: rule.startTime,
          endTime: rule.endTime,
          timezone: rule.timezone,
        })),
        exceptions: exceptionsByDoctor.get(doc._id) ?? [],
      });
    }

    return result;
  }

  async saveSchedule(schedule: DoctorSchedule): Promise<void> {
    await this.schedules.replaceOne(
      { _id: schedule.doctorId },
      // `_id` is omitted from the replacement: it comes from the filter, and the driver's
      // `WithoutId<T>` type enforces that. Including it would be a no-op at best and an
      // attempt to mutate an immutable field at worst.
      {
        timezone: schedule.timezone,
        slotDurationMinutes: schedule.slotDurationMinutes,
        rules: schedule.rules.map((rule) => ({
          id: rule.id,
          weekday: rule.weekday,
          startTime: rule.startTime,
          endTime: rule.endTime,
          timezone: rule.timezone,
        })),
      },
      { upsert: true },
    );

    if (schedule.exceptions.length > 0) {
      await this.exceptions.bulkWrite(
        schedule.exceptions.map((exception) => ({
          replaceOne: {
            filter: { _id: exception.id },
            replacement: {
              _id: exception.id,
              doctorId: exception.doctorId,
              startsAt: new Date(exception.period.start),
              endsAt: new Date(exception.period.end),
            },
            upsert: true,
          },
        })),
      );
    }
  }
}

/** In-memory twin, for unit tests and for the same anti-drift reason as appointments. */
@Injectable()
export class InMemoryAvailabilityRepository implements AvailabilityRepository {
  private readonly store = new Map<string, DoctorSchedule>();

  findSchedule(doctorId: string): Promise<DoctorSchedule | null> {
    return Promise.resolve(this.store.get(doctorId) ?? null);
  }

  findSchedules(doctorIds: readonly string[]): Promise<Map<string, DoctorSchedule>> {
    const result = new Map<string, DoctorSchedule>();
    for (const id of doctorIds) {
      const schedule = this.store.get(id);
      if (schedule) result.set(id, schedule);
    }
    return Promise.resolve(result);
  }

  saveSchedule(schedule: DoctorSchedule): Promise<void> {
    this.store.set(schedule.doctorId, schedule);
    return Promise.resolve();
  }
}
