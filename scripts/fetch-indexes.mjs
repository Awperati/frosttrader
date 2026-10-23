#!/usr/bin/env node
// Download the index dataset once: one plain HTTPS GET of a single CSV from huggingface.co.
// It is saved to DATA_DIR/datasets/ (git-ignored) and never committed.
//
//   node scripts/fetch-indexes.mjs           skip if the file is already there
//   node scripts/fetch-indexes.mjs --force   download again
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET, datasetPath, parseIndexCsv } from '../server/engine/data/indexes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = datasetPath(path.resolve(process.env.DATA_DIR || path.join(root, 'data')));

if (fs.existsSync(file) && !process.argv.includes('--force')) {
  console.log(`Already there: ${file} (use --force to download again)`);
  process.exit(0);
}
const res = await fetch(DATASET.download, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status} from ${DATASET.download}`);
  process.exit(1);
}
const text = await res.text();
const parsed = parseIndexCsv(text); // throws if the columns are not what the loader expects
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file + '.tmp', text);
fs.renameSync(file + '.tmp', file);
console.log(`Saved ${file}: ${parsed.rows} rows, ${parsed.quality.symbols} indices, ${parsed.quality.from} to ${parsed.quality.to}.`);
console.log(`Source: ${DATASET.url}. ${DATASET.provenance}`);
