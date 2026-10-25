// The vendored copy's fingerprint: VERSION and a sha256 per file (line endings normalised, so a CRLF checkout
// matches). `node manifest.mjs` writes MANIFEST.json (only the canonical repo's sync does that); each app's test
// calls check() to make sure nobody edited its copy by hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function compute(dir = HERE) {
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f !== 'MANIFEST.json') files.push(p);
    }
  };
  walk(dir);
  const out = { version: fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), files: {} };
  for (const f of files.sort()) out.files[path.relative(dir, f).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  return out;
}

/** [] when the copy in dir matches its MANIFEST.json, else what differs. */
export function check(dir = HERE) {
  const want = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  const have = compute(dir);
  const diffs = [];
  if (want.version !== have.version) diffs.push(`VERSION ${have.version} (manifest says ${want.version})`);
  for (const f of new Set([...Object.keys(want.files), ...Object.keys(have.files)])) {
    if (want.files[f] !== have.files[f]) diffs.push(!have.files[f] ? `${f} missing` : !want.files[f] ? `${f} not in the manifest` : `${f} edited`);
  }
  return diffs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(HERE, 'MANIFEST.json'), `${JSON.stringify(compute(), null, 2)}\n`);
  console.log('MANIFEST.json written');
}
