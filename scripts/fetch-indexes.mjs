#!/usr/bin/env node
// Download the index dataset once: one plain HTTPS GET of a single CSV from huggingface.co.
// It is saved to DATA_DIR/datasets/ (git-ignored) and never committed.
//
//   node scripts/fetch-indexes.mjs           skip if the file is already there
//   node scripts/fetch-indexes.mjs --force   download again
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET, datasetPath, downloadIndexDataset } from '../server/engine/data/indexes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = datasetPath(path.resolve(process.env.DATA_DIR || path.join(root, 'data')));

if (fs.existsSync(file) && !process.argv.includes('--force')) {
  console.log(`Already there: ${file} (use --force to download again)`);
  process.exit(0);
}
let got;
try {
  got = await downloadIndexDataset(file);
} catch (e) {
  console.error(`Download failed: ${e.message}`);
  process.exit(1);
}
console.log(`Saved ${file}: ${got.rows} rows, ${got.symbols} indices, ${got.from} to ${got.to}.`);
console.log(`Source: ${DATASET.url}. ${DATASET.provenance}`);
