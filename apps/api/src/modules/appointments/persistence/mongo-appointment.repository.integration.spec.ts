import type { Db } from 'mongodb';
import {
  APPOINTMENTS_COLLECTION,
  UNIQUE_ACTIVE_SLOT_INDEX,
  runMigrations,
} from '../../../persistence/migrations';
import { interval } from '../../../shared/intervals/interval';
import { SlotTakenError } from '../domain/appointment.repository';
import { type MongoHarness, startMongoHarness } from '../../../../test/mongo-harness';
import {
  T0,
  requestedAppointment,
  runAppointmentRepositoryContract,
} from './appointment-repository.contract';
import { MongoAppointmentRepository } from './mongo-appointment.repository';

/** Starting a container takes a while; well beyond Jest's 5s default. */
jest.setTimeout(180_000);

let harness: MongoHarness;

beforeAll(async () => {
  harness = await startMongoHarness();
});

afterAll(async () => {
  await harness?.stop();
});

beforeEach(async () => {
  await harness.reset();
});

/** The repository only needs `.db` from MongoService. */

// ---------------------------------------------------------------------------
// The same contract the in-memory adapter satisfies. If these two ever disagree,
// one of them is lying about how the system behaves.
// ---------------------------------------------------------------------------
runAppointmentRepositoryContract(
  'mongodb',
  () => new MongoAppointmentRepository(harness.mongoService),
);

// ---------------------------------------------------------------------------
// Properties that ONLY a real database can demonstrate. These deliberately have no
// in-memory counterpart — faking them would prove nothing.
// ---------------------------------------------------------------------------
describe('MongoDB-specific guarantees', () => {
  let repo: MongoAppointmentRepository;

  beforeEach(() => {
    repo = new MongoAppointmentRepository(harness.mongoService);
  });

  describe('migrations', () => {
    it('are idempotent — a second run applies nothing', async () => {
      // The deploy step gets retried. Re-running must be a no-op, not an error.
      const applied = await runMigrations(harness.db);
      expect(applied).toEqual([]);
    });

    it('created the partial unique index with the expected filter', async () => {
      const indexes = await harness.db.collection(APPOINTMENTS_COLLECTION).indexes();

      const unique = indexes.find((index) => index.name === UNIQUE_ACTIVE_SLOT_INDEX);
      expect(unique).toBeDefined();
      expect(unique?.unique).toBe(true);
      // Asserting the FILTER, not just the index's existence. A unique index without the
      // partial filter would pass a naive "does the index exist" check while making
      // cancelled slots permanently unbookable.
      expect(unique?.partialFilterExpression).toEqual({
        status: { $in: ['REQUESTED', 'COUNTER_PROPOSED', 'CONFIRMED'] },
      });
    });
  });

  describe('concurrency', () => {
    it('lets exactly ONE of many simultaneous bookings win', async () => {
      // The headline property. Ten genuinely concurrent inserts of the same slot, with
      // no coordination in application code whatsoever — the database decides.
      const attempts = Array.from({ length: 10 }, (_, i) =>
        repo.create(requestedAppointment({ id: `racer-${i}` })),
      );

      const results = await Promise.allSettled(attempts);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      // Every loser must get the domain error, not a raw driver error leaking upward.
      for (const failure of rejected) {
        expect(failure.reason).toBeInstanceOf(SlotTakenError);
      }

      // And the database really does hold exactly one.
      expect(await repo.find({ doctorId: 'doctor-1' })).toHaveLength(1);
    });

    it('WITHOUT the unique index, the same race double-books', async () => {
      // Breaking it on purpose. This is the test that makes the guarantee credible:
      // it demonstrates that the index — not any application logic — is what prevents
      // the double booking. Remove it and the identical code corrupts data.
      await harness.db
        .collection(APPOINTMENTS_COLLECTION)
        .dropIndex(UNIQUE_ACTIVE_SLOT_INDEX);

      try {
        const results = await Promise.allSettled(
          Array.from({ length: 10 }, (_, i) =>
            repo.create(requestedAppointment({ id: `unsafe-${i}` })),
          ),
        );

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
        // Ten appointments, one doctor, one slot. This is the bug the index prevents.
        expect(await repo.find({ doctorId: 'doctor-1' })).toHaveLength(10);
      } finally {
        // Restore it so later tests in this file are not affected.
        await runMigrationsRestoringIndex(harness.db);
      }
    });

    it('serialises concurrent transitions of the same appointment', async () => {
      // Compare-and-set under real concurrency: both requests read REQUESTED, both try
      // to write a different terminal state. Exactly one may win.
      const requested = requestedAppointment({ id: 'cas' });
      await repo.create(requested);

      const confirm = repo.update(
        {
          ...requested,
          status: 'CONFIRMED',
          confirmedSlot: requested.slot,
          confirmedAt: T0,
        } as never,
        'REQUESTED',
      );
      const decline = repo.update(
        {
          ...requested,
          status: 'DECLINED',
          declinedBy: 'doctor',
          declinedAt: T0,
        } as never,
        'REQUESTED',
      );

      const results = await Promise.allSettled([confirm, decline]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

      const stored = await repo.findById('cas');
      expect(['CONFIRMED', 'DECLINED']).toContain(stored?.status);
    });
  });

  describe('index usage', () => {
    it("uses an index for the doctor's calendar query — no collection scan", async () => {
      for (let i = 0; i < 50; i++) {
        await repo.create(
          requestedAppointment({
            id: `idx-${i}`,
            slot: interval(T0 + i * 3_600_000, T0 + (i + 1) * 3_600_000),
          }),
        );
      }

      const explain = (await harness.db
        .collection(APPOINTMENTS_COLLECTION)
        .find({
          doctorId: 'doctor-1',
          startsAt: { $gte: new Date(T0), $lt: new Date(T0 + 10 * 3_600_000) },
        })
        .sort({ startsAt: 1 })
        .explain('executionStats')) as ExplainResult;

      const stage = winningStage(explain);
      // A COLLSCAN here would mean the index is decorative. Asserting the stage is what
      // turns "I added an index" into "the query actually uses it".
      expect(stage).toBe('IXSCAN');

      const stats = explain.executionStats;
      expect(stats.nReturned).toBe(10);
      // Equality-sort-range ordering means we examine roughly what we return, rather
      // than scanning the whole collection and filtering afterwards.
      expect(stats.totalKeysExamined).toBeLessThanOrEqual(12);
      // And no in-memory sort stage: the index already provides the order.
      expect(JSON.stringify(explain.queryPlanner.winningPlan)).not.toContain('"SORT"');
    });
  });

  describe('aggregation', () => {
    it('buckets by ISO week using $dateTrunc, matching the in-memory adapter', async () => {
      await repo.create(requestedAppointment({ id: 'agg-1' }));
      await repo.create(
        requestedAppointment({
          id: 'agg-2',
          slot: interval(T0 + 7 * 86_400_000, T0 + 7 * 86_400_000 + 3_600_000),
        }),
      );

      const rows = await repo.statsByStatusPerWeek(
        interval(T0 - 86_400_000, T0 + 14 * 86_400_000),
      );

      expect(rows).toHaveLength(2);
      // Monday 00:00 UTC of each week.
      for (const row of rows) {
        expect(new Date(row.weekStart).getUTCDay()).toBe(1);
        expect(new Date(row.weekStart).getUTCHours()).toBe(0);
      }
    });
  });
});

// --- helpers -------------------------------------------------------------------

interface ExplainResult {
  queryPlanner: { winningPlan: Record<string, unknown> };
  executionStats: {
    nReturned: number;
    totalKeysExamined: number;
    totalDocsExamined: number;
  };
}

/** Walk to the leaf stage of the winning plan, whatever nesting the server used. */
function winningStage(explain: ExplainResult): string {
  let node = explain.queryPlanner.winningPlan;
  while (node.inputStage) {
    node = node.inputStage as Record<string, unknown>;
  }
  return node.stage as string;
}

async function runMigrationsRestoringIndex(db: Db): Promise<void> {
  // The migration record already exists, so `runMigrations` would skip it. Recreate the
  // index directly to restore the pre-test state.
  //
  // The documents MUST be cleared first. The test that just ran deliberately created ten
  // appointments in the same slot, and building a unique index over data that already
  // violates it fails — which is exactly what MongoDB should do, and is worth knowing:
  // you cannot retrofit a uniqueness constraint onto a collection that has already been
  // corrupted. In a real incident that is the hard part, not adding the index.
  await db.collection(APPOINTMENTS_COLLECTION).deleteMany({});

  await db.collection(APPOINTMENTS_COLLECTION).createIndex(
    { doctorId: 1, startsAt: 1 },
    {
      name: UNIQUE_ACTIVE_SLOT_INDEX,
      unique: true,
      partialFilterExpression: {
        status: { $in: ['REQUESTED', 'COUNTER_PROPOSED', 'CONFIRMED'] },
      },
    },
  );
}
