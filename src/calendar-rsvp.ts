// Pure helpers for the calendar RSVP flow, extracted so the attendee-matching
// and patch-body construction can be unit-tested without any live Google calls.
// This module intentionally has no runtime dependencies.

export type RsvpResponseStatus = 'accepted' | 'declined' | 'tentative';

export interface RsvpAttendee {
  email?: string | null;
  self?: boolean | null;
  responseStatus?: string | null;
}

/** Find the attendee entry representing the selected account, by self flag or email. */
export function findSelfAttendee<T extends RsvpAttendee>(
  attendees: T[] | undefined,
  accountEmail: string
): T | undefined {
  const target = accountEmail.toLowerCase();
  return (attendees ?? []).find(
    (attendee) => Boolean(attendee.self) || attendee.email?.toLowerCase() === target
  );
}

/**
 * Build the events.patch requestBody that updates ONLY the selected account's
 * response. `attendeesOmitted: true` tells the Calendar API this is a partial
 * attendee list, so the other attendees are preserved rather than replaced —
 * without it, supplying `attendees` would overwrite the whole guest list.
 */
export function buildRsvpPatchBody(selfEmail: string, responseStatus: RsvpResponseStatus) {
  return {
    attendeesOmitted: true,
    attendees: [{ email: selfEmail, responseStatus }],
  };
}
