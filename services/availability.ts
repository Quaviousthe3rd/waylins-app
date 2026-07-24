import { Booking, StoreConfig, BookingStatus } from '../types';
import { format, parse, addMinutes, areIntervalsOverlapping, getDay } from 'date-fns';

// Pure slot-availability logic, extracted from api.ts so it can be unit
// tested (including under a mocked timezone). All date-string parsing goes
// through parseDay: new Date('yyyy-MM-dd') is interpreted as UTC MIDNIGHT,
// which west of UTC (e.g. America/Los_Angeles) is the PREVIOUS local day —
// wrong day-of-week, wrong opening hours. date-fns parse() interprets the
// string in LOCAL time, which is what the shop and its clients mean.
export const parseDay = (dateStr: string): Date =>
  parse(dateStr, 'yyyy-MM-dd', new Date());

export interface AvailabilityClaim {
  bookingId: string | null;
  status: 'held' | 'confirmed';
  expiresAt: Date | null;
}

export const computeAvailableSlots = (
  config: StoreConfig,
  allBookings: Booking[],
  claims: Map<string, AvailabilityClaim>,
  dateStr: string,
  durationMinutes: number,
  excludeBookingId?: string,
  nowMs: number = Date.now()
): string[] => {
  const dayOfWeek = getDay(parseDay(dateStr));
  const hours = config.weeklyHours[dayOfWeek];

  if (!hours || hours.isClosed) return [];

  // Whole-day blockout
  const isBlockedDay = (config.blockouts ?? []).some(b => {
    if (b.date !== dateStr) return false;
    return b.startTime <= hours.start && b.endTime >= hours.end;
  });
  if (isBlockedDay) return [];

  const [startH, startM] = hours.start.split(':').map(Number);
  const [endH, endM] = hours.end.split(':').map(Number);

  const slots: string[] = [];
  const dayStart = parseDay(dateStr);
  let current = new Date(dayStart);
  current.setHours(startH, startM, 0, 0);

  const endTime = new Date(dayStart);
  endTime.setHours(endH, endM, 0, 0);

  const dayBookings = allBookings.filter(b =>
    b.date === dateStr &&
    b.status !== BookingStatus.CANCELLED &&
    b.id !== excludeBookingId
  );
  const dayBlockouts = (config.blockouts ?? []).filter(b => b.date === dateStr);

  while (addMinutes(current, durationMinutes) <= endTime) {
    const slotStart = current;
    const slotEnd = addMinutes(current, durationMinutes);
    const slotStr = format(slotStart, 'HH:mm');

    const isOverlappingBooking = dayBookings.some(b => {
      const bStart = parse(b.timeSlot, 'HH:mm', dayStart);
      const bDuration = b.durationMinutes || 60;
      const bEnd = addMinutes(bStart, bDuration);
      return areIntervalsOverlapping({ start: slotStart, end: slotEnd }, { start: bStart, end: bEnd });
    });

    // Claimed cells (server-side slot reservations). A slot is blocked if
    // ANY 30-min cell it covers is confirmed, or held and not yet expired —
    // unless the claim belongs to the booking being rescheduled.
    const startMin = slotStart.getHours() * 60 + slotStart.getMinutes();
    const firstCell = Math.floor(startMin / 30);
    const lastCell = Math.ceil((startMin + durationMinutes) / 30);
    let isClaimed = false;
    for (let c = firstCell; c < lastCell; c++) {
      const m = c * 30;
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const claim = claims.get(`${dateStr}_${hh}:${mm}`);
      if (!claim) continue;
      if (excludeBookingId && claim.bookingId === excludeBookingId) continue;
      if (claim.status === 'confirmed' ||
          (claim.expiresAt !== null && claim.expiresAt.getTime() > nowMs)) {
        isClaimed = true;
        break;
      }
    }

    const isOverlappingBlockout = dayBlockouts.some(b => {
      const bStart = parse(b.startTime, 'HH:mm', dayStart);
      const bEnd = parse(b.endTime, 'HH:mm', dayStart);
      return areIntervalsOverlapping({ start: slotStart, end: slotEnd }, { start: bStart, end: bEnd });
    });

    if (!isOverlappingBooking && !isOverlappingBlockout && !isClaimed) {
      slots.push(slotStr);
    }

    current = addMinutes(current, 30);
  }

  return slots;
};
