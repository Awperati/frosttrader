import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketOpen } from './stats.mjs';

// New York wall-clock time as an instant. -04:00 is EDT, -05:00 is EST.
const ny = (iso, offset) => new Date(`${iso}${offset}`).getTime();

test('a full-day holiday is closed all day', () => {
  assert.equal(marketOpen(ny('2026-07-03T10:00:00', '-04:00')), false); // Independence Day (observed)
  assert.equal(marketOpen(ny('2026-12-25T10:00:00', '-05:00')), false); // Christmas Day
  assert.equal(marketOpen(ny('2027-06-18T10:00:00', '-04:00')), false); // Juneteenth (observed)
});

test('the trading day after a holiday opens normally', () => {
  assert.equal(marketOpen(ny('2026-07-06T09:30:00', '-04:00')), true);
  assert.equal(marketOpen(ny('2026-07-06T09:29:00', '-04:00')), false);
});

test('an early-close day closes at 13:00 New York time', () => {
  assert.equal(marketOpen(ny('2026-11-27T09:30:00', '-05:00')), true); // day after Thanksgiving
  assert.equal(marketOpen(ny('2026-11-27T12:59:00', '-05:00')), true);
  assert.equal(marketOpen(ny('2026-11-27T13:00:00', '-05:00')), false);
  assert.equal(marketOpen(ny('2026-12-24T12:59:00', '-05:00')), true); // Christmas Eve
  assert.equal(marketOpen(ny('2026-12-24T13:00:00', '-05:00')), false);
});

test('a normal weekday keeps the 09:30 to 16:00 session', () => {
  assert.equal(marketOpen(ny('2026-07-06T15:59:00', '-04:00')), true);
  assert.equal(marketOpen(ny('2026-07-06T16:00:00', '-04:00')), false);
  assert.equal(marketOpen(ny('2026-07-06T13:00:00', '-04:00')), true); // not an early-close day
});

test('weekends stay closed', () => {
  assert.equal(marketOpen(ny('2026-07-04T10:00:00', '-04:00')), false); // Saturday
  assert.equal(marketOpen(ny('2026-07-05T10:00:00', '-04:00')), false); // Sunday
});
