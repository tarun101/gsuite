import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRsvpPatchBody, findSelfAttendee } from '../dist/calendar-rsvp.js';

test('buildRsvpPatchBody preserves other attendees via attendeesOmitted', () => {
  const body = buildRsvpPatchBody('me@example.com', 'accepted');
  // attendeesOmitted:true is what stops the partial attendee list from wiping
  // every other guest — the single most important invariant of the RSVP tool.
  assert.equal(body.attendeesOmitted, true);
  assert.deepEqual(body.attendees, [{ email: 'me@example.com', responseStatus: 'accepted' }]);
});

test('findSelfAttendee matches on the self flag', () => {
  const attendees = [
    { email: 'organizer@example.com' },
    { email: 'me@example.com', self: true, responseStatus: 'needsAction' },
  ];
  assert.equal(findSelfAttendee(attendees, 'not-the-match@example.com')?.email, 'me@example.com');
});

test('findSelfAttendee falls back to a case-insensitive email match', () => {
  const attendees = [{ email: 'Me@Example.com', responseStatus: 'needsAction' }];
  assert.equal(findSelfAttendee(attendees, 'me@example.com')?.email, 'Me@Example.com');
});

test('findSelfAttendee returns undefined when the account is not an attendee', () => {
  // The handler relies on this to throw and refuse to change any RSVP.
  assert.equal(findSelfAttendee([{ email: 'someone@example.com' }], 'me@example.com'), undefined);
  assert.equal(findSelfAttendee(undefined, 'me@example.com'), undefined);
});
