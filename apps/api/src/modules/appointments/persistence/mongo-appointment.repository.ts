import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db, Filter, MongoServerError } from 'mongodb';
import type { Interval } from '../../../shared/intervals/interval';
import { MongoService } from '../../../infra/mongo.service';
import { APPOINTMENTS_COLLECTION } from '../../../persistence/migrations';
import { OUTBOX_COLLECTION, type OutboxMessage } from '../../outbox/domain/outbox';
import {
  type OutboxDocument,
  toOutboxDocument,
} from '../../outbox/persistence/mongo-outbox.repository';
import type { Appointment } from '../domain/appointment';
import {
  AppointmentNotFoundError,
  type AppointmentRepository,
  type AppointmentStatsRow,
  type FindAppointmentsQuery,
  SlotTakenError,
} from '../domain/appointment.repository';
import { type AppointmentDocument, toDocument, toDomain } from './appointment.document';

/** MongoDB's duplicate-key error code. */
const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): error is MongoServerError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY
  );
}

@Injectable()
export class MongoAppointmentRepository implements AppointmentRepository {
  constructor(private readonly mongo: MongoService) {}

  private get collection(): Collection<AppointmentDocument> {
    return this.mongo.db.collection<AppointmentDocument>(APPOINTMENTS_COLLECTION);
  }

  /**
   * The double-booking guarantee, in four lines.
   *
   * There is no read-then-write here, and deliberately no "check if the slot is free
   * first". Any such check has a window between the read and the insert, and no amount
   * of application code closes it — two processes can both read "free" before either
   * writes. The insert either succeeds or the unique index rejects it, and that decision
   * is made atomically inside the database.
   *
   * Catching error 11000 and rethrowing it as a domain error is the adapter earning its
   * place: the service layer gets `SlotTakenError` and never has to know that 11000
   * means duplicate key.
   */
  async create(
    appointment: Appointment,
    outbox: readonly OutboxMessage[] = [],
  ): Promise<Appointment> {
    try {
      if (outbox.length === 0) {
        // No outbox messages: a single-document insert is already atomic, and a
        // transaction here would add latency and an oplog write for nothing. This is
        // the DECISIONS §13 position — transactions where they are warranted, not
        // everywhere "for safety".
        await this.collection.insertOne(toDocument(appointment));
        return appointment;
      }

      await this.withTransaction(async (session) => {
        await this.collection.insertOne(toDocument(appointment), { session });
        await this.mongo.db
          .collection<OutboxDocument>(OUTBOX_COLLECTION)
          .insertMany(outbox.map(toOutboxDocument), { session });
      });

      return appointment;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new SlotTakenError(
          appointment.doctorId,
          toDocument(appointment).startsAt.getTime(),
        );
      }
      throw error;
    }
  }

  /**
   * Run a unit of work inside a transaction.
   *
   * `withTransaction` handles the retry semantics the driver requires — a transaction can
   * fail with a TransientTransactionError (for example under write conflict) and is
   * expected to be retried wholesale rather than resumed. Hand-rolling
   * startTransaction/commit misses that and produces intermittent failures under load.
   *
   * Requires a replica set, which is why docker-compose has run one since Phase 1.
   */
  private async withTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = this.mongo.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Compare-and-set on status.
   *
   * `findOneAndReplace` with `{ _id, status: expectedStatus }` is a single atomic
   * operation. If another request already transitioned this appointment, the filter
   * matches nothing and we report it rather than overwriting their work — the lost-update
   * problem, solved without a lock.
   *
   * The replace can ALSO violate the unique index: accepting a counter-proposal rewrites
   * `startsAt` to the proposed slot, which may have been taken in the meantime. That is
   * the exact moment the guarantee has to hold for counter-proposals, and it does.
   */
  async update(
    appointment: Appointment,
    expectedStatus: Appointment['status'],
    outbox: readonly OutboxMessage[] = [],
  ): Promise<Appointment> {
    const document = toDocument(appointment);

    try {
      const result = await (outbox.length === 0
        ? this.collection.findOneAndReplace(
            { _id: appointment.id, status: expectedStatus },
            document,
            { returnDocument: 'after' },
          )
        : this.withTransaction(async (session) => {
            const replaced = await this.collection.findOneAndReplace(
              { _id: appointment.id, status: expectedStatus },
              document,
              { returnDocument: 'after', session },
            );
            // Only write the outbox if the compare-and-set actually matched. Emitting a
            // "confirmed" message for a transition that lost its race would notify the
            // patient about a state change that never happened.
            if (replaced) {
              await this.mongo.db
                .collection<OutboxDocument>(OUTBOX_COLLECTION)
                .insertMany(outbox.map(toOutboxDocument), { session });
            }
            return replaced;
          }));

      if (!result) {
        // Distinguish "gone" from "someone got there first" — the caller's recovery
        // differs: one is a 404, the other is a 409 worth retrying.
        const exists = await this.collection.findOne({ _id: appointment.id });
        throw exists
          ? new SlotTakenError(appointment.doctorId, document.startsAt.getTime())
          : new AppointmentNotFoundError(appointment.id);
      }

      return toDomain(result);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new SlotTakenError(appointment.doctorId, document.startsAt.getTime());
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Appointment | null> {
    const doc = await this.collection.findOne({ _id: id });
    return doc ? toDomain(doc) : null;
  }

  async find(query: FindAppointmentsQuery): Promise<Appointment[]> {
    const filter: Filter<AppointmentDocument> = {};

    if (query.doctorId !== undefined) filter.doctorId = query.doctorId;
    if (query.patientId !== undefined) filter.patientId = query.patientId;
    if (query.statuses !== undefined) filter.status = { $in: [...query.statuses] };

    if (query.within !== undefined) {
      // Half-open overlap, expressed as a query: an appointment intersects the window if
      // it starts before the window ends AND ends after the window starts. Same predicate
      // as `overlaps()` in the domain, just written in MongoDB's syntax.
      filter.startsAt = { $lt: new Date(query.within.end) };
      filter.endsAt = { $gt: new Date(query.within.start) };
    }

    const docs = await this.collection.find(filter).sort({ startsAt: 1 }).toArray();
    return docs.map(toDomain);
  }

  /**
   * Appointments per status, per doctor, per ISO week.
   *
   * Stage order is the whole lesson here, so it is worth stating why it is this way:
   *
   * 1. `$match` FIRST. It is the only stage that can use an index, and only while it is
   *    still the first stage — once any transforming stage runs, the documents are no
   *    longer index-backed and every later `$match` is a full scan of the intermediate
   *    result. Matching first also shrinks everything downstream.
   * 2. `$group` next, on the truncated week. `$dateTrunc` does the ISO-week bucketing in
   *    the database rather than pulling every document into Node to bucket in JS.
   * 3. `$sort` LAST, on the grouped output, which is small. Sorting before grouping would
   *    sort the full matched set for no benefit.
   */
  async statsByStatusPerWeek(range: Interval): Promise<AppointmentStatsRow[]> {
    const rows = await this.collection
      .aggregate<{
        _id: { doctorId: string; weekStart: Date; status: Appointment['status'] };
        count: number;
      }>([
        {
          $match: {
            startsAt: { $gte: new Date(range.start), $lt: new Date(range.end) },
          },
        },
        {
          $group: {
            _id: {
              doctorId: '$doctorId',
              weekStart: {
                $dateTrunc: { date: '$startsAt', unit: 'week', startOfWeek: 'monday' },
              },
              status: '$status',
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.doctorId': 1, '_id.weekStart': 1, '_id.status': 1 } },
      ])
      .toArray();

    return rows.map((row) => ({
      doctorId: row._id.doctorId,
      weekStart: row._id.weekStart.getTime(),
      status: row._id.status,
      count: row.count,
    }));
  }

  /** Used by `npm run db:explain`. Not part of the repository port. */
  static explainQueries(db: Db) {
    const collection = db.collection<AppointmentDocument>(APPOINTMENTS_COLLECTION);
    const now = new Date();
    const weekLater = new Date(now.getTime() + 7 * 86_400_000);

    return [
      {
        name: "doctor's calendar for a week",
        run: () =>
          collection
            .find({ doctorId: 'doctor-1', startsAt: { $gte: now, $lt: weekLater } })
            .sort({ startsAt: 1 })
            .explain('executionStats'),
      },
      {
        name: 'patient history',
        run: () =>
          collection
            .find({ patientId: 'patient-1' })
            .sort({ startsAt: -1 })
            .explain('executionStats'),
      },
      {
        name: 'active appointments for a doctor (unique-index prefix)',
        run: () =>
          collection
            .find({ doctorId: 'doctor-1', status: 'CONFIRMED' })
            .explain('executionStats'),
      },
    ];
  }
}
