import type { Db } from 'mongodb';
import { ACTIVE_STATUSES } from '../../modules/appointments/domain/appointment';
import { hashPassword } from '../../modules/auth/domain/password';
import { OUTBOX_COLLECTION } from '../../modules/outbox/domain/outbox';

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
    description:
      'User accounts: unique email index, and demo accounts outside production',
    async up(db) {
      /**
       * Unique on email — the constraint that makes "one account per address" true rather
       * than merely intended.
       *
       * Same reasoning as the appointment slot index (documented design choice): a check-then-
       * insert in application code has a window between the read and the write, and two
       * concurrent signups for the same address both pass it. The database is the only
       * place that decides atomically.
       *
       * Emails are stored already-lowercased (`normaliseEmail`), so this is a plain unique
       * index rather than a collation-based one. A case-insensitive collation would also
       * work and would tolerate mixed-case data, but it changes how the index is used for
       * ordinary lookups and is easy to get subtly wrong. Normalising on write is the
       * simpler invariant: there is only ever one form in the database.
       */
      await db
        .collection('users')
        .createIndex({ email: 1 }, { name: 'uniq_user_email', unique: true });

      /**
       * ============================================================================
       * DEMO ACCOUNTS, AND WHY THE PRODUCTION GUARD IS NOT PARANOIA
       * ============================================================================
       *
       * These are real accounts with a known password. That is a backdoor — the fact
       * that it exists for a good reason does not change what it is, and "seed data that
       * was only meant for local development" is a recurring entry in breach write-ups.
       *
       * The guard is on NODE_ENV rather than on a dedicated flag deliberately: a flag is
       * one more thing to set correctly, and the failure mode of forgetting it is that
       * the accounts get created. NODE_ENV is already set correctly in every environment
       * because everything else depends on it, so this piggybacks on a variable that is
       * load-bearing elsewhere and therefore actually maintained.
       *
       * The password comes from config rather than being a literal here, so a deployment
       * that genuinely wants demo accounts can set a real one.
       * ============================================================================
       */
      if (process.env.NODE_ENV === 'production') return;

      const password = process.env.SEED_DEMO_PASSWORD ?? 'demo-password-123';
      const passwordHash = await hashPassword(password);
      const now = Date.now();

      // `replaceOne` + upsert so re-running is a no-op on a database that already has
      // them — every migration in this file is idempotent, and this one especially needs
      // to be, because it is the one developers re-run after dropping their data.
      await db.collection('users').replaceOne(
        { _id: 'user-doctor-demo' as never },
        {
          email: 'doctor@clinic.test',
          passwordHash,
          role: 'doctor',
          profileId: 'doctor-1',
          createdAt: now,
        },
        { upsert: true },
      );

      await db.collection('users').replaceOne(
        { _id: 'user-patient-demo' as never },
        {
          email: 'patient@example.test',
          passwordHash,
          role: 'patient',
          profileId: 'patient-1',
          createdAt: now,
        },
        { upsert: true },
      );
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
