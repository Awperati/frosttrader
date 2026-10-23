#!/usr/bin/env node
// Run a backtest from the command line and print the report.
//
//   node scripts/backtest.mjs                 made-up bars (20 days, 5-minute)
//   node scripts/backtest.mjs data/bars       your CSV files (see server/engine/data/csv.mjs)
//   node scripts/backtest.mjs --indexes [file] [--range 1Y]
//                                             daily study of the index dataset (default
//                                             data/datasets/Stock_Market_Indexes.csv). It does
//                                             not run the intraday Trader: indices are daily
//                                             bars and cannot be traded here.
//   node scripts/backtest.mjs --json          the whole report as JSON
import path from 'node:path';
import { syntheticBars } from '../server/engine/data/synthetic.mjs';
import { csvBars } from '../server/engine/data/csv.mjs';
import { datasetPath, indexBars, loadIndexDataset } from '../server/engine/data/indexes.mjs';
import { runBacktest, indexStudy } from '../server/engine/backtest.mjs';

const args = process.argv.slice(2);
const pct = (x) => (x == null ? '-' : `${x.toFixed(2)} %`);
const valueAfter = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

if (args.includes('--indexes')) {
  const file = valueAfter('--indexes') || datasetPath(path.resolve(process.env.DATA_DIR || 'data'));
  const ds = loadIndexDataset(file);
  if (!ds) {
    console.error(`No index dataset at ${file}. Run "npm run fetch:indexes" first.`);
    process.exit(1);
  }
  const r = indexStudy(indexBars(ds), { range: valueAfter('--range') || 'All' });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...r, dataset: ds.meta, dropped: ds.quality.droppedByReason }, null, 1));
  } else {
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    console.log(`Data: ${file} (${ds.meta.provenance}); ${r.symbols} indices, ${day(r.from)} to ${day(r.to)}, range ${r.range}`);
    console.log(`Rows dropped by the loader: ${JSON.stringify(ds.quality.droppedByReason)}`);
    console.log(`${'symbol'.padEnd(10)} ${'return'.padStart(10)} ${'volatility'.padStart(11)} ${'max drawdown'.padStart(13)} ${'worst day'.padStart(10)}`);
    for (const x of r.rows) console.log(`${x.symbol.padEnd(10)} ${pct(x.returnPct).padStart(10)} ${pct(x.volatilityPct).padStart(11)} ${pct(x.maxDrawdownPct).padStart(13)} ${pct(x.worstDay.pct).padStart(10)}`);
    if (r.average) console.log(`Average: return ${pct(r.average.returnPct)}, volatility ${pct(r.average.volatilityPct)}, max drawdown ${pct(r.average.maxDrawdownPct)}`);
    console.log('Index levels in local currencies, no dividends unless the index includes them. Past results do not predict future ones.');
  }
  process.exit(0);
}

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
  console.log(`Data: ${dir || 'made-up bars (says nothing about real markets)'}; symbols ${Object.keys(bars).join(', ')}; ${r.days} days`);
  console.log(`Return ${pct(r.returnPct)} (buy and hold ${pct(r.buyAndHoldPct)}), max drawdown ${pct(r.maxDrawdownPct)}, Sharpe ${r.sharpe.toFixed(2)}`);
  console.log(`Trades ${r.trades}, win rate ${pct(r.winRate * 100)}, avg win $${r.avgWin.toFixed(2)}, avg loss $${r.avgLoss.toFixed(2)}, profit factor ${r.profitFactor.toFixed(2)}`);
  console.log(`Exits ${JSON.stringify(r.byExit)}; blocked ${r.blocked} ${JSON.stringify(r.blockedReasons)}; halted days ${r.haltedDays}`);
  for (const s of r.signals) console.log(`  ${s.id.padEnd(16)} calls ${String(s.calls).padStart(5)}  hit ${pct(s.hitRate * 100)}  coin flip ${pct(s.baseRate * 100)}  edge ${pct(s.edge * 100)}`);
  console.log('Past results do not predict future ones.');
}
