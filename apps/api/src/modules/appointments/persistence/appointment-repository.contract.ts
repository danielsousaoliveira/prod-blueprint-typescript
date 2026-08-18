import { interval } from '../../../shared/intervals/interval';
import type { Appointment } from '../domain/appointment';
import {
  AppointmentNotFoundError,
  type AppointmentRepository,
  SlotTakenError,
} from '../domain/appointment.repository';

/**
 * The repository contract, as an executable specification.
 *
 * This suite is run against BOTH adapters — MongoDB via Testcontainers, and the in-memory
 * fake. That is the entire mechanism preventing the fake from becoming a more forgiving
 * version of reality, which is the standard failure mode of hand-written test doubles:
 * the fake forgets a constraint, unit tests stay green, and production disagrees.
 *
 * Anything asserted here must hold for every adapter. Behaviour that genuinely cannot be
 * reproduced in memory — real concurrent writes, index selection, `explain()` output —
 * lives in the MongoDB-only integration spec instead, and is labelled as such.
 */

const HOUR = 3_600_000;
export const T0 = Date.UTC(2026, 5, 2, 9, 0);

export function requestedAppointment(
  overrides: Partial<Appointment> & { id: string },
): Appointment {
  return {
    doctorId: 'doctor-1',
    patientId: 'patient-1',
    slot: interval(T0, T0 + HOUR),
    createdAt: T0 - HOUR,
    status: 'REQUESTED',
    ...overrides,
  } as Appointment;
}

export function runAppointmentRepositoryContract(
  adapterName: string,
  getRepository: () => AppointmentRepository,
): void {
  describe(`AppointmentRepository contract [${adapterName}]`, () => {
    let repo: AppointmentRepository;

    beforeEach(() => {
      repo = getRepository();
    });

    describe('create and read', () => {
      it('round-trips an appointment through the mapper unchanged', async () => {
        const appointment = requestedAppointment({ id: 'a1' });
        await repo.create(appointment);

        // Equality of the whole domain object, not a field-by-field spot check — this is
        // what catches a mapper that quietly drops a field.
        expect(await repo.findById('a1')).toEqual(appointment);
      });

      it('returns null for an unknown id', async () => {
        expect(await repo.findById('nope')).toBeNull();
      });

      it('round-trips every status variant', async () => {
        // Each union member has different required fields; a mapper bug usually shows up
        // in exactly one of them.
        const variants: Appointment[] = [
          requestedAppointment({ id: 'v-requested' }),
          {
            ...requestedAppointment({ id: 'v-counter' }),
            status: 'COUNTER_PROPOSED',
            proposedSlot: interval(T0 + 2 * HOUR, T0 + 3 * HOUR),
            proposedAt: T0,
          },
          {
            ...requestedAppointment({ id: 'v-confirmed' }),
            status: 'CONFIRMED',
            confirmedSlot: interval(T0, T0 + HOUR),
            confirmedAt: T0,
          },
          {
            ...requestedAppointment({ id: 'v-declined' }),
            status: 'DECLINED',
            declinedBy: 'doctor',
            declinedAt: T0,
          },
          {
            ...requestedAppointment({ id: 'v-cancelled' }),
            status: 'CANCELLED',
            cancelledBy: 'patient',
            cancelledAt: T0,
            reason: 'feeling better',
          },
          {
            ...requestedAppointment({ id: 'v-completed' }),
            status: 'COMPLETED',
            confirmedSlot: interval(T0, T0 + HOUR),
            completedAt: T0 + HOUR,
          },
        ];

        for (const variant of variants) {
          // Distinct doctors so the unique constraint does not interfere.
          const isolated = { ...variant, doctorId: `doctor-${variant.id}` };
          await repo.create(isolated);
          expect(await repo.findById(variant.id)).toEqual(isolated);
        }
      });

      it('omits an absent cancellation reason rather than storing undefined', async () => {
        const cancelled = {
          ...requestedAppointment({ id: 'no-reason' }),
          status: 'CANCELLED',
          cancelledBy: 'patient',
          cancelledAt: T0,
        } as Appointment;

        await repo.create(cancelled);
        const loaded = await repo.findById('no-reason');
        expect(loaded && 'reason' in loaded).toBe(false);
      });
    });

    describe('the slot uniqueness constraint', () => {
      it('rejects a second ACTIVE appointment in the same slot', async () => {
        await repo.create(requestedAppointment({ id: 'first' }));
        await expect(
          repo.create(requestedAppointment({ id: 'second' })),
        ).rejects.toBeInstanceOf(SlotTakenError);
      });

      it('allows the same slot for a DIFFERENT doctor', async () => {
        await repo.create(requestedAppointment({ id: 'first' }));
        await expect(
          repo.create(requestedAppointment({ id: 'other-doc', doctorId: 'doctor-2' })),
        ).resolves.toBeDefined();
      });

      it('RELEASES the slot once the appointment reaches a terminal state', async () => {
        // The single most important property of the partial filter. Without it, one
        // cancellation would burn that slot permanently and it could never be rebooked.
        const first = requestedAppointment({ id: 'first' });
        await repo.create(first);

        const cancelled = {
          ...first,
          status: 'CANCELLED',
          cancelledBy: 'patient',
          cancelledAt: T0,
        } as Appointment;
        await repo.update(cancelled, 'REQUESTED');

        await expect(
          repo.create(requestedAppointment({ id: 'rebooked' })),
        ).resolves.toBeDefined();
      });

      it('does not constrain appointments that are already terminal', async () => {
        const declined = {
          ...requestedAppointment({ id: 'd1' }),
          status: 'DECLINED',
          declinedBy: 'doctor',
          declinedAt: T0,
        } as Appointment;
        const alsoDeclined = { ...declined, id: 'd2' };

        await repo.create(declined);
        // Two declined appointments may share a slot — neither holds it.
        await expect(repo.create(alsoDeclined)).resolves.toBeDefined();
      });
    });

    describe('update as compare-and-set', () => {
      it('applies a transition when the expected status matches', async () => {
        const requested = requestedAppointment({ id: 'a1' });
        await repo.create(requested);

        const confirmed = {
          ...requested,
          status: 'CONFIRMED',
          confirmedSlot: requested.slot,
          confirmedAt: T0,
        } as Appointment;

        await repo.update(confirmed, 'REQUESTED');
        expect((await repo.findById('a1'))?.status).toBe('CONFIRMED');
      });

      it('rejects when the stored status has already moved on', async () => {
        // The lost-update guard: two requests both read REQUESTED, both try to write.
        // The second must not silently overwrite the first.
        const requested = requestedAppointment({ id: 'a1' });
        await repo.create(requested);

        const confirmed = {
          ...requested,
          status: 'CONFIRMED',
          confirmedSlot: requested.slot,
          confirmedAt: T0,
        } as Appointment;
        await repo.update(confirmed, 'REQUESTED');

        const declined = {
          ...requested,
          status: 'DECLINED',
          declinedBy: 'doctor',
          declinedAt: T0,
        } as Appointment;

        await expect(repo.update(declined, 'REQUESTED')).rejects.toBeInstanceOf(
          SlotTakenError,
        );
        expect((await repo.findById('a1'))?.status).toBe('CONFIRMED');
      });

      it('reports a missing appointment distinctly from a conflict', async () => {
        await expect(
          repo.update(requestedAppointment({ id: 'ghost' }), 'REQUESTED'),
        ).rejects.toBeInstanceOf(AppointmentNotFoundError);
      });

      it('moves the held slot when a counter-proposal is accepted', async () => {
        const requested = requestedAppointment({ id: 'a1' });
        await repo.create(requested);

        const proposedSlot = interval(T0 + 2 * HOUR, T0 + 3 * HOUR);
        const counter = {
          ...requested,
          status: 'COUNTER_PROPOSED',
          proposedSlot,
          proposedAt: T0,
        } as Appointment;
        await repo.update(counter, 'REQUESTED');

        const accepted = {
          ...requested,
          status: 'CONFIRMED',
          confirmedSlot: proposedSlot,
          confirmedAt: T0,
        } as Appointment;
        await repo.update(accepted, 'COUNTER_PROPOSED');

        // The original slot is now free...
        await expect(
          repo.create(requestedAppointment({ id: 'takes-original' })),
        ).resolves.toBeDefined();
        // ...and the proposed slot is held.
        await expect(
          repo.create(requestedAppointment({ id: 'wants-proposed', slot: proposedSlot })),
        ).rejects.toBeInstanceOf(SlotTakenError);
      });

      it('REJECTS accepting a counter-proposal whose slot was taken meanwhile', async () => {
        // The counter-proposal race. The proposed slot is not reserved while the patient
        // decides, so someone else can book it — and the guarantee must still hold at the
        // moment of acceptance. This is the behaviour design rationale documents as the known
        // limit of a single-field unique index.
        const requested = requestedAppointment({ id: 'a1' });
        await repo.create(requested);

        const proposedSlot = interval(T0 + 2 * HOUR, T0 + 3 * HOUR);
        await repo.update(
          {
            ...requested,
            status: 'COUNTER_PROPOSED',
            proposedSlot,
            proposedAt: T0,
          },
          'REQUESTED',
        );

        // Another patient takes the proposed slot first.
        await repo.create(requestedAppointment({ id: 'interloper', slot: proposedSlot }));

        await expect(
          repo.update(
            {
              ...requested,
              status: 'CONFIRMED',
              confirmedSlot: proposedSlot,
              confirmedAt: T0,
            },
            'COUNTER_PROPOSED',
          ),
        ).rejects.toBeInstanceOf(SlotTakenError);
      });
    });

    describe('find', () => {
      beforeEach(async () => {
        await repo.create(requestedAppointment({ id: 'd1-p1', doctorId: 'doctor-1' }));
        await repo.create(
          requestedAppointment({
            id: 'd2-p1',
            doctorId: 'doctor-2',
            slot: interval(T0 + HOUR, T0 + 2 * HOUR),
          }),
        );
        await repo.create(
          requestedAppointment({
            id: 'd1-p2',
            doctorId: 'doctor-1',
            patientId: 'patient-2',
            slot: interval(T0 + 3 * HOUR, T0 + 4 * HOUR),
          }),
        );
      });

      it('filters by doctor', async () => {
        const found = await repo.find({ doctorId: 'doctor-1' });
        expect(found.map((a) => a.id).sort()).toEqual(['d1-p1', 'd1-p2']);
      });

      it('filters by patient', async () => {
        const found = await repo.find({ patientId: 'patient-2' });
        expect(found.map((a) => a.id)).toEqual(['d1-p2']);
      });

      it('filters by status', async () => {
        expect(await repo.find({ statuses: ['CONFIRMED'] })).toEqual([]);
        expect(await repo.find({ statuses: ['REQUESTED'] })).toHaveLength(3);
      });

      it('filters by overlapping window, half-open at both ends', async () => {
        // A window ending exactly when an appointment starts must NOT match it.
        const found = await repo.find({
          within: interval(T0 - HOUR, T0),
        });
        expect(found).toEqual([]);

        const overlapping = await repo.find({ within: interval(T0, T0 + HOUR) });
        expect(overlapping.map((a) => a.id)).toEqual(['d1-p1']);
      });

      it('returns results sorted by start time', async () => {
        const found = await repo.find({});
        const starts = found.map((a) => a.slot.start);
        expect([...starts].sort((x, y) => x - y)).toEqual(starts);
      });
    });

    describe('statsByStatusPerWeek', () => {
      it('groups by doctor, ISO week and status', async () => {
        await repo.create(requestedAppointment({ id: 's1' }));
        await repo.create(
          requestedAppointment({ id: 's2', slot: interval(T0 + HOUR, T0 + 2 * HOUR) }),
        );
        await repo.create(
          requestedAppointment({
            id: 's3',
            doctorId: 'doctor-2',
            slot: interval(T0, T0 + HOUR),
          }),
        );

        const rows = await repo.statsByStatusPerWeek(
          interval(T0 - 7 * 86_400_000, T0 + 7 * 86_400_000),
        );

        const doctorOne = rows.find(
          (r) => r.doctorId === 'doctor-1' && r.status === 'REQUESTED',
        );
        expect(doctorOne?.count).toBe(2);
        expect(
          rows.find((r) => r.doctorId === 'doctor-2' && r.status === 'REQUESTED')?.count,
        ).toBe(1);
      });

      it('splits counts across an ISO week boundary', async () => {
        // 2026-06-02 is a Tuesday; adding 7 days lands in the following ISO week.
        await repo.create(requestedAppointment({ id: 'w1' }));
        await repo.create(
          requestedAppointment({
            id: 'w2',
            slot: interval(T0 + 7 * 86_400_000, T0 + 7 * 86_400_000 + HOUR),
          }),
        );

        const rows = await repo.statsByStatusPerWeek(
          interval(T0 - 86_400_000, T0 + 14 * 86_400_000),
        );
        const weeks = new Set(rows.map((r) => r.weekStart));
        expect(weeks.size).toBe(2);
        expect(rows.every((r) => r.count === 1)).toBe(true);
      });

      it('excludes appointments outside the range', async () => {
        await repo.create(requestedAppointment({ id: 'far-future' }));
        const rows = await repo.statsByStatusPerWeek(
          interval(T0 + 30 * 86_400_000, T0 + 60 * 86_400_000),
        );
        expect(rows).toEqual([]);
      });
    });
  });
}
