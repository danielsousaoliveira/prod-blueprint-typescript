import type { Db } from 'mongodb';
import { ACTIVE_STATUSES } from '../../modules/appointments/domain/appointment';
import { OUTBOX_COLLECTION } from '../../../starter/modules/outbox/domain/outbox';

/**
 * Ordered, forward-only migrations.
 *
 * Run as a SEPARATE DEPLOY STEP, never on application boot. Creating indexes at startup
 * looks convenient and is wrong for three reasons: several instances starting at once
 * race each other, an index build on a large collection blocks the boot it is attached
 * to, and it means a deploy silently mutates the database schema with no record of when
 * or whether it happened.
 *
 * Every migration must be BACKWARDS COMPATIBLE with the currently-running code, because
 * during a rolling deploy both versions run simultaneously. In practice that means
 * additive changes only — add a field, add an index, backfill — and any destructive step
 * (dropping a column, dropping an index) waits for a LATER release, once no running code
 * depends on it. "Add in release N, remove in release N+1" is the whole discipline.
 */

export interface Migration {
  readonly id: string;
  readonly description: string;
  up(db: Db): Promise<void>;
}

export const MIGRATIONS_COLLECTION = 'migrations';
export const APPOINTMENTS_COLLECTION = 'appointments';
export const AVAILABILITY_RULES_COLLECTION = 'availability_rules';
export const AVAILABILITY_EXCEPTIONS_COLLECTION = 'availability_exceptions';

/** The index name is referenced by the adapter when translating duplicate-key errors. */
export const UNIQUE_ACTIVE_SLOT_INDEX = 'uniq_doctor_slot_active';

export const migrations: readonly Migration[] = [
  {
    id: '001-appointments-unique-active-slot',
    description:
      'Partial unique index on (doctorId, startsAt) restricted to active statuses — the double-booking guarantee',
    async up(db) {
      await db.collection(APPOINTMENTS_COLLECTION).createIndex(
        { doctorId: 1, startsAt: 1 },
        {
          name: UNIQUE_ACTIVE_SLOT_INDEX,
          unique: true,
          /**
           * THE partial filter, and the reason this index is correct rather than merely
           * restrictive.
           *
           * A plain unique index on (doctorId, startsAt) would mean a doctor could never
           * have two appointments at the same time EVER — so a cancelled 09:00 slot
           * could never be rebooked, and one cancellation would burn that time forever.
           *
           * Filtering to active statuses means uniqueness only applies among
           * appointments that actually hold the slot. Cancelled, declined and completed
           * rows are invisible to the index, so the slot frees up the instant the
           * appointment reaches a terminal state.
           *
           * The status list is imported from the domain rather than written out here, so
           * adding a status that holds a slot cannot silently fall outside the guarantee.
           */
          partialFilterExpression: { status: { $in: [...ACTIVE_STATUSES] } },
        },
      );
    },
  },

  {
    id: '002-appointments-query-indexes',
    description: 'Compound indexes for the doctor and patient calendar queries',
    async up(db) {
      const appointments = db.collection(APPOINTMENTS_COLLECTION);

      /**
       * EQUALITY -> SORT -> RANGE ordering, which is the rule worth being able to
       * justify rather than recite.
       *
       * The query this serves is "appointments for THIS doctor, in THIS window, newest
       * first":
       *
       *   { doctorId: X, startsAt: { $gte: A, $lt: B } }  sorted by startsAt
       *
       * - `doctorId` is an EQUALITY match, so it goes first. It selects one contiguous
       *   section of the index; every subsequent key is then scanned within that section
       *   only.
       * - `startsAt` serves both the SORT and the RANGE here, which is the lucky case.
       *
       * Getting the order wrong — range before equality — means the index can still be
       * used, but the range scans a huge section of the tree and the equality filter is
       * applied to each entry afterwards, so `totalKeysExamined` balloons relative to
       * `nReturned`. That ratio is what `npm run db:explain` prints.
       *
       * If a sort field sat AFTER a range field, MongoDB could not use the index for the
       * sort at all and would fall back to an in-memory SORT stage, which fails outright
       * past 32MB.
       */
      await appointments.createIndex(
        { doctorId: 1, startsAt: 1, status: 1 },
        { name: 'doctor_calendar' },
      );

      // The patient's own list: same reasoning, different equality prefix.
      await appointments.createIndex(
        { patientId: 1, startsAt: -1 },
        { name: 'patient_history' },
      );

      // Supports the stats aggregation's $match on a date range across all doctors.
      await appointments.createIndex({ startsAt: 1, status: 1 }, { name: 'stats_range' });
    },
  },

  {
    id: '003-availability-indexes',
    description: 'Indexes for recurring rules and exceptions',
    async up(db) {
      await db
        .collection(AVAILABILITY_RULES_COLLECTION)
        .createIndex({ doctorId: 1, weekday: 1 }, { name: 'rules_by_doctor' });

      await db
        .collection(AVAILABILITY_EXCEPTIONS_COLLECTION)
        .createIndex({ doctorId: 1, startsAt: 1 }, { name: 'exceptions_by_doctor' });
    },
  },

  {
    id: '004-outbox-indexes',
    description: 'Indexes for the transactional outbox relay',
    async up(db) {
      // The relay's hot query: unpublished messages, oldest first, whose claim has
      // expired. Equality on publishedAt, then sort by createdAt — equality-sort-range
      // ordering again, and the reason the relay stays O(batch) rather than O(outbox) as
      // the table accumulates published rows.
      await db
        .collection(OUTBOX_COLLECTION)
        .createIndex({ publishedAt: 1, createdAt: 1 }, { name: 'outbox_pending' });

      // Published rows are retained for audit but expire after 7 days. Without this the
      // outbox grows without bound — it is an append-only log of every state change.
      //
      // Indexed on `publishedAtDate` rather than `publishedAt`: a TTL index only acts on
      // a BSON Date and silently expires NOTHING when pointed at a number. The adapter
      // writes both fields for exactly this reason.
      await db
        .collection(OUTBOX_COLLECTION)
        .createIndex(
          { publishedAtDate: 1 },
          { name: 'outbox_ttl', expireAfterSeconds: 7 * 24 * 60 * 60 },
        );
    },
  },
  {
    id: '005-users',
    description: 'Retired: authentication accounts now live in Postgres',
    up() {
      // Preserve the journal entry; new databases must never create Mongo auth records.
      return Promise.resolve();
    },
  },
];

interface MigrationRecord {
  _id: string;
  appliedAt: Date;
  description: string;
}

/**
 * Apply every migration that has not run yet, in order.
 *
 * Idempotent by recording each applied id. Running it twice is a no-op, which matters
 * because a deploy step gets retried.
 *
 * Deliberately NOT wrapped in a transaction: MongoDB index builds are DDL and cannot
 * participate in one. Each migration is therefore written to be individually safe to
 * re-run — `createIndex` is idempotent for an identical specification.
 */
export async function runMigrations(
  db: Db,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  const collection = db.collection<MigrationRecord>(MIGRATIONS_COLLECTION);
  const applied = new Set((await collection.find({}).toArray()).map((row) => row._id));

  const justApplied: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    log(`applying ${migration.id}: ${migration.description}`);
    await migration.up(db);
    await collection.insertOne({
      _id: migration.id,
      appliedAt: new Date(),
      description: migration.description,
    });
    justApplied.push(migration.id);
  }

  return justApplied;
}
