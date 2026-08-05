'use strict';

/**
 * Security regressions for two `backend/src/routes/ai.js` findings:
 *
 *  1. `POST /createVisualizeChart` was unauthenticated dead code that spun up
 *     an OpenAI Assistant + thread + run per ANONYMOUS request (token spend /
 *     DoS + a leaked Assistant object). It has been removed entirely.
 *
 *  2. `POST /stop-stream` aborted ANY user's stream because the streamId (a
 *     client-supplied string) keyed a process-global `streamControllers` Map
 *     with no ownership check. streamId is now namespaced by `req.user.id` at
 *     every set/get/delete site, so:
 *       - user B cannot abort user A's stream (cross-tenant abort), and
 *       - user B's /generate with the same streamId cannot overwrite user A's
 *         controller entry (key collision).
 *
 * The generate route is ~9k lines and pulls in Prisma + dozens of services,
 * so — like `ai-route-gateway-migration.test.js` and
 * `ai-generate-chat-idor-guard.test.js` — we assert the wiring on the source.
 * The ownership *behaviour* is proven separately against a faithful
 * re-implementation of the namespaced-map + handler semantics.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROUTE_PATH = path.join(__dirname, '..', 'src', 'routes', 'ai.js');
const src = fs.readFileSync(ROUTE_PATH, 'utf8');

// ── Finding 1: unauthenticated createVisualizeChart is gone ────────────────

test('POST /createVisualizeChart dead route is removed', () => {
  assert.doesNotMatch(
    src,
    /router\.post\(\s*["']\/createVisualizeChart["']/,
    'the unauthenticated createVisualizeChart handler must not exist',
  );
  // And no residual OpenAI Assistants-API usage from that handler.
  assert.doesNotMatch(
    src,
    /beta\.assistants\.create/,
    'removing the route must also remove the per-request Assistant creation',
  );
});

// ── Finding 2: stop-stream + generate namespace the map by user id ─────────

test('stop-stream handler is authenticated and namespaces the map by user id', () => {
  const idx = src.indexOf("router.post('/stop-stream'");
  assert.ok(idx > -1, '/stop-stream route must exist');
  const block = src.slice(idx, idx + 900);

  assert.match(
    block,
    /router\.post\('\/stop-stream',\s*authenticateToken,/,
    '/stop-stream must run authenticateToken',
  );
  // Ownership: the lookup + delete key must include req.user.id, not a bare streamId.
  assert.match(
    block,
    /streamControllers\.get\(`\$\{req\.user\.id\}:\$\{streamId\}`\)/,
    'stop-stream must look up the controller under the caller-namespaced key',
  );
  assert.match(
    block,
    /streamControllers\.delete\(`\$\{req\.user\.id\}:\$\{streamId\}`\)/,
    'stop-stream must delete under the caller-namespaced key',
  );
  // No un-namespaced access remains anywhere in the file.
  assert.doesNotMatch(
    src,
    /streamControllers\.(get|set|delete)\(\s*streamId\s*[,)]/,
    'no streamControllers access may key on a bare (un-namespaced) streamId',
  );
});

test('generate registers/unregisters controllers under the namespaced key', () => {
  assert.match(
    src,
    /__streamControllerKey\s*=\s*`\$\{req\.user\.id\}:\$\{streamId\}`/,
    'main generate path must construct a caller-namespaced key',
  );
  assert.match(
    src,
    /__ownsStreamController\s*=\s*claimStreamController\([\s\S]{0,180}streamControllers,[\s\S]{0,80}__streamControllerKey,[\s\S]{0,80}controller/,
    'main generate path must claim the namespaced key without replacing an owner',
  );
  assert.match(
    src,
    /streamControllers\.get\(__streamControllerKey\)\s*===\s*controller[\s\S]*streamControllers\.delete\(__streamControllerKey\)/,
    'main generate path may only unregister its own controller',
  );
  assert.match(
    src,
    /streamControllers\.set\(`\$\{req\.user\.id\}:\$\{streamId\}`,\s*controller\)/,
    'secondary generate path must register with the caller-namespaced key',
  );
});

// ── Finding 3: URL grounding must stay read-only ───────────────────────────

test('public-web grounding returns through an isolated context-free stream', () => {
  assert.match(
    src,
    /body\('enableWebGrounding'\)\.optional\(\)\.isBoolean\(\)/,
    'the explicit web-grounding flag must be validated',
  );
  assert.match(
    src,
    /__publicWebReadonly\s*&&\s*\(chatId\s*\|\|\s*\(Array\.isArray\(files\)/,
    'read-only web grounding must reject chat history and private attachments',
  );
  assert.match(
    src,
    /__publicWebReadonly\s*&&\s*!__publicWebQuery/,
    'read-only web grounding must require a separate current-message query',
  );
  assert.match(
    src,
    /__publicWebReadonly\s*&&\s*\(typeof streamId\s*!==\s*'string'/,
    'read-only web grounding must require the stable stream id used for retry dedupe',
  );

  const branchStart = src.indexOf('// ── Public web read-only turn: isolated early-return path');
  const privatePrefetch = src.indexOf('// ── Parallel prefetch: chat context + user profile + org settings', branchStart);
  assert.ok(branchStart > -1 && privatePrefetch > branchStart, 'isolated branch must precede private prefetch');
  const branch = src.slice(branchStart, privatePrefetch);

  assert.match(branch, /enrichWithWebSearch\(__publicWebQuery,/);
  assert.match(
    src,
    /publicWebTurnDedupe\.acquire\(\{[\s\S]*?userId,[\s\S]*?streamId,[\s\S]*?query:\s*__publicWebQuery/,
    'full-turn retry dedupe must bind the authenticated user, stream and current query',
  );
  assert.match(branch, /chatId:\s*null/);
  assert.match(branch, /files:\s*\[\]/);
  assert.match(branch, /qualityGuard:\s*false/);
  assert.match(branch, /scrubPublicWebResponse\(fullResponseContent/);
  assert.match(branch, /try\s*\{\s*res\.write\('data: \[DONE\]/);
  assert.match(branch, /\n\s*return;\s*\n\s*}/);
  assert.doesNotMatch(branch, /activeMemory|userProfile|attributionSuite|saliencyTracker|ciraEngine|CREATE_DOCUMENT:/);

  assert.match(
    src,
    /if\s*\(!__publicWebReadonly\)\s*\{\s*req\._filterCtx\s*=/,
    'memory-capable pre/post filters must not run in the isolated branch',
  );
  assert.match(
    src,
    /if\s*\(userId\s*&&\s*!__publicWebReadonly\s*&&\s*typeof prompt === 'string'\s*&&\s*fullResponseContent\)/,
    'untrusted web output must not be extracted into durable memory/profile state',
  );
  assert.match(
    src,
    /if\s*\(isAuth\s*&&\s*!__publicWebReadonly\)\s*\{\s*\/\/ Tolerant CREATE_DOCUMENT matcher/,
    'untrusted web output must not reach CREATE_DOCUMENT or file persistence',
  );
});

// ── Behavioural proof of the namespaced-map ownership semantics ────────────
//
// Mirror of the handler: a bare streamId keyed the map globally; namespacing
// with `${userId}:${streamId}` isolates users.

function makeStopStreamHandler(streamControllers) {
  // Faithful reproduction of the /stop-stream body (post-fix).
  return function stopStream(req, res) {
    const { streamId } = req.body;
    if (!streamId) return res.status(400).json({ error: 'streamId is required' });
    const controller = streamControllers.get(`${req.user.id}:${streamId}`);
    if (controller) {
      controller.abort();
      streamControllers.delete(`${req.user.id}:${streamId}`);
      return res.status(200).json({ message: 'Stop signal sent.', stopped: true });
    }
    return res.status(200).json({
      message: 'Stream not found or already finished.',
      stopped: false,
      alreadyFinished: true,
    });
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('user B cannot abort user A\'s stream (cross-tenant)', () => {
  const streamControllers = new Map();
  const stop = makeStopStreamHandler(streamControllers);

  const streamId = 'shared-stream-id';
  const controllerA = new AbortController();
  // user A registers under the namespaced key (as the generate route now does).
  streamControllers.set(`userA:${streamId}`, controllerA);

  // user B tries to stop the SAME streamId.
  const resB = fakeRes();
  stop({ user: { id: 'userB' }, body: { streamId } }, resB);

  assert.equal(resB.statusCode, 200);
  assert.equal(resB.body.stopped, false, 'non-owner stop must report stopped:false');
  assert.equal(controllerA.signal.aborted, false, 'user A stream must NOT be aborted by user B');

  // user A stops their own stream → actually aborts.
  const resA = fakeRes();
  stop({ user: { id: 'userA' }, body: { streamId } }, resA);
  assert.equal(resA.body.stopped, true);
  assert.equal(controllerA.signal.aborted, true, 'owner stop must abort their stream');
});

test('same streamId from two users does not collide/overwrite', () => {
  const streamControllers = new Map();
  const streamId = 'dup';
  const controllerA = new AbortController();
  const controllerB = new AbortController();

  // Both users register with the same client-supplied streamId.
  streamControllers.set(`userA:${streamId}`, controllerA);
  streamControllers.set(`userB:${streamId}`, controllerB);

  // Distinct entries — B's registration did not clobber A's.
  assert.equal(streamControllers.size, 2);
  assert.strictEqual(streamControllers.get(`userA:${streamId}`), controllerA);
  assert.strictEqual(streamControllers.get(`userB:${streamId}`), controllerB);
});
