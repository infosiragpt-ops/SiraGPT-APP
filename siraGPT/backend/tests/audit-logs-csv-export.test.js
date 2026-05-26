/**
 * audit-logs CSV export — verifies the INTERNAL_CSV helpers exposed by
 * `routes/admin.js` correctly quote fields, serialise JSON columns,
 * and emit a stable header row matching AUDIT_CSV_COLUMNS.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// Stub the prisma client + middleware before requiring the route, so
// requiring admin.js (which pulls in a lot of infra) stays cheap.
const Module = require('module');
const origResolve = Module._resolveFilename;
const stubs = new Map();
function stub(id, value) {
  stubs.set(require.resolve(id, { paths: [require.resolve('../src/routes/admin')] }), value);
}
const origLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  try {
    const resolved = Module._resolveFilename(request, parent);
    if (stubs.has(resolved)) return stubs.get(resolved);
  } catch (_) { /* fall through */ }
  return origLoad.call(this, request, parent, ...rest);
};

let admin;
try {
  admin = require('../src/routes/admin');
} finally {
  Module._load = origLoad;
  Module._resolveFilename = origResolve;
}

const { auditLogsToCsv, csvEscape, AUDIT_CSV_COLUMNS } = admin.INTERNAL_CSV || {};

describe('admin audit-logs CSV export — helpers', () => {
  test('INTERNAL_CSV is exported', () => {
    assert.ok(admin.INTERNAL_CSV, 'INTERNAL_CSV should be exported');
    assert.equal(typeof auditLogsToCsv, 'function');
    assert.equal(typeof csvEscape, 'function');
    assert.ok(Array.isArray(AUDIT_CSV_COLUMNS));
    assert.ok(AUDIT_CSV_COLUMNS.includes('id'));
    assert.ok(AUDIT_CSV_COLUMNS.includes('action'));
    assert.ok(AUDIT_CSV_COLUMNS.includes('metadata'));
  });

  test('csvEscape handles null/undefined as empty', () => {
    assert.equal(csvEscape(null), '');
    assert.equal(csvEscape(undefined), '');
  });

  test('csvEscape leaves plain strings untouched', () => {
    assert.equal(csvEscape('hello'), 'hello');
    assert.equal(csvEscape(42), '42');
  });

  test('csvEscape quotes values with comma, quote, CR, or LF', () => {
    assert.equal(csvEscape('a,b'), '"a,b"');
    assert.equal(csvEscape('a"b'), '"a""b"');
    assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
    assert.equal(csvEscape('line1\r\nline2'), '"line1\r\nline2"');
  });

  test('csvEscape serialises Date as ISO and objects as JSON', () => {
    const d = new Date('2026-05-18T12:00:00Z');
    assert.equal(csvEscape(d), '2026-05-18T12:00:00.000Z');
    // Object containing commas — must be JSON-stringified AND quoted.
    const out = csvEscape({ a: 1, b: 'x,y' });
    assert.ok(out.startsWith('"'), 'object output should be quoted');
    assert.ok(out.includes('""a""'), 'inner quotes should be doubled');
  });

  test('auditLogsToCsv emits header + rows with CRLF', () => {
    const rows = [
      {
        id: 'a1', createdAt: new Date('2026-05-18T00:00:00Z'),
        actorId: 'u1', actorName: 'alice', action: 'login',
        resourceType: 'user', resourceId: 'u1', ip: '1.2.3.4',
        userAgent: 'curl/8', before: null, after: null,
        metadata: { reason: 'ok' },
      },
    ];
    const csv = auditLogsToCsv(rows);
    const lines = csv.split('\r\n');
    assert.equal(lines[0], AUDIT_CSV_COLUMNS.join(','));
    assert.ok(lines[1].includes('a1'));
    assert.ok(lines[1].includes('login'));
    assert.ok(lines[1].includes('2026-05-18T00:00:00.000Z'));
    // metadata JSON has no special chars → not necessarily quoted,
    // but should contain the serialised form.
    assert.ok(lines[1].includes('reason'));
    // Trailing CRLF terminator.
    assert.equal(lines[lines.length - 1], '');
  });

  test('auditLogsToCsv handles empty input → header only', () => {
    const csv = auditLogsToCsv([]);
    assert.equal(csv, AUDIT_CSV_COLUMNS.join(',') + '\r\n');
  });

  test('auditLogsToCsv tolerates rows missing columns', () => {
    const csv = auditLogsToCsv([{ id: 'a1', action: 'noop' }]);
    const lines = csv.split('\r\n');
    assert.equal(lines.length, 3); // header + row + trailing
    const cells = lines[1].split(',');
    assert.equal(cells[0], 'a1');
    // All other columns should be empty strings.
    for (let i = 1; i < AUDIT_CSV_COLUMNS.length; i++) {
      if (AUDIT_CSV_COLUMNS[i] === 'action') continue;
      assert.equal(cells[i], '', `column ${AUDIT_CSV_COLUMNS[i]} should be empty`);
    }
  });
});
