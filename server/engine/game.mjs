// The streak and level display. Points come only from discipline, never from profit: a day
// that stays inside the limits scores the same whether it made or lost money, a day the daily
// loss limit stopped scores the same as any other (stopping is the rule working), and pressing
// the kill switch is rewarded, not punished. Loosening a limit or resuming after the kill switch
// on the same day breaks the streak. Nothing here ever changes how the app trades.

export const TITLES = ['Snowflake', 'Frost', 'Icicle', 'Glacier', 'Permafrost', 'Polar'];
const XP_PER_LEVEL = 250;

/**
 * days: [{ key, pnl, buys, halted }] in order. overrides: [{ day, kind: 'loosen' | 'resume' }].
 * kills: number of kill-switch presses. maxTrades: today's trade limit (for the "patient" bonus).
 */
export function gameState({ days = [], overrides = [], kills = 0, maxTrades = 10 }) {
  const broke = new Set(overrides.map((o) => o.day));
  let xp = 0;
  let streak = 0;
  let best = 0;
  const log = [];
  for (const d of days) {
    let pts = 0;
    if (broke.has(d.key)) {
      streak = 0;
      log.push({ day: d.key, pts: 0, why: 'A limit was loosened or the kill switch undone' });
      continue;
    }
    pts += 40; // stayed inside every limit (the server makes sure of that)
    if (d.buys <= Math.floor(maxTrades / 2)) pts += 10; // patient: used half the trades or fewer
    streak++;
    best = Math.max(best, streak);
    if (streak % 5 === 0) pts += 25;
    xp += pts;
    log.push({ day: d.key, pts, why: d.halted ? 'Stopped on time at the daily limit' : 'Stayed inside the limits' });
  }
  xp += kills * 15;
  const level = Math.floor(xp / XP_PER_LEVEL) + 1;
  const badges = [];
  if (days.length) badges.push({ id: 'first-day', name: 'First day on the ice', text: 'Finished a trading day.' });
  if (best >= 5) badges.push({ id: 'streak-5', name: 'Steady hands', text: '5 days in a row inside the limits.' });
  if (best >= 20) badges.push({ id: 'streak-20', name: 'Glacial patience', text: '20 days in a row inside the limits.' });
  if (days.some((d) => d.halted && !broke.has(d.key))) badges.push({ id: 'stopped', name: 'Walked away', text: 'Hit the daily loss limit and stopped for the day.' });
  if (kills > 0) badges.push({ id: 'brakes', name: 'Hit the brakes', text: 'Used the kill switch.' });
  return {
    xp,
    level,
    title: TITLES[Math.min(TITLES.length - 1, level - 1)],
    toNext: XP_PER_LEVEL - (xp % XP_PER_LEVEL),
    progress: (xp % XP_PER_LEVEL) / XP_PER_LEVEL,
    streak,
    best,
    badges,
    log: log.slice(-30),
  };
}
