import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Appointment } from '../api/client';
import { AvailabilityCalendar, BookingFlow } from './AvailabilityCalendar';
import { DoctorInbox, PatientProposals } from './DoctorInbox';

/**
 * Component tests using ONLY roles and labels — never a CSS selector or a test id.
 *
 * Same constraint Phase 8's Playwright suite operates under, applied here so violations
 * surface now rather than as an unreachable element during e2e. It also means a test
 * breaks when the ACCESSIBLE NAME changes, which is a user-visible change, rather than
 * when a class name changes, which is a refactor.
 */

const LISBON = 'Europe/Lisbon';
const NEW_YORK = 'America/New_York';

const slots = [
  { startsAt: '2027-06-01T08:00:00.000Z', endsAt: '2027-06-01T08:30:00.000Z' },
  { startsAt: '2027-06-01T08:30:00.000Z', endsAt: '2027-06-01T09:00:00.000Z' },
];

const appointment = (overrides: Partial<Appointment> = {}): Appointment => ({
  id: 'appt-1',
  doctorId: 'doctor-1',
  patientId: 'patient-1',
  status: 'REQUESTED',
  startsAt: '2027-06-01T08:00:00.000Z',
  endsAt: '2027-06-01T08:30:00.000Z',
  requestedStartsAt: '2027-06-01T08:00:00.000Z',
  requestedEndsAt: '2027-06-01T08:30:00.000Z',
  proposedStartsAt: null,
  proposedEndsAt: null,
  createdAt: '2027-05-01T00:00:00.000Z',
  ...overrides,
});

describe('AvailabilityCalendar', () => {
  it('renders slots in the viewer timezone', () => {
    render(
      <AvailabilityCalendar
        slots={slots}
        clinicZone={LISBON}
        onBook={vi.fn()}
        viewerZone={NEW_YORK}
      />,
    );

    // 08:00Z is 04:00 in New York. The patient reads their own clock.
    expect(screen.getByRole('button', { name: /Book 04:00/ })).toBeInTheDocument();
  });

  it('shows the clinic time alongside when the zones differ', () => {
    render(
      <AvailabilityCalendar
        slots={slots}
        clinicZone={LISBON}
        onBook={vi.fn()}
        viewerZone={NEW_YORK}
      />,
    );

    // Both times are in the ACCESSIBLE NAME, so the information reaches a screen-reader
    // user who never sees the visual secondary label.
    expect(
      screen.getByRole('button', { name: /Book 04:00.*09:00 clinic time/ }),
    ).toBeInTheDocument();

    // And the banner states the rule once, prominently.
    expect(screen.getByRole('status')).toHaveTextContent(/your timezone/i);
  });

  it('does NOT show a redundant clinic time when the zones agree', () => {
    render(
      <AvailabilityCalendar
        slots={slots}
        clinicZone={LISBON}
        onBook={vi.fn()}
        viewerZone={LISBON}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Book 09:00 on Tuesday 1 June' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('groups slots under a day heading', () => {
    render(
      <AvailabilityCalendar
        slots={slots}
        clinicZone={LISBON}
        onBook={vi.fn()}
        viewerZone={LISBON}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Tuesday 1 June' })).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: /Available times on Tuesday 1 June/ }),
    ).toBeInTheDocument();
  });

  it('announces a lost slot with role=alert and invites a retry', () => {
    // The 409 case. It must be ANNOUNCED, not merely displayed — losing a slot is exactly
    // when a silent failure is unacceptable.
    render(
      <AvailabilityCalendar
        slots={slots}
        clinicZone={LISBON}
        onBook={vi.fn()}
        viewerZone={LISBON}
        error={
          new ApiError({
            type: 'https://tenantforge.example/problems/slot-taken',
            title: 'Slot already taken',
            status: 409,
          })
        }
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/just taken/i);
    // The remaining slots are still offered, so the user can pick another immediately.
    expect(screen.getAllByRole('button', { name: /^Book/ })).toHaveLength(2);
  });

  it('shows a generic message for a non-conflict error', () => {
    render(
      <AvailabilityCalendar
        slots={slots}
        clinicZone={LISBON}
        onBook={vi.fn()}
        viewerZone={LISBON}
        error={
          new ApiError({ type: 'about:blank', title: 'Something broke', status: 500 })
        }
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');
  });

  it('tells the user plainly when there is nothing available', () => {
    render(<AvailabilityCalendar slots={[]} clinicZone={LISBON} onBook={vi.fn()} />);

    expect(screen.getByText(/No appointments available/)).toBeInTheDocument();
  });
});

describe('BookingFlow', () => {
  it('requires confirmation before booking', async () => {
    // Booking is not trivially reversible — it notifies a doctor — so a mis-tap should
    // not create an appointment someone has to cancel.
    const onConfirm = vi.fn();
    const user = userEvent.setup();

    render(
      <BookingFlow
        slots={slots}
        clinicZone={LISBON}
        onConfirm={onConfirm}
        isPending={false}
        viewerZone={LISBON}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Book 09:00/ }));

    // Nothing submitted yet.
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      screen.getByRole('dialog', { name: /Confirm your appointment/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(onConfirm).toHaveBeenCalledWith(slots[0]);
  });

  it('shows both times in the confirmation when zones differ', async () => {
    const user = userEvent.setup();

    render(
      <BookingFlow
        slots={slots}
        clinicZone={LISBON}
        onConfirm={vi.fn()}
        isPending={false}
        viewerZone={NEW_YORK}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Book 04:00/ }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('04:00');
    expect(dialog).toHaveTextContent('09:00');
    expect(dialog).toHaveTextContent(LISBON);
  });

  it('lets the user back out without booking', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();

    render(
      <BookingFlow
        slots={slots}
        clinicZone={LISBON}
        onConfirm={onConfirm}
        isPending={false}
        viewerZone={LISBON}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Book 09:00/ }));
    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('CLOSES the dialog once the booking succeeds', async () => {
    // Regression test. The original implementation left the confirmation dialog open on
    // top of the updated calendar after a successful booking — found by driving the real
    // UI in a browser, not by any test, because every existing test booked exactly once
    // and never observed the success transition.
    const user = userEvent.setup();

    const { rerender } = render(
      <BookingFlow
        slots={slots}
        clinicZone={LISBON}
        onConfirm={vi.fn()}
        isPending={false}
        viewerZone={LISBON}
        successCount={0}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Book 09:00/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    rerender(
      <BookingFlow
        slots={slots}
        clinicZone={LISBON}
        onConfirm={vi.fn()}
        isPending={false}
        viewerZone={LISBON}
        successCount={1}
      />,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog OPEN when the booking fails', async () => {
    // The 409 case must not dismiss: the user needs to stay and choose another slot.
    const user = userEvent.setup();

    const { rerender } = render(
      <BookingFlow
        slots={slots}
        clinicZone={LISBON}
        onConfirm={vi.fn()}
        isPending={false}
        viewerZone={LISBON}
        successCount={0}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Book 09:00/ }));

    rerender(
      <BookingFlow
        slots={slots}
        clinicZone={LISBON}
        onConfirm={vi.fn()}
        isPending={false}
        viewerZone={LISBON}
        successCount={0}
        error={
          new ApiError({
            type: 'https://tenantforge.example/problems/slot-taken',
            title: 'Slot already taken',
            status: 409,
          })
        }
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/just taken/i);
  });

  it('disables the confirm button while the request is in flight', async () => {
    // No optimistic update: a pending state, because the booking can still lose the race.
    const user = userEvent.setup();

    const { rerender } = render(
      <BookingFlow
        slots={slots}
        clinicZone={LISBON}
        onConfirm={vi.fn()}
        isPending={false}
        viewerZone={LISBON}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Book 09:00/ }));

    rerender(
      <BookingFlow
        slots={slots}
        clinicZone={LISBON}
        onConfirm={vi.fn()}
        isPending
        viewerZone={LISBON}
      />,
    );

    expect(screen.getByRole('button', { name: 'Requesting…' })).toBeDisabled();
  });
});

describe('DoctorInbox', () => {
  it('separates pending, awaiting-patient and confirmed', () => {
    render(
      <DoctorInbox
        appointments={[
          appointment({ id: 'a1', status: 'REQUESTED' }),
          appointment({
            id: 'a2',
            status: 'COUNTER_PROPOSED',
            proposedStartsAt: '2027-06-01T09:00:00.000Z',
          }),
          appointment({ id: 'a3', status: 'CONFIRMED' }),
        ]}
        clinicZone={LISBON}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
        onPropose={vi.fn()}
        viewerZone={LISBON}
      />,
    );

    expect(
      screen.getByRole('heading', { name: /Awaiting your response \(1\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Awaiting patient \(1\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Confirmed \(1\)/ })).toBeInTheDocument();
  });

  it('gives each action an UNAMBIGUOUS accessible name', () => {
    // Two requests means two "Accept" buttons. Without the time in the name, Playwright's
    // strict mode fails on the ambiguity and a screen-reader user cannot tell them apart.
    render(
      <DoctorInbox
        appointments={[
          appointment({ id: 'a1', startsAt: '2027-06-01T08:00:00.000Z' }),
          appointment({ id: 'a2', startsAt: '2027-06-01T08:30:00.000Z' }),
        ]}
        clinicZone={LISBON}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
        onPropose={vi.fn()}
        viewerZone={LISBON}
      />,
    );

    expect(
      screen.getByRole('button', { name: /Accept 09:00 request/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Accept 09:30 request/ }),
    ).toBeInTheDocument();
  });

  it('accepts a request', async () => {
    const onAccept = vi.fn();
    const user = userEvent.setup();

    render(
      <DoctorInbox
        appointments={[appointment()]}
        clinicZone={LISBON}
        onAccept={onAccept}
        onDecline={vi.fn()}
        onPropose={vi.fn()}
        viewerZone={LISBON}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Accept 09:00/ }));
    expect(onAccept).toHaveBeenCalledWith('appt-1');
  });

  it('proposes a new time through a labelled form field', async () => {
    const onPropose = vi.fn();
    const user = userEvent.setup();

    render(
      <DoctorInbox
        appointments={[appointment()]}
        clinicZone={LISBON}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
        onPropose={onPropose}
        viewerZone={LISBON}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Propose a new time/ }));

    // getByLabel — a real <label for>, not a placeholder pretending to be one.
    const input = screen.getByLabelText(/New time/);
    await user.type(input, '2027-06-01T11:00');
    await user.click(screen.getByRole('button', { name: 'Send proposal' }));

    expect(onPropose).toHaveBeenCalledTimes(1);
    const [id, slot] = onPropose.mock.calls[0] as [
      string,
      { startsAt: string; endsAt: string },
    ];
    expect(id).toBe('appt-1');
    // The client does not invent a duration rule — 30 minutes, matching the grid the
    // server enforces.
    expect(new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()).toBe(
      30 * 60_000,
    );
  });

  it('says so plainly when the inbox is empty', () => {
    render(
      <DoctorInbox
        appointments={[]}
        clinicZone={LISBON}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
        onPropose={vi.fn()}
      />,
    );

    expect(screen.getByText('No new requests.')).toBeInTheDocument();
  });
});

describe('PatientProposals', () => {
  it('shows BOTH what was asked for and what was proposed', () => {
    // Showing only the proposal leaves the patient unable to recall what they requested,
    // which matters most when the two times are close together.
    render(
      <PatientProposals
        appointments={[
          appointment({
            status: 'COUNTER_PROPOSED',
            requestedStartsAt: '2027-06-01T08:00:00.000Z',
            proposedStartsAt: '2027-06-01T10:00:00.000Z',
          }),
        ]}
        clinicZone={LISBON}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
        viewerZone={LISBON}
      />,
    );

    const list = screen.getByRole('list', { name: /Proposed alternative times/ });
    expect(list).toHaveTextContent('You asked for');
    expect(list).toHaveTextContent('09:00');
    expect(list).toHaveTextContent('11:00');
  });

  it('renders nothing when there are no proposals', () => {
    const { container } = render(
      <PatientProposals
        appointments={[appointment({ status: 'REQUESTED' })]}
        clinicZone={LISBON}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('accepts and declines a proposal', async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const user = userEvent.setup();

    render(
      <PatientProposals
        appointments={[
          appointment({
            status: 'COUNTER_PROPOSED',
            proposedStartsAt: '2027-06-01T10:00:00.000Z',
          }),
        ]}
        clinicZone={LISBON}
        onAccept={onAccept}
        onDecline={onDecline}
        viewerZone={LISBON}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Accept the proposed time/ }));
    expect(onAccept).toHaveBeenCalledWith('appt-1');

    await user.click(screen.getByRole('button', { name: /Decline the proposed time/ }));
    expect(onDecline).toHaveBeenCalledWith('appt-1');
  });
});
