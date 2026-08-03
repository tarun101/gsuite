// Pure helpers for aggregating Google Calendar free/busy across every calendar
// visible to one account, extracted so the interval math and per-calendar error
// handling can be unit-tested without any live Google calls. No runtime deps.
//
// The core invariant: a busy interval on ANY included calendar makes that slot
// busy, and a calendar we could not read is reported as an error rather than
// silently treated as free — so "available" never hides an inaccessible calendar.

export interface Interval {
  start: string; // RFC 3339
  end: string; // RFC 3339
}

/** One calendar's entry in a freebusy.query response. */
export interface CalendarFreeBusy {
  busy?: Array<{ start?: string | null; end?: string | null }>;
  errors?: Array<{ domain?: string | null; reason?: string | null }>;
}

export interface CalendarError {
  calendarId: string;
  errors: Array<{ domain?: string; reason?: string }>;
}

export interface AvailabilityResult {
  /** True if any busy interval overlaps the [timeMin, timeMax] window. */
  overallBusy: boolean;
  /** Merged, minimal busy intervals (original boundary strings preserved). */
  busy: Interval[];
  /** Free gaps inside the window (canonical ISO boundaries). */
  free: Interval[];
  /** Calendars that returned an error, surfaced instead of dropped. */
  calendarErrors: CalendarError[];
}

/** Merge overlapping or touching intervals into a minimal sorted set. */
export function mergeBusyIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals
    .filter((i) => i.start && i.end && new Date(i.start) < new Date(i.end))
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const merged: Interval[] = [];
  for (const cur of valid) {
    const last = merged[merged.length - 1];
    // `<=` folds in both overlaps and back-to-back (adjacent) intervals.
    if (last && new Date(cur.start) <= new Date(last.end)) {
      if (new Date(cur.end) > new Date(last.end)) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Compute free gaps inside [timeMin, timeMax] given already-merged busy intervals. */
export function computeFreeGaps(timeMin: string, timeMax: string, mergedBusy: Interval[]): Interval[] {
  const windowEnd = new Date(timeMax);
  const free: Interval[] = [];
  let cursor = new Date(timeMin);

  for (const b of mergedBusy) {
    const bStart = new Date(b.start);
    const bEnd = new Date(b.end);
    if (bEnd <= cursor || bStart >= windowEnd) continue; // fully outside the window
    if (bStart > cursor) {
      const gapEnd = bStart < windowEnd ? bStart : windowEnd;
      free.push({ start: cursor.toISOString(), end: gapEnd.toISOString() });
    }
    if (bEnd > cursor) cursor = bEnd < windowEnd ? bEnd : windowEnd;
  }
  if (cursor < windowEnd) free.push({ start: cursor.toISOString(), end: windowEnd.toISOString() });
  return free;
}

/**
 * Aggregate a freebusy `calendars` map into one account-wide view. A busy
 * interval on any included calendar makes that slot busy; per-calendar errors
 * are surfaced explicitly so an inaccessible calendar never reads as "free".
 */
export function aggregateAvailability(
  timeMin: string,
  timeMax: string,
  calendars: Record<string, CalendarFreeBusy>
): AvailabilityResult {
  const allBusy: Interval[] = [];
  const calendarErrors: CalendarError[] = [];

  for (const [calendarId, data] of Object.entries(calendars ?? {})) {
    for (const b of data.busy ?? []) {
      if (b.start && b.end) allBusy.push({ start: b.start, end: b.end });
    }
    if (data.errors && data.errors.length > 0) {
      calendarErrors.push({
        calendarId,
        errors: data.errors.map((e) => ({
          domain: e.domain ?? undefined,
          reason: e.reason ?? undefined,
        })),
      });
    }
  }

  const busy = mergeBusyIntervals(allBusy);
  const free = computeFreeGaps(timeMin, timeMax, busy);
  const overallBusy = busy.some(
    (b) => new Date(b.end) > new Date(timeMin) && new Date(b.start) < new Date(timeMax)
  );
  return { overallBusy, busy, free, calendarErrors };
}

/** Split calendar ids into freebusy-query-sized batches (the API caps items at 50). */
export function chunkCalendarIds(ids: string[], size = 50): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
