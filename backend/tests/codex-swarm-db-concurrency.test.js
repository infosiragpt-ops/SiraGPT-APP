'use strict';

// Fleet concurrency must never exceed what the database pool can serve.
//
// Production incident: a 300-agent fleet defaulted to 128 concurrent tasks
// against a Prisma pool of `cpus * 2 + 1` (= 17 on the 8-core VPS) shared with
// all HTTP traffic. Transactions failed with "Unable to start a transaction in
// the given time", the swarm job crashed, and the fleet auto-paused — twice,
// producing zero useful output.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const routeSource = require('node:fs').readFileSync(
  require.resolve('../src/routes/codex.js'),
  'utf8',
);

// The helpers are module-private; exercise them through a tiny sandbox that
// evaluates just the two functions with the same dependencies they use.
function loadHelpers() {
  const grab = (name) => {
    const start = routeSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    let depth = 0;
    for (let i = routeSource.indexOf('{', start); i < routeSource.length; i += 1) {
      if (routeSource[i] === '{') depth += 1;
      else if (routeSource[i] === '}') {
        depth -= 1;
        if (depth === 0) return routeSource.slice(start, i + 1);
      }
    }
    assert.fail(`unbalanced ${name}`);
  };
  const src = [
    grab('boundedSwarmInteger'),
    grab('databaseConcurrencyCeiling'),
    grab('swarmConcurrencyDefaults'),
    'return { databaseConcurrencyCeiling, swarmConcurrencyDefaults };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('require', src)(require);
}

const { databaseConcurrencyCeiling, swarmConcurrencyDefaults } = loadHelpers();

test('the ceiling honours an explicit connection_limit and leaves headroom', () => {
  const env = { DATABASE_URL: 'postgres://u:p@db:5432/app?connection_limit=40' };
  assert.equal(databaseConcurrencyCeiling(env), 20, 'half the pinned pool');
});

test('without a pinned limit the ceiling follows Prisma cpus*2+1', () => {
  const expected = Math.max(4, Math.floor(((os.cpus().length || 4) * 2 + 1) / 2));
  assert.equal(databaseConcurrencyCeiling({ DATABASE_URL: 'postgres://u:p@db:5432/app' }), expected);
});

test('a tiny pool still leaves a usable floor', () => {
  const env = { DATABASE_URL: 'postgres://u:p@db:5432/app?connection_limit=2' };
  assert.equal(databaseConcurrencyCeiling(env), 4, 'never drop below 4 concurrent tasks');
});

test('defaults never oversubscribe the pool, even when env asks for more', () => {
  const env = {
    DATABASE_URL: 'postgres://u:p@db:5432/app?connection_limit=20',
    SIRAGPT_SWARM_MAX_CONCURRENCY_HARD: '256',
    SIRAGPT_SWARM_MAX_CONCURRENCY_DEFAULT: '128',
  };
  const d = swarmConcurrencyDefaults(env);
  assert.equal(d.hardMax, 10, 'the hard cap is clamped to the pool ceiling');
  assert.ok(d.defaultConcurrency <= d.hardMax, 'default must fit under the hard cap');
  assert.ok(d.defaultWriters <= d.hardMax, 'writers must fit under the hard cap');
});

test('logical agent capacity stays large — only instantaneous concurrency is capped', () => {
  const d = swarmConcurrencyDefaults({ DATABASE_URL: 'postgres://u:p@db:5432/app?connection_limit=8' });
  assert.equal(d.hardLogical, 10_000, '300+ agent fleets remain supported');
  assert.ok(d.defaultConcurrency <= 4 || d.defaultConcurrency <= d.hardMax);
});
