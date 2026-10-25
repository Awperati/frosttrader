// NYSE full-day closures and early closes, by New York trading date ("2026-07-03").
// Source: NYSE Group holiday calendar, nyse.com/markets/hours-calendars, checked against
// the NYSE Group announcement "2026, 2027 and 2028 Holiday and Early Closings Calendar" (Dec 2025).
// Covers 2026 and 2027 only. Add the next years when NYSE publishes them.

/** Full-day closures. */
export const US_CLOSURES = new Map([
  ['2026-01-01', "New Year's Day"],
  ['2026-01-19', 'Martin Luther King Jr. Day'],
  ['2026-02-16', "Washington's Birthday"],
  ['2026-04-03', 'Good Friday'],
  ['2026-05-25', 'Memorial Day'],
  ['2026-06-19', 'Juneteenth'],
  ['2026-07-03', 'Independence Day (observed)'],
  ['2026-09-07', 'Labor Day'],
  ['2026-11-26', 'Thanksgiving Day'],
  ['2026-12-25', 'Christmas Day'],
  ['2027-01-01', "New Year's Day"],
  ['2027-01-18', 'Martin Luther King Jr. Day'],
  ['2027-02-15', "Washington's Birthday"],
  ['2027-03-26', 'Good Friday'],
  ['2027-05-31', 'Memorial Day'],
  ['2027-06-18', 'Juneteenth (observed)'],
  ['2027-07-05', 'Independence Day (observed)'],
  ['2027-09-06', 'Labor Day'],
  ['2027-11-25', 'Thanksgiving Day'],
  ['2027-12-24', 'Christmas Day (observed)'],
]);

/** Days that close at EARLY_CLOSE_MIN New York time instead of 16:00. */
export const US_EARLY_CLOSES = new Map([
  ['2026-11-27', 'Day after Thanksgiving'],
  ['2026-12-24', 'Christmas Eve'],
  ['2027-11-26', 'Day after Thanksgiving'],
]);

export const EARLY_CLOSE_MIN = 13 * 60; // 13:00 New York
