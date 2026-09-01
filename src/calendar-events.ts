// Pure helpers for calendar event free/busy transparency and RFC 5545 recurrence,
// extracted so validation and response shaping can be unit-tested without any
// live Google calls. This module intentionally has no runtime dependencies.

export type EventTransparency = 'opaque' | 'transparent';

/** Google omits `transparency` when an event blocks time, so absence means busy. */
export const DEFAULT_TRANSPARENCY: EventTransparency = 'opaque';

/**
 * RFC 5545 properties the Calendar API accepts in `event.recurrence`. DTSTART and
 * DTEND are deliberately excluded: Google derives them from start/end and rejects
 * the request when they appear here.
 */
export const RECURRENCE_PROPERTIES = ['RRULE', 'EXRULE', 'RDATE', 'EXDATE'] as const;

const PROPERTY_PATTERN = /^([A-Za-z-]+)\s*(;|:)/;

/**
 * Validate and normalize recurrence lines before they reach Google.
 *
 * Returns `undefined` when nothing was supplied (leave the event as-is) and `[]`
 * when an empty array was supplied, which the Calendar API treats as an explicit
 * request to strip recurrence and turn a series back into a single event.
 */
export function normalizeRecurrence(lines: string[] | undefined): string[] | undefined {
  if (lines === undefined) return undefined;
  if (lines.length === 0) return [];

  return lines.map((raw, index) => {
    const line = typeof raw === 'string' ? raw.trim() : '';
    const where = `recurrence[${index}]`;
    if (!line) throw new Error(`${where} is empty; supply an RFC 5545 line such as "RRULE:FREQ=WEEKLY;BYDAY=TU".`);
    if (/[\r\n]/.test(line)) throw new Error(`${where} must be a single line; pass one array entry per recurrence property.`);

    const match = line.match(PROPERTY_PATTERN);
    if (!match) {
      throw new Error(
        `${where} must start with an RFC 5545 property, for example "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270630T035959Z".`
      );
    }

    const property = match[1].toUpperCase();
    if (property === 'DTSTART' || property === 'DTEND') {
      throw new Error(
        `${where} may not set ${property}; the event start and end define it. Pass only RRULE, EXRULE, RDATE, or EXDATE lines.`
      );
    }
    if (!(RECURRENCE_PROPERTIES as readonly string[]).includes(property)) {
      throw new Error(`${where} uses unsupported property "${property}"; expected one of ${RECURRENCE_PROPERTIES.join(', ')}.`);
    }

    const value = line.slice(line.indexOf(':') + 1).trim();
    if (line.indexOf(':') === -1 || !value) {
      throw new Error(`${where} has no value after ":", for example "RRULE:FREQ=WEEKLY".`);
    }

    // Normalize only the property name; parameters and values stay verbatim so
    // TZID casing and rule values survive the round trip untouched.
    return property + line.slice(match[1].length);
  });
}

/** All-day values are bare calendar dates; timed values carry a clock time. */
export function isAllDayValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Google requires an IANA time zone (not just a UTC offset) on the start of a
 * TIMED recurring event, because the offset alone cannot say how later
 * occurrences should behave across a DST boundary. All-day series and
 * non-recurring events do not need one.
 */
export function needsRecurrenceTimeZone(startValue: string, recurrence: string[] | undefined): boolean {
  return Boolean(recurrence && recurrence.length > 0) && !isAllDayValue(startValue);
}

export interface CalendarEventLike {
  id?: string | null;
  status?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: unknown;
  end?: unknown;
  attendees?: unknown;
  htmlLink?: string | null;
  transparency?: string | null;
  recurrence?: string[] | null;
  recurringEventId?: string | null;
}

/**
 * Shape one event for a tool response. `transparency` is always present and
 * defaulted, so a reader never has to infer "busy" from a missing field, and
 * `recurrence` is surfaced whenever the event carries the master rules.
 */
export function shapeEvent(event: CalendarEventLike) {
  const transparency = event.transparency === 'transparent' ? 'transparent' : DEFAULT_TRANSPARENCY;
  return {
    id: event.id,
    status: event.status,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: event.start,
    end: event.end,
    attendees: event.attendees,
    htmlLink: event.htmlLink,
    transparency,
    busy: transparency === 'opaque',
    ...(event.recurrence && event.recurrence.length > 0 ? { recurrence: event.recurrence } : {}),
    recurringEventId: event.recurringEventId,
  };
}
