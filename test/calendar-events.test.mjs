import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TRANSPARENCY,
  isAllDayValue,
  needsRecurrenceTimeZone,
  normalizeRecurrence,
  shapeEvent,
} from '../dist/calendar-events.js';

test('normalizeRecurrence distinguishes "leave alone" from "clear"', () => {
  // undefined must not reach the patch body at all; [] is the API's documented
  // way to turn a recurring series back into a single event.
  assert.equal(normalizeRecurrence(undefined), undefined);
  assert.deepEqual(normalizeRecurrence([]), []);
});

test('normalizeRecurrence accepts the supported RFC 5545 properties verbatim', () => {
  const lines = [
    'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270630T035959Z',
    'EXDATE;TZID=America/New_York:20260912T090000',
    'RDATE;TZID=America/New_York:20261225T090000',
  ];
  // Values and parameters (TZID casing in particular) must survive untouched.
  assert.deepEqual(normalizeRecurrence(lines), lines);
});

test('normalizeRecurrence trims and upcases only the property name', () => {
  assert.deepEqual(normalizeRecurrence(['  rrule:FREQ=WEEKLY;BYDAY=Tu  ']), ['RRULE:FREQ=WEEKLY;BYDAY=Tu']);
  assert.deepEqual(normalizeRecurrence(['exdate;TZID=America/New_York:20260912T090000']), [
    'EXDATE;TZID=America/New_York:20260912T090000',
  ]);
});

test('normalizeRecurrence rejects DTSTART, which Google derives from start/end', () => {
  assert.throws(() => normalizeRecurrence(['DTSTART;TZID=America/New_York:20260901T143000']), /may not set DTSTART/);
});

test('normalizeRecurrence rejects malformed or unsupported lines with a located message', () => {
  assert.throws(() => normalizeRecurrence(['FREQ=WEEKLY']), /recurrence\[0\] must start with an RFC 5545 property/);
  assert.throws(() => normalizeRecurrence(['RRULE:FREQ=WEEKLY', 'VEVENT:x']), /recurrence\[1\].*unsupported property "VEVENT"/);
  assert.throws(() => normalizeRecurrence(['RRULE:']), /recurrence\[0\] has no value/);
  assert.throws(() => normalizeRecurrence(['  ']), /recurrence\[0\] is empty/);
  assert.throws(() => normalizeRecurrence(['RRULE:FREQ=WEEKLY\nRRULE:FREQ=DAILY']), /must be a single line/);
});

test('needsRecurrenceTimeZone only fires for timed recurring events', () => {
  assert.equal(isAllDayValue('2026-09-01'), true);
  assert.equal(isAllDayValue('2026-09-01T14:30:00-04:00'), false);

  const weekly = ['RRULE:FREQ=WEEKLY;BYDAY=TU'];
  // A timed series needs a zone: an offset alone cannot describe DST behavior.
  assert.equal(needsRecurrenceTimeZone('2026-09-01T14:30:00-04:00', weekly), true);
  // All-day series and single events do not.
  assert.equal(needsRecurrenceTimeZone('2026-09-01', weekly), false);
  assert.equal(needsRecurrenceTimeZone('2026-09-01T14:30:00-04:00', undefined), false);
  assert.equal(needsRecurrenceTimeZone('2026-09-01T14:30:00-04:00', []), false);
});

test('shapeEvent always reports transparency, defaulting a missing field to busy', () => {
  // Google omits transparency on busy events; leaving it absent forces every
  // caller to infer "busy" from silence, which is how free/busy gets misread.
  const busy = shapeEvent({ id: 'a', summary: 'Standup' });
  assert.equal(busy.transparency, DEFAULT_TRANSPARENCY);
  assert.equal(busy.transparency, 'opaque');
  assert.equal(busy.busy, true);

  const free = shapeEvent({ id: 'b', summary: 'Robotics', transparency: 'transparent' });
  assert.equal(free.transparency, 'transparent');
  assert.equal(free.busy, false);
});

test('shapeEvent surfaces recurrence only when the event carries the rules', () => {
  const series = shapeEvent({ id: 'c', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'] });
  assert.deepEqual(series.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TH']);

  // Expanded instances carry recurringEventId instead of the rules themselves.
  const instance = shapeEvent({ id: 'c_20260910T200000Z', recurringEventId: 'c', recurrence: [] });
  assert.equal('recurrence' in instance, false);
  assert.equal(instance.recurringEventId, 'c');
});
