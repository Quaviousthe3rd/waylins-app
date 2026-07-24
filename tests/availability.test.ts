import { describe, it, expect } from 'vitest';
import { getDay } from 'date-fns';
import { computeAvailableSlots, parseDay } from '../services/availability';
import { StoreConfig, BookingStatus, Booking, PaymentStatus, PaymentMethod } from '../types';

// The whole suite runs under TZ=America/Los_Angeles (vitest.config.ts) —
// WEST of UTC, where naive new Date('yyyy-MM-dd') lands on the PREVIOUS
// local day. South Africa (UTC+2) never catches that bug locally; this
// timezone does.

const config: StoreConfig = {
  services: [],
  weeklyHours: {
    0: { start: '09:00', end: '15:00', isClosed: false },
    1: { start: '09:00', end: '18:00', isClosed: false },
    2: { start: '09:00', end: '18:00', isClosed: false },
    3: { start: '00:00', end: '00:00', isClosed: true }, // Wednesday closed
    4: { start: '09:00', end: '18:00', isClosed: false },
    5: { start: '09:00', end: '18:00', isClosed: false },
    6: { start: '09:00', end: '18:00', isClosed: false },
  },
  blockouts: [],
};

const booking = (date: string, timeSlot: string, durationMinutes: number): Booking => ({
  id: `bk-${date}-${timeSlot}`,
  clientName: 'T', clientPhone: '0810000000',
  date, timeSlot, serviceId: 's', serviceName: 'Cut',
  durationMinutes, amount: 235, depositAmount: 235,
  paymentMethod: PaymentMethod.ONLINE, paymentStatus: PaymentStatus.PAID,
  status: BookingStatus.CONFIRMED, createdAt: new Date().toISOString(),
});

describe('timezone safety (running under America/Los_Angeles)', () => {
  it('parseDay lands on the LOCAL day: 2026-07-29 is a Wednesday everywhere', () => {
    // 2026-07-29 is a Wednesday. Naive new Date() parsing would make it
    // Tuesday in LA (UTC midnight = 17:00 previous day locally).
    expect(getDay(parseDay('2026-07-29'))).toBe(3);
    expect(getDay(parseDay('2026-07-27'))).toBe(1); // Monday
  });

  it('the Wednesday closure applies to the actual Wednesday, not the day after', () => {
    // Closed on the real Wednesday...
    expect(computeAvailableSlots(config, [], new Map(), '2026-07-29', 60)).toEqual([]);
    // ...and open on Thursday (naive parsing would have shifted the closure here).
    expect(computeAvailableSlots(config, [], new Map(), '2026-07-30', 60).length).toBeGreaterThan(0);
  });

  it('first slot of a Monday is 09:00 (correct weekday hours picked)', () => {
    const slots = computeAvailableSlots(config, [], new Map(), '2026-07-27', 30);
    expect(slots[0]).toBe('09:00');
  });
});

describe('60-minute service on the 30-minute grid', () => {
  it('a 60-min booking at 10:00 blocks every start that overlaps EITHER half', () => {
    const slots = computeAvailableSlots(
      config,
      [booking('2026-07-27', '10:00', 60)],
      new Map(),
      '2026-07-27',
      60
    );
    // 09:30 would overlap the first half, 10:30 the second half.
    expect(slots).not.toContain('09:30');
    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30');
    // Touching end-to-start is NOT an overlap.
    expect(slots).toContain('09:00');
    expect(slots).toContain('11:00');
  });

  it('a confirmed slot CLAIM on either covered cell blocks a 60-min service', () => {
    const claims = new Map([
      ['2026-07-27_10:30', { bookingId: 'other', status: 'confirmed' as const, expiresAt: null }],
    ]);
    const slots = computeAvailableSlots(config, [], claims, '2026-07-27', 60);
    // A 60-min service starting 10:00 covers 10:00 AND 10:30 — the 10:30
    // claim must block it (the classic second-half trap).
    expect(slots).not.toContain('10:00');
    expect(slots).not.toContain('10:30');
    expect(slots).toContain('09:30');
    expect(slots).toContain('11:00');
  });

  it('last 60-min start on a Monday is 17:00 (fits exactly to 18:00 close)', () => {
    const slots = computeAvailableSlots(config, [], new Map(), '2026-07-27', 60);
    expect(slots[slots.length - 1]).toBe('17:00');
  });
});
