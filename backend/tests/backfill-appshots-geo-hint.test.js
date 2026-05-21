'use strict';

/**
 * backfill-appshots-geo-hint — Task 24 unit tests.
 *
 * Prisma is faked in-memory; resolveGeoHint is injected so we don't hit
 * the network. We cover: appshots-only scope filter, ipHint → ip
 * conversion, dry-run, limit, unresolvable degrade-silent, malformed
 * ipHint, missing JWT_SECRET abort.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const SECRET = 'backfill-appshots-geo-hint-test-secret-32+chars!';
process.env.JWT_SECRET = SECRET;

const { run, ipFromHint } = require('../src/jobs/backfill-appshots-geo-hint');

const silentLogger = { info() {}, warn() {}, error() {} };

function appshotsToken(userId = 'u1') {
  return jwt.sign({ userId, scope: 'appshots:capture', nonce: 'x' }, SECRET, { expiresIn: '1h' });
}
function plainToken(userId = 'u1') {
  return jwt.sign({ userId, id: userId }, SECRET, { expiresIn: '1h' });
}

function makePrisma(initialRows) {
  const rows = initialRows.map((r) => ({ ...r }));
  const updates = [];
  return {
    _rows: rows,
    _updates: updates,
    session: {
      async findMany(args) {
        const where = args.where || {};
        let filtered = rows.filter((r) => {
          if (where.geoHint === null && r.geoHint != null) return false;
          if (where.ipHint && where.ipHint.not === null && r.ipHint == null) return false;
          return true;
        });
        filtered = filtered.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (args.cursor) {
          const idx = filtered.findIndex((r) => r.id === args.cursor.id);
          if (idx >= 0) filtered = filtered.slice(idx + (args.skip || 0));
        }
        return filtered.slice(0, args.take || filtered.length).map((r) => ({
          id: r.id,
          token: r.token,
          ipHint: r.ipHint,
        }));
      },
      async update({ where, data }) {
        const target = rows.find((r) => r.id === where.id);
        if (!target) throw new Error(`no row ${where.id}`);
        Object.assign(target, data);
        updates.push({ id: where.id, data });
        return target;
      },
    },
  };
}

describe('ipFromHint', () => {
  it('converts /24 with .0 host to .1', () => {
    assert.equal(ipFromHint('81.45.30.0/24'), '81.45.30.1');
  });
  it('keeps non-zero host octets', () => {
    assert.equal(ipFromHint('81.45.30.7/24'), '81.45.30.7');
  });
  it('hydrates /64 IPv6 prefix to ::1 host', () => {
    assert.equal(ipFromHint('2a01:e0a:abc:def::/64'), '2a01:e0a:abc:def::1');
  });
  it('returns null for malformed hints', () => {
    assert.equal(ipFromHint(''), null);
    assert.equal(ipFromHint(null), null);
    assert.equal(ipFromHint('not-an-ip'), null);
  });
});

describe('backfill-appshots-geo-hint run', () => {
  it('fills geoHint only for appshots-scope rows with a usable ipHint', async () => {
    const prisma = makePrisma([
      { id: 's1', token: appshotsToken(), ipHint: '81.45.30.0/24', geoHint: null },
      { id: 's2', token: plainToken(), ipHint: '8.8.8.0/24', geoHint: null },
      { id: 's3', token: appshotsToken(), ipHint: '2a01:e0a:abc:def::/64', geoHint: null },
      { id: 's4', token: appshotsToken(), ipHint: 'garbage', geoHint: null },
    ]);
    const seen = [];
    const summary = await run({
      prisma,
      logger: silentLogger,
      delayMs: 0,
      jwtSecret: SECRET,
      resolveGeoHint: async (ip) => { seen.push(ip); return ip.includes(':') ? 'Lyon, FR' : 'Madrid, ES'; },
    });

    assert.equal(summary.scanned, 4);
    assert.equal(summary.appshotsCandidates, 3);
    assert.equal(summary.skippedNonAppshots, 1);
    assert.equal(summary.skippedBadIpHint, 1);
    assert.equal(summary.filled, 2);
    assert.deepEqual(seen.sort(), ['2a01:e0a:abc:def::1', '81.45.30.1']);
    assert.equal(prisma._rows.find((r) => r.id === 's1').geoHint, 'Madrid, ES');
    assert.equal(prisma._rows.find((r) => r.id === 's3').geoHint, 'Lyon, FR');
    assert.equal(prisma._rows.find((r) => r.id === 's2').geoHint, null);
  });

  it('dry-run does not persist updates but still counts them', async () => {
    const prisma = makePrisma([
      { id: 's1', token: appshotsToken(), ipHint: '81.45.30.0/24', geoHint: null },
    ]);
    const summary = await run({
      prisma, dryRun: true, logger: silentLogger, delayMs: 0, jwtSecret: SECRET,
      resolveGeoHint: async () => 'Madrid, ES',
    });
    assert.equal(summary.filled, 1);
    assert.equal(summary.dryRun, true);
    assert.equal(prisma._updates.length, 0);
    assert.equal(prisma._rows[0].geoHint, null);
  });

  it('degrades silently when resolveGeoHint returns null', async () => {
    const prisma = makePrisma([
      { id: 's1', token: appshotsToken(), ipHint: '81.45.30.0/24', geoHint: null },
      { id: 's2', token: appshotsToken(), ipHint: '8.8.8.0/24', geoHint: null },
    ]);
    const summary = await run({
      prisma, logger: silentLogger, delayMs: 0, jwtSecret: SECRET,
      resolveGeoHint: async (ip) => (ip.startsWith('8.') ? 'Mountain View, US' : null),
    });
    assert.equal(summary.filled, 1);
    assert.equal(summary.skippedUnresolvable, 1);
    assert.equal(prisma._rows.find((r) => r.id === 's1').geoHint, null);
    assert.equal(prisma._rows.find((r) => r.id === 's2').geoHint, 'Mountain View, US');
  });

  it('honours limit', async () => {
    const rows = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push({ id: `s${i}`, token: appshotsToken(), ipHint: `10.0.${i}.0/24`, geoHint: null });
    }
    const prisma = makePrisma(rows);
    const summary = await run({
      prisma, logger: silentLogger, delayMs: 0, jwtSecret: SECRET, limit: 2, batchSize: 2,
      resolveGeoHint: async () => 'Madrid, ES',
    });
    assert.equal(summary.filled, 2);
  });

  it('aborts cleanly when JWT_SECRET is missing', async () => {
    const prisma = makePrisma([]);
    const prev = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    let summary;
    try {
      summary = await run({
        prisma, logger: silentLogger, delayMs: 0, jwtSecret: '',
        resolveGeoHint: async () => 'X',
      });
    } finally {
      process.env.JWT_SECRET = prev;
    }
    assert.equal(summary.aborted, 'missing_jwt_secret');
    assert.equal(summary.filled, 0);
  });

  it('does not crash when prisma.update rejects mid-batch', async () => {
    const prisma = makePrisma([
      { id: 's1', token: appshotsToken(), ipHint: '81.45.30.0/24', geoHint: null },
    ]);
    prisma.session.update = async () => { throw new Error('row vanished'); };
    const summary = await run({
      prisma, logger: silentLogger, delayMs: 0, jwtSecret: SECRET,
      resolveGeoHint: async () => 'Madrid, ES',
    });
    assert.equal(summary.filled, 0);
    assert.equal(summary.skippedUnresolvable, 1);
  });
});
