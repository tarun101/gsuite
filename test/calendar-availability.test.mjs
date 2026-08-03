import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeBusyIntervals,
  computeFreeGaps,
  aggregateAvailability,
  chunkCalendarIds,
} from '../dist/calendar-availability.js';

// T() builds the compact RFC 3339 strings the Calendar API returns; I() is the
// canonical ISO form (with .000 millis) that computeFreeGaps emits for gaps.
const T = (h) => `2026-08-04T${String(h).padStart(2, '0')}:00:00Z`;
const I = (h) => new Date(T(h)).toISOString();

test('a busy interval on a secondary calendar makes the window busy', () => {
  // primary and Personal are free; only the Family calendar has a conflict —
  // the whole point of aggregating across calendars, not just primary.
  const calendars = {
    primary: { busy: [] },
    'personal@example.com': { busy: [] },
    'family@group.calendar.google.com': { busy: [{ start: T(14), end: T(15) }] },
  };
  const r = aggregateAvailability(T(9), T(17), calendars);
  assert.equal(r.overallBusy, true);
  assert.deepEqual(r.busy, [{ start: T(14), end: T(15) }]);
  assert.deepEqual(r.free, [
    { start: I(9), end: I(14) },
    { start: I(15), end: I(17) },
  ]);
  assert.deepEqual(r.calendarErrors, []);
});

test('overlapping busy intervals across calendars merge into one', () => {
  const calendars = {
    primary: { busy: [{ start: T(10), end: T(12) }] },
    'personal@example.com': { busy: [{ start: T(11), end: T(13) }] },
  };
  const r = aggregateAvailability(T(9), T(17), calendars);
  assert.deepEqual(r.busy, [{ start: T(10), end: T(13) }]);
  assert.deepEqual(r.free, [
    { start: I(9), end: I(10) },
    { start: I(13), end: I(17) },
  ]);
});

test('explicit narrow scope only reflects the calendars passed in', () => {
  // The caller opted into just primary, so the map the aggregator sees does not
  // contain the Family conflict and the window is reported free.
  const calendars = { primary: { busy: [] } };
  const r = aggregateAvailability(T(9), T(17), calendars);
  assert.equal(r.overallBusy, false);
  assert.deepEqual(r.free, [{ start: I(9), end: I(17) }]);
});

test('inaccessible calendars are reported, never silently dropped', () => {
  const calendars = {
    primary: { busy: [{ start: T(10), end: T(11) }] },
    'locked@example.com': { errors: [{ domain: 'global', reason: 'notFound' }] },
  };
  const r = aggregateAvailability(T(9), T(17), calendars);
  assert.equal(r.overallBusy, true);
  assert.deepEqual(r.calendarErrors, [
    { calendarId: 'locked@example.com', errors: [{ domain: 'global', reason: 'notFound' }] },
  ]);
});

test('mergeBusyIntervals sorts, merges overlap and adjacency, drops zero-length', () => {
  const merged = mergeBusyIntervals([
    { start: T(13), end: T(14) },
    { start: T(9), end: T(10) },
    { start: T(10), end: T(11) }, // adjacent to previous -> merged
    { start: T(15), end: T(15) }, // zero-length -> dropped
  ]);
  assert.deepEqual(merged, [
    { start: T(9), end: T(11) },
    { start: T(13), end: T(14) },
  ]);
});

test('computeFreeGaps clips busy intervals to the window bounds', () => {
  // A busy block that starts before the window should only subtract the part
  // that falls inside it.
  const free = computeFreeGaps(T(9), T(17), [{ start: T(7), end: T(10) }]);
  assert.deepEqual(free, [{ start: I(10), end: I(17) }]);
});

test('chunkCalendarIds batches by the freebusy 50-calendar limit', () => {
  const ids = Array.from({ length: 120 }, (_, i) => `c${i}`);
  const batches = chunkCalendarIds(ids);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 50);
  assert.equal(batches[2].length, 20);
});
