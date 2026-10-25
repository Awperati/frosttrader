// The suite's shared updater is vendored unchanged (Awperati/frost-updater): its MANIFEST says so.
import test from 'node:test';
import assert from 'node:assert/strict';
const { check } = await import('../electron/frost-updater/manifest.mjs');
test('the vendored frost-updater matches its MANIFEST', () => assert.deepEqual(check(), []));
