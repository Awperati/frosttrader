#!/usr/bin/env node
// Run a backtest from the command line and print the report.
//
//   node scripts/backtest.mjs                 made-up bars (20 days, 5-minute)
//   node scripts/backtest.mjs data/bars       your CSV files (see server/engine/data/csv.mjs)
//   node scripts/backtest.mjs --json          the whole report as JSON
import { syntheticBars } from '../server/engine/data/synthetic.mjs';
import { csvBars } from '../server/engine/data/csv.mjs';
import { runBacktest } from '../server/engine/backtest.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const bars = dir ? csvBars(dir) : syntheticBars({ days: 20, barMinutes: Number(process.env.BAR_MINUTES || 5) });
if (!Object.keys(bars).length) {
  console.error(`No CSV files in ${dir}`);
  process.exit(1);
}
const r = await runBacktest(bars);
if (args.includes('--json')) {
  console.log(JSON.stringify(r, null, 1));
} else {
  const pct = (x) => `${x.toFixed(2)} %`;
  console.log(`Data: ${dir || 'made-up bars (says nothing about real markets)'}; symbols ${Object.keys(bars).join(', ')}; ${r.days} days`);
  console.log(`Return ${pct(r.returnPct)} (buy and hold ${pct(r.buyAndHoldPct)}), max drawdown ${pct(r.maxDrawdownPct)}, Sharpe ${r.sharpe.toFixed(2)}`);
  console.log(`Trades ${r.trades}, win rate ${pct(r.winRate * 100)}, avg win $${r.avgWin.toFixed(2)}, avg loss $${r.avgLoss.toFixed(2)}, profit factor ${r.profitFactor.toFixed(2)}`);
  console.log(`Exits ${JSON.stringify(r.byExit)}; blocked ${r.blocked} ${JSON.stringify(r.blockedReasons)}; halted days ${r.haltedDays}`);
  for (const s of r.signals) console.log(`  ${s.id.padEnd(16)} calls ${String(s.calls).padStart(5)}  hit ${pct(s.hitRate * 100)}  coin flip ${pct(s.baseRate * 100)}  edge ${pct(s.edge * 100)}`);
  console.log('Past results do not predict future ones.');
}
