/**
 * Tests for middleware/agent-access.js — dual-mode auth (JWT or
 * sira_ag_ API key with pairing).
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');
const path = require('node:path');

// ── module mocks ──────────────────────────────────────────────────

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const keysPath = path.resolve(__dirname, '../src/services/agent-access/keys.js');

// Dispatcher pattern: target destructures `authenticateToken` at
// require-time, so the captured reference must stay stable.
// Swap `_authenticateToken` between cases to redirect behavior.
const authMock = {
  _authenticateToken: (req, res, next) => next(),
  authenticateToken: (req, res, next) => authMock._authenticateToken(req, res, next),
};
const keysMock = {
  _authenticate: () => null,
  authenticate: (args) => keysMock._authenticate(args),
};

require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true, exports: authMock,
};
require.cache[keysPath] = {
  id: keysPath, filename: keysPath, loaded: true, exports: keysMock,
};

// Force fresh load of target after mocks are in place.
const targetPath = path.resolve(__dirname, '../src/middleware/agent-access.js');
delete require.cache[targetPath];
const { authenticateAgent, ipOf, userAgentOf } =
  require('../src/middleware/agent-access');

// ── helpers ───────────────────────────────────────────────────────

function makeReq({ authorization = '', ip, socket, userAgent } = {}) {
  return {
    get(name) {
      if (name.toLowerCase() === 'authorization') return authorization;
      if (name.toLowerCase() === 'user-agent') return userAgent;
      return undefined;
    },
    ip,
    socket: socket || { remoteAddress: '' },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

beforeEach(() => {
  authMock._authenticateToken = (req, res, next) => next();
  keysMock._authenticate = () => null;
});

// ── header detection / fall-through ───────────────────────────────

describe('authenticateAgent · header detection', () => {
  it('falls through to authenticateToken when no Authorization header', () => {
    let called = false;
    authMock._authenticateToken = (req, res, next) => { called = true; next(); };
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    authenticateAgent(req, res, () => { nextCalled = true; });
    assert.equal(called, true, 'authenticateToken should be invoked');
    assert.equal(nextCalled, true);
  });

  it('falls through to authenticateToken when header is plain JWT', () => {
    let called = false;
    authMock._authenticateToken = (req, res, next) => { called = true; next(); };
    const req = makeReq({ authorization: 'Bearer eyJabcdef.jwt.payload' });
    const res = makeRes();
    authenticateAgent(req, res, () => {});
    assert.equal(called, true);
  });

  it('falls through to authenticateToken when bearer prefix has different scheme', () => {
    let called = false;
    authMock._authenticateToken = (req, res, next) => { called = true; next(); };
    const req = makeReq({ authorization: 'Basic dXNlcjpwYXNz' });
    const res = makeRes();
    authenticateAgent(req, res, () => {});
    assert.equal(called, true);
  });

  it('intercepts when bearer token is sira_ag_ prefixed (case-insensitive)', () => {
    let intercepted = false;
    keysMock._authenticate = () => { intercepted = true; return null; };
    authMock._authenticateToken = () => assert.fail('should not reach JWT auth');
    const req = makeReq({ authorization: 'Bearer sira_ag_xyz' });
    const res = makeRes();
    authenticateAgent(req, res, () => {});
    assert.equal(intercepted, true);
  });

  it('intercepts uppercase Bearer variant', () => {
    let intercepted = false;
    keysMock._authenticate = () => { intercepted = true; return null; };
    const req = makeReq({ authorization: 'BEARER sira_ag_xyz' });
    const res = makeRes();
    authenticateAgent(req, res, () => {});
    assert.equal(intercepted, true);
  });

  it('does NOT intercept when sira_ag_ appears later in header', () => {
    let intercepted = false;
    keysMock._authenticate = () => { intercepted = true; return null; };
    let jwtCalled = false;
    authMock._authenticateToken = (req, res, next) => { jwtCalled = true; next(); };
    const req = makeReq({ authorization: 'Bearer JWT_sira_ag_inthemiddle' });
    const res = makeRes();
    authenticateAgent(req, res, () => {});
    assert.equal(intercepted, false);
    assert.equal(jwtCalled, true);
  });
});

// ── result codes ──────────────────────────────────────────────────

describe('authenticateAgent · result codes', () => {
  it('null result → 401 malformed agent key', () => {
    keysMock._authenticate = () => null;
    const req = makeReq({ authorization: 'Bearer sira_ag_garbage' });
    const res = makeRes();
    authenticateAgent(req, res, () => assert.fail('next should not run'));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'malformed agent key' });
  });

  it('code=ok → next() with req.user populated', () => {
    keysMock._authenticate = () => ({
      code: 'ok',
      row: { id: 'k1', userId: 'user-123', label: 'My Key', scope: { read: true } },
      principalHash: 'phash-abc',
    });
    const req = makeReq({ authorization: 'Bearer sira_ag_real' });
    const res = makeRes();
    let nextCalled = false;
    authenticateAgent(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.deepEqual(req.user, { id: 'user-123', authMethod: 'agent_key' });
    assert.deepEqual(req.agentKey, {
      id: 'k1',
      label: 'My Key',
      scope: { read: true },
      paired: true,
      principalHash: 'phash-abc',
    });
  });

  it('code=ok does NOT call next when result is incomplete (row missing)', () => {
    keysMock._authenticate = () => ({ code: 'ok', row: null });
    const req = makeReq({ authorization: 'Bearer sira_ag_x' });
    const res = makeRes();
    // Source dereferences result.row.userId — should throw, not silently pass.
    assert.throws(() => authenticateAgent(req, res, () => {}), /Cannot read prop/);
  });

  it('code=pair_required → 428 with pairingCode and instructional message', () => {
    keysMock._authenticate = () => ({
      code: 'pair_required',
      pendingCode: 'PAIR1234',
      row: { id: 'k7' },
    });
    const req = makeReq({ authorization: 'Bearer sira_ag_pending' });
    const res = makeRes();
    authenticateAgent(req, res, () => assert.fail());
    assert.equal(res.statusCode, 428);
    assert.equal(res.body.error, 'pairing_required');
    assert.equal(res.body.pairingCode, 'PAIR1234');
    assert.match(res.body.message, /PAIR1234/);
    assert.match(res.body.message, /\/api\/agent\/keys\/k7\/pair\/PAIR1234/);
  });

  it('code=revoked → 401 key revoked', () => {
    keysMock._authenticate = () => ({ code: 'revoked' });
    const req = makeReq({ authorization: 'Bearer sira_ag_rev' });
    const res = makeRes();
    authenticateAgent(req, res, () => assert.fail());
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'key revoked' });
  });

  it('code=closed → 403 agent API keys disabled', () => {
    keysMock._authenticate = () => ({ code: 'closed' });
    const req = makeReq({ authorization: 'Bearer sira_ag_disabled' });
    const res = makeRes();
    authenticateAgent(req, res, () => assert.fail());
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /agent API keys are disabled/);
    assert.match(res.body.error, /AGENT_DM_POLICY=closed/);
  });

  it('code=unknown_key → 401 invalid', () => {
    keysMock._authenticate = () => ({ code: 'unknown_key' });
    const req = makeReq({ authorization: 'Bearer sira_ag_notfound' });
    const res = makeRes();
    authenticateAgent(req, res, () => assert.fail());
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'invalid agent key' });
  });

  it('code=bad_secret → 401 invalid', () => {
    keysMock._authenticate = () => ({ code: 'bad_secret' });
    const req = makeReq({ authorization: 'Bearer sira_ag_wrong' });
    const res = makeRes();
    authenticateAgent(req, res, () => assert.fail());
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'invalid agent key' });
  });

  it('unrecognised code → falls through to 401 invalid (default)', () => {
    keysMock._authenticate = () => ({ code: 'unknown_future_state' });
    const req = makeReq({ authorization: 'Bearer sira_ag_weird' });
    const res = makeRes();
    authenticateAgent(req, res, () => assert.fail());
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'invalid agent key' });
  });
});

// ── keys.authenticate input ───────────────────────────────────────

describe('authenticateAgent · request annotation', () => {
  it('forwards authHeader, ip and userAgent to keys.authenticate', () => {
    let captured;
    keysMock._authenticate = (args) => {
      captured = args;
      return { code: 'unknown_key' };
    };
    const req = makeReq({
      authorization: 'Bearer sira_ag_some',
      ip: '203.0.113.5',
      userAgent: 'test-agent/1.0',
    });
    const res = makeRes();
    authenticateAgent(req, res, () => {});
    assert.equal(captured.authHeader, 'Bearer sira_ag_some');
    assert.equal(captured.ip, '203.0.113.5');
    assert.equal(captured.userAgent, 'test-agent/1.0');
  });

  it('does NOT set req.user / req.agentKey on failure paths', () => {
    keysMock._authenticate = () => ({ code: 'revoked' });
    const req = makeReq({ authorization: 'Bearer sira_ag_rev' });
    const res = makeRes();
    authenticateAgent(req, res, () => {});
    assert.equal(req.user, undefined);
    assert.equal(req.agentKey, undefined);
  });
});

// ── ipOf ──────────────────────────────────────────────────────────

describe('ipOf', () => {
  it('returns req.ip when set', () => {
    assert.equal(ipOf({ ip: '10.0.0.1' }), '10.0.0.1');
  });

  it('falls back to socket.remoteAddress when req.ip is missing', () => {
    assert.equal(ipOf({ socket: { remoteAddress: '10.0.0.2' } }), '10.0.0.2');
  });

  it('returns empty string when neither is available', () => {
    assert.equal(ipOf({}), '');
  });

  it('handles null socket safely', () => {
    assert.equal(ipOf({ socket: null }), '');
  });

  it('prefers req.ip over socket address', () => {
    assert.equal(ipOf({ ip: '1.1.1.1', socket: { remoteAddress: '2.2.2.2' } }), '1.1.1.1');
  });

  it('returns empty string for falsy req.ip with no socket', () => {
    assert.equal(ipOf({ ip: '' }), '');
  });
});

// ── userAgentOf ───────────────────────────────────────────────────

describe('userAgentOf', () => {
  it('returns the user-agent header value', () => {
    const req = { get: (n) => (n.toLowerCase() === 'user-agent' ? 'Mozilla/5.0' : null) };
    assert.equal(userAgentOf(req), 'Mozilla/5.0');
  });

  it('returns empty string when header is missing', () => {
    const req = { get: () => null };
    assert.equal(userAgentOf(req), '');
  });

  it('coerces non-string headers to string', () => {
    const req = { get: () => 12345 };
    assert.equal(userAgentOf(req), '12345');
  });

  it('truncates UA strings longer than 200 chars', () => {
    const long = 'X'.repeat(300);
    const req = { get: () => long };
    const out = userAgentOf(req);
    assert.equal(out.length, 200);
    assert.equal(out, 'X'.repeat(200));
  });

  it('preserves UA strings exactly 200 chars long', () => {
    const exact = 'X'.repeat(200);
    const req = { get: () => exact };
    assert.equal(userAgentOf(req).length, 200);
  });

  it('preserves UA strings shorter than 200 chars', () => {
    const req = { get: () => 'short-agent' };
    assert.equal(userAgentOf(req), 'short-agent');
  });
});

// ── module surface ────────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/middleware/agent-access');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['authenticateAgent', 'ipOf', 'userAgentOf']);
  });
});
