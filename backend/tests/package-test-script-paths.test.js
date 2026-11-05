'use strict';

// `npm test` passes `node --test` an explicit list. A path that does not exist
// there is skipped without a warning (two paths once got joined into one when
// a file was inserted, and two suites stopped running locally while the
// command still reported green). CI shards discover tests on disk, so only
// this check notices.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const script = require('../package.json').scripts.test;

test('every test file named by the backend npm test script exists', () => {
  const tokens = script.split(/\s+/).filter(Boolean);
  assert.deepEqual(tokens.slice(0, 2), ['node', '--test']);
  const files = tokens.slice(2);
  assert.ok(files.length > 0);
  const missing = files.filter((file) => !fs.existsSync(path.join(BACKEND_ROOT, file)));
  assert.deepEqual(missing, [], `missing from disk: ${missing.join(', ')}`);
  const malformed = files.filter((file) => !/^(?:tests\/|\.\.\/)[^\s]*\.test\.js$/.test(file) || /\.js./.test(file));
  assert.deepEqual(malformed, [], `not a single test file: ${malformed.join(', ')}`);
  const repeated = files.filter((file, index) => files.indexOf(file) !== index);
  assert.deepEqual(repeated, [], `listed twice: ${repeated.join(', ')}`);
});
