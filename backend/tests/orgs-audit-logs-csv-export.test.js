'use strict';

/**
 * Ratchet 44 — tests for the org-scoped audit-logs CSV export.
 *
 *   GET /api/orgs/:id/audit-logs.csv  (ADMIN+)
 *
 * Mirrors the super-admin /api/admin/audit-logs.csv export but locks
 * the byOrg filter to the path parameter and embeds the org slug into
 * the Content-Disposition filename for easier triage of SIEM downloads.
 * Exercises the handler directly via the __handlers export so we don't
 * need to bind an Express app + HTTP server.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const orgsRouter = require('../src/routes/orgs');

const { exportOrgAuditLogsCsv } = orgsRouter.__handlers;
const {
  orgAuditLogsToCsv,
  orgAuditCsvEscape,
  ORG_AUDIT_CSV_COLUMNS,
  sanitizeSlugForFilename,
} = orgsRouter.INTERNAL_ORG_AUDIT_CSV;

function makeRes() {
  const headers = {};
  let status = 200;
  let body;
  let raw = '';
  let ended = false;
  return {
    status(code) { status = code; return this; },
    json(payload) { body = payload; ended = true; return this; },
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    write(chunk) { raw += chunk; },
    end() { ended = true; return this; },
    get _status() { return status; },
    get _body() { return body; },
    get _raw() { return raw; },
    get _headers() { return headers; },
    get _ended() { return ended; },
  };
}

function makeFakePrisma({ members = {}, orgs = {}, auditRows = [] } = {}) {
  const auditCalls = [];

  const orgMembership = {
    findUnique: async ({ where }) => {
      const { orgId, userId } = where.orgId_userId;
      const m = members[`${orgId}:${userId}`];
      if (!m) return null;
      const org = orgs[orgId] || { id: orgId, slug: orgId };
      return { id: 'mem', orgId, userId, role: m.role, organization: org };
    },
  };

  const auditLog = {
    findMany: async ({ where, skip, take }) => {
      auditCalls.push({ where, skip, take });
      return auditRows.filter((r) => {
        if (where.metadata?.path?.[0] === 'orgId') {
          if (!r.metadata || r.metadata.orgId !== where.metadata.equals) return false;
        }
        if (where.action && r.action !== where.action) return false;
        if (where.actorId && r.actorId !== where.actorId) return false;
        return true;
      }).slice(skip || 0, (skip || 0) + (take || 500));
    },
    count: async ({ where }) => {
      return auditRows.filter((r) => {
        if (where.metadata?.path?.[0] === 'orgId') {
          if (!r.metadata || r.metadata.orgId !== where.metadata.equals) return false;
        }
        if (where.action && r.action !== where.action) return false;
        return true;
      }).length;
    },
  };

  return {
    prisma: { orgMembership, auditLog, _auditCalls: auditCalls },
  };
}

// ── Handler ────────────────────────────────────────────────────────

describe('GET /api/orgs/:id/audit-logs.csv handler', () => {
  test('ADMIN export renders RFC4180 CSV with org-slug filename', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1', slug: 'acme-corp' } },
      auditRows: [
        {
          id: 'a1',
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          actorId: 'u-1',
          actorName: 'Alice',
          action: 'org_create',
          resourceType: 'org',
          resourceId: 'o1',
          ip: '1.2.3.4',
          userAgent: 'curl/8',
          before: null,
          after: { name: 'Acme, Inc.' },
          metadata: { orgId: 'o1' },
        },
      ],
    });
    const req = { user: { id: 'admin1' }, params: { id: 'o1' }, query: {} };
    const res = makeRes();
    await exportOrgAuditLogsCsv(req, res, { prisma });

    assert.equal(res._status, 200);
    assert.ok(res._ended);
    assert.equal((res._headers['content-type'] || '').startsWith('text/csv'), true);
    const cd = res._headers['content-disposition'] || '';
    assert.ok(cd.includes('attachment'));
    assert.ok(/filename="audit-logs-acme-corp-\d+\.csv"/.test(cd), `unexpected CD: ${cd}`);

    const lines = res._raw.split('\r\n');
    assert.equal(lines[0], ORG_AUDIT_CSV_COLUMNS.join(','));
    // Row contains JSON-serialized `after` with embedded comma → must be
    // wrapped in double quotes with inner quotes doubled.
    assert.ok(lines[1].includes('"{""name"":""Acme, Inc.""}"'));
    assert.ok(res._raw.endsWith('\r\n'));
  });

  test('byOrg filter is locked to path param (cannot escape via ?orgId=)', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1', slug: 'o-one' } },
      auditRows: [
        { id: 'a1', action: 'x', metadata: { orgId: 'o1' } },
        { id: 'a2', action: 'x', metadata: { orgId: 'o2' } },
      ],
    });
    const req = { user: { id: 'admin1' }, params: { id: 'o1' }, query: { orgId: 'o2' } };
    const res = makeRes();
    await exportOrgAuditLogsCsv(req, res, { prisma });
    assert.equal(res._status, 200);
    assert.equal(prisma._auditCalls[0].where.metadata.equals, 'o1');
    // Only row a1 should appear in the CSV body.
    const lines = res._raw.split('\r\n').filter(Boolean);
    assert.equal(lines.length, 2); // header + 1 row
  });

  test('MEMBER role is rejected (403)', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:m1': { role: 'MEMBER' } },
      orgs: { o1: { id: 'o1', slug: 'o' } },
    });
    const req = { user: { id: 'm1' }, params: { id: 'o1' }, query: {} };
    const res = makeRes();
    await exportOrgAuditLogsCsv(req, res, { prisma });
    assert.equal(res._status, 403);
  });

  test('non-member returns 404', async () => {
    const { prisma } = makeFakePrisma({ members: {} });
    const req = { user: { id: 'ghost' }, params: { id: 'o1' }, query: {} };
    const res = makeRes();
    await exportOrgAuditLogsCsv(req, res, { prisma });
    assert.equal(res._status, 404);
  });

  test('default limit is 500 when caller omits ?limit=', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1', slug: 'big' } },
      auditRows: [],
    });
    const req = { user: { id: 'admin1' }, params: { id: 'o1' }, query: {} };
    const res = makeRes();
    await exportOrgAuditLogsCsv(req, res, { prisma });
    assert.equal(res._status, 200);
    assert.equal(prisma._auditCalls[0].take, 500);
  });

  test('honors ?action= and ?limit= filters', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:owner1': { role: 'OWNER' } },
      orgs: { o1: { id: 'o1', slug: 'sira' } },
      auditRows: Array.from({ length: 5 }, (_, i) => ({
        id: `a${i}`,
        action: 'org_invite_create',
        metadata: { orgId: 'o1' },
      })),
    });
    const req = {
      user: { id: 'owner1' },
      params: { id: 'o1' },
      query: { action: 'org_invite_create', limit: '3' },
    };
    const res = makeRes();
    await exportOrgAuditLogsCsv(req, res, { prisma });
    assert.equal(res._status, 200);
    assert.equal(prisma._auditCalls[0].take, 3);
    assert.equal(prisma._auditCalls[0].where.action, 'org_invite_create');
    const lines = res._raw.split('\r\n').filter(Boolean);
    assert.equal(lines.length, 1 + 3); // header + 3 rows
  });

  test('falls back to "org" when org slug is missing', async () => {
    const { prisma } = makeFakePrisma({
      members: { 'o1:admin1': { role: 'ADMIN' } },
      orgs: { o1: { id: 'o1' } }, // no slug field
      auditRows: [],
    });
    const req = { user: { id: 'admin1' }, params: { id: 'o1' }, query: {} };
    const res = makeRes();
    await exportOrgAuditLogsCsv(req, res, { prisma });
    assert.equal(res._status, 200);
    const cd = res._headers['content-disposition'] || '';
    assert.ok(/filename="audit-logs-org-\d+\.csv"/.test(cd), `unexpected CD: ${cd}`);
  });
});

// ── Internal helpers ───────────────────────────────────────────────

describe('INTERNAL_ORG_AUDIT_CSV helpers', () => {
  test('orgAuditCsvEscape passes through plain strings', () => {
    assert.equal(orgAuditCsvEscape('hello'), 'hello');
  });

  test('orgAuditCsvEscape renders null/undefined as empty', () => {
    assert.equal(orgAuditCsvEscape(null), '');
    assert.equal(orgAuditCsvEscape(undefined), '');
  });

  test('orgAuditCsvEscape wraps + escapes commas, quotes, CR, LF', () => {
    assert.equal(orgAuditCsvEscape('a,b'), '"a,b"');
    assert.equal(orgAuditCsvEscape('a"b'), '"a""b"');
    assert.equal(orgAuditCsvEscape('a\nb'), '"a\nb"');
    assert.equal(orgAuditCsvEscape('a\rb'), '"a\rb"');
  });

  test('orgAuditCsvEscape renders Date as ISO string', () => {
    assert.equal(
      orgAuditCsvEscape(new Date('2026-05-18T00:00:00.000Z')),
      '2026-05-18T00:00:00.000Z',
    );
  });

  test('orgAuditCsvEscape serialises objects as JSON (escaped because JSON contains quotes)', () => {
    // JSON.stringify produces quote chars → escape wraps in double quotes
    // with internal quotes doubled, per RFC4180.
    assert.equal(orgAuditCsvEscape({ a: 1 }), '"{""a"":1}"');
    assert.equal(orgAuditCsvEscape({ name: 'a,b' }), '"{""name"":""a,b""}"');
  });

  test('orgAuditLogsToCsv emits header + rows with CRLF and trailing CRLF', () => {
    const out = orgAuditLogsToCsv([
      {
        id: 'a1',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        actorId: 'u',
        actorName: 'A',
        action: 'noop',
        resourceType: 'org',
        resourceId: 'o1',
        ip: '',
        userAgent: '',
        before: null,
        after: null,
        metadata: { orgId: 'o1' },
      },
    ]);
    const lines = out.split('\r\n');
    assert.equal(lines[0], ORG_AUDIT_CSV_COLUMNS.join(','));
    assert.ok(out.endsWith('\r\n'));
  });

  test('orgAuditLogsToCsv handles empty input → header only', () => {
    const out = orgAuditLogsToCsv([]);
    assert.equal(out, ORG_AUDIT_CSV_COLUMNS.join(',') + '\r\n');
  });

  test('orgAuditLogsToCsv tolerates rows missing columns', () => {
    const out = orgAuditLogsToCsv([{ id: 'x', action: 'noop' }]);
    const lines = out.split('\r\n').filter(Boolean);
    assert.equal(lines.length, 2);
  });

  test('sanitizeSlugForFilename strips unsafe chars + defaults to "org"', () => {
    assert.equal(sanitizeSlugForFilename('acme-corp'), 'acme-corp');
    assert.equal(sanitizeSlugForFilename('Acme Corp!'), 'acme-corp');
    assert.equal(sanitizeSlugForFilename(''), 'org');
    assert.equal(sanitizeSlugForFilename(null), 'org');
    assert.equal(sanitizeSlugForFilename(undefined), 'org');
    assert.equal(sanitizeSlugForFilename('---'), 'org');
  });
});
