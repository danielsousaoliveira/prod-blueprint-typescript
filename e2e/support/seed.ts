import { MongoClient } from 'mongodb';
import { DateTime } from 'luxon';
import { hashPassword } from '../../apps/api/src/modules/auth/domain/password';

/**
 * Seeds a doctor with a schedule, directly in MongoDB.
 *
 * ============================================================================
 * WHY UNIQUE DATA PER TEST RATHER THAN A SHARED FIXTURE
 * ============================================================================
 *
 * Every test creates its own doctor with a generated id. That costs a little setup per
 * test and buys three things:
 *
 *   1. Tests can run IN PARALLEL. With a shared doctor, one test booking 09:00 changes
 *      what another test sees, so the suite has to run serially — which is the usual
 *      reason e2e suites take twenty minutes.
 *   2. Failures stay LOCAL. A shared fixture means one failing test leaves the database
 *      in a state that fails the next three, and the real cause is buried in a cascade.
 *   3. Order independence is structural rather than a convention people remember.
 *
 * The cost is that debugging requires reading the test to know what data existed. Worth
 * it — a shared fixture is easier to read once and harder to trust forever.
 *
 * Seeding through the DATABASE rather than the API is deliberate too: setup should not
 * depend on the endpoints under test. If booking is broken, the test should fail on the
 * assertion about booking, not while arranging its fixtures.
 * ============================================================================
 */

const MONGO_URL =
  process.env.E2E_MONGO_URL ??
  'mongodb://localhost:27017/?replicaSet=rs0&directConnection=true';
const DB_NAME = process.env.E2E_MONGO_DB ?? 'scheduler_e2e';

export interface SeededDoctor {
  readonly doctorId: string;
  readonly patientId: string;
  readonly clinicZone: string;
  /** The weekday whose slots the test will book, as an ISO date. */
  readonly bookingDate: string;
  /** Sign-in credentials for the two parties, created alongside their profiles. */
  readonly doctorEmail: string;
  readonly patientEmail: string;
  readonly password: string;
}

/**
 * The password every seeded account shares.
 *
 * A constant, because these are throwaway accounts in a throwaway database and varying it
 * per test would buy nothing except slower runs — argon2 is deliberately expensive, and
 * each unique password is one more hash to compute at seed time.
 */
export const E2E_PASSWORD = 'e2e-password-123';

/**
 * The next WEEKDAY inside the window the app actually displays.
 *
 * This was a real bug in the first version, and an instructive one: the seed picked a
 * Tuesday at least seven days out, while the UI shows a rolling SEVEN-DAY window from
 * today. So the seeded slots were often outside the range the app requested, and a test
 * that "booked the first slot" was booking a completely different day from the one the
 * fixture had prepared — which surfaced as a conflict test where no conflict occurred.
 *
 * Now the rule covers every weekday and the target is TOMORROW (skipping the weekend),
 * so the fixture and the UI are guaranteed to agree. Tomorrow is also far enough out
 * that the 24-hour reminder window is not already open, which would change behaviour.
 */
function targetDay(): DateTime {
  let day = DateTime.utc().plus({ days: 1 }).startOf('day');
  // 6 = Saturday, 7 = Sunday.
  while (day.weekday > 5) day = day.plus({ days: 1 });
  return day;
}

export async function seedDoctor(label: string): Promise<SeededDoctor> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const doctorId = `doctor-${suffix}`;
  const patientId = `patient-${suffix}`;
  const clinicZone = 'Europe/Lisbon';

  const client = new MongoClient(MONGO_URL);
  await client.connect();

  try {
    const db = client.db(DB_NAME);

    await db.collection('availability_rules').replaceOne(
      { _id: doctorId as never },
      {
        timezone: clinicZone,
        slotDurationMinutes: 30,
        // EVERY weekday, so the seeded schedule always intersects the app's rolling
        // seven-day window regardless of which day the suite runs on.
        rules: [1, 2, 3, 4, 5].map((weekday) => ({
          id: `rule-${suffix}-${weekday}`,
          weekday,
          startTime: { hour: 9, minute: 0 },
          endTime: { hour: 13, minute: 0 },
          timezone: clinicZone,
        })),
      },
      { upsert: true },
    );

    await db
      .collection('doctors')
      .replaceOne(
        { _id: doctorId as never },
        { name: `Dr ${label}`, specialty: 'Cardiology', timezone: clinicZone },
        { upsert: true },
      );

    await db
      .collection('patients')
      .replaceOne(
        { _id: patientId as never },
        { name: `Patient ${label}`, timezone: 'America/New_York' },
        { upsert: true },
      );

    /**
     * ============================================================================
     * USER ACCOUNTS, HASHED THE SAME WAY THE APPLICATION HASHES THEM
     * ============================================================================
     *
     * Seeded directly into MongoDB, like everything else here — setup must not depend on
     * the endpoints under test. But the hash is produced by importing the APPLICATION's
     * `hashPassword`, not by writing an argon2 call here.
     *
     * That matters: a second, independent hashing call in the test harness is a second
     * definition of the password format. Change the parameters in the app and this file
     * keeps producing hashes in the old format — which still verify, so nothing fails,
     * and the e2e suite quietly stops exercising the real configuration. Importing the
     * real function means there is one definition and no way for them to drift.
     * ============================================================================
     */
    const passwordHash = await hashPassword(E2E_PASSWORD);
    const doctorEmail = `${doctorId}@e2e.test`;
    const patientEmail = `${patientId}@e2e.test`;

    await db.collection('users').replaceOne(
      { _id: `user-${doctorId}` as never },
      {
        email: doctorEmail,
        passwordHash,
        role: 'doctor',
        profileId: doctorId,
        createdAt: Date.now(),
      },
      { upsert: true },
    );

    await db.collection('users').replaceOne(
      { _id: `user-${patientId}` as never },
      {
        email: patientEmail,
        passwordHash,
        role: 'patient',
        profileId: patientId,
        createdAt: Date.now(),
      },
      { upsert: true },
    );

    return {
      doctorId,
      patientId,
      clinicZone,
      bookingDate: targetDay().toISODate() ?? '',
      doctorEmail,
      patientEmail,
      password: E2E_PASSWORD,
    };
  } finally {
    await client.close();
  }
}

/** Read back what the API stored — used to assert on state the UI does not display. */
export async function findAppointments(
  doctorId: string,
): Promise<{ _id: string; status: string; startsAt: Date }[]> {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  try {
    return (await client
      .db(DB_NAME)
      .collection('appointments')
      .find({ doctorId })
      .sort({ startsAt: 1 })
      .toArray()) as unknown as { _id: string; status: string; startsAt: Date }[];
  } finally {
    await client.close();
  }
}
