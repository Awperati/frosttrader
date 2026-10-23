// A stand-in agent for the isolation test (test/agents.test.mjs): started with the same options as a
// real agent, it reports what it can see and do.
import fs from 'node:fs';

process.on('message', async (m) => {
  const tryIt = (fn) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return e.code || e.message;
    }
  };
  const read = Object.fromEntries(m.read.map((f) => [f, tryIt(() => fs.readFileSync(f))]));
  const write = tryIt(() => fs.writeFileSync(m.write, 'x'));
  const cp = await import('node:child_process');
  const spawn = tryIt(() => cp.execSync('echo hi'));
  process.send({ read, write, spawn, env: process.env, argv: process.argv });
});
