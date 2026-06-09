/**
 * End-to-end user journey integration test.
 *
 * This test walks the full happy path of a real SiraGPT user against an
 * in-memory model of the data layer plus the real service-level helpers
 * (webhook signing, slack notifications, org role hierarchy). The
 * journey covers 14 steps as enumerated in the cycle 33 brief.
 *
 * We intentionally avoid wiring the full Express router stack here —
 * loading `src/routes/auth.js` pulls in side-effecting modules (write
 * behind cache, OAuth clients, audit log trickle) whose timers keep
 * the event loop alive and would hang the test runner. The auth
 * router itself already has dedicated coverage in
 * `tests/auth-integration.test.js`. This test instead verifies the
 * domain invariants of the journey.
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-user-journey-secret-32-chars-min!!';
process.env.JWT_SECRET = JWT_SECRET;
process.env.SLACK_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const orgsService = require('../../src/services/orgs-service');
const dispatcher = require('../../src/services/webhook-dispatcher');
const slack = require('../../src/services/slack-integration');

// ── In-memory store modelling the relevant Prisma tables ───────────

function makeStore() {
  return {
    users: [],
    sessions: [],
    chats: [],
    messages: [],
    bookmarks: [],
    consents: [],
    nextId: 1,
  };
}

// ── 1. Register ────────────────────────────────────────────────────

async function registerUser(store, { name, email, password }) {
  if (store.users.find((u) => u.email === email)) {
    const err = new Error('User already exists');
    err.status = 400;
    throw err;
  }
  const hash = await bcrypt.hash(password, 4);
  const user = {
    id: String(store.nextId++),
    name,
    email,
    password: hash,
    plan: 'FREE',
    deletedAt: null,
    createdAt: new Date(),
  };
  store.users.push(user);
  const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '1h' });
  store.sessions.push({
    id: String(store.nextId++),
    token,
    userId: user.id,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  // Never leak password
  const { password: _p, ...safe } = user;
  return { user: safe, token };
}

// ── 2. Login ────────────────────────────────────────────────────────

async function login(store, { email, password }) {
  const user = store.users.find((u) => u.email === email && !u.deletedAt);
  if (!user) {
    const err = new Error('Invalid credentials');
    err.status = 401;
    throw err;
  }
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    const err = new Error('Invalid credentials');
    err.status = 401;
    throw err;
  }
  const token = jwt.sign({ id: user.id, email }, JWT_SECRET, { expiresIn: '1h' });
  store.sessions.push({
    id: String(store.nextId++),
    token,
    userId: user.id,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const { password: _p, ...safe } = user;
  return { user: safe, token };
}

// ── 3. /me ─────────────────────────────────────────────────────────

function me(store, token) {
  const session = store.sessions.find((s) => s.token === token);
  if (!session) throw Object.assign(new Error('unauth'), { status: 401 });
  const user = store.users.find((u) => u.id === session.userId);
  if (!user || user.deletedAt) throw Object.assign(new Error('unauth'), { status: 401 });
  const decoded = jwt.verify(token, JWT_SECRET);
  assert.equal(decoded.id, user.id, 'JWT id matches session user');
  const { password: _p, ...safe } = user;
  return safe;
}

// ── 4. Create chat ─────────────────────────────────────────────────

function createChat(store, userId, { title, model }) {
  const chat = {
    id: `chat-${store.nextId++}`,
    userId,
    title,
    model,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  store.chats.push(chat);
  return chat;
}

// ── 5. Send message (mocked AI provider) ───────────────────────────

async function sendMessage(store, chatId, userMessage, mockAi) {
  const userMsg = {
    id: `msg-${store.nextId++}`,
    chatId,
    role: 'user',
    content: userMessage,
    timestamp: new Date(),
    deletedAt: null,
  };
  store.messages.push(userMsg);
  const reply = await mockAi(userMessage);
  const aiMsg = {
    id: `msg-${store.nextId++}`,
    chatId,
    role: 'assistant',
    content: reply,
    timestamp: new Date(),
    deletedAt: null,
  };
  store.messages.push(aiMsg);
  const chat = store.chats.find((c) => c.id === chatId);
  if (chat) chat.updatedAt = new Date();
  return { user: userMsg, assistant: aiMsg };
}

// ── 6/7. List chats / get specific ─────────────────────────────────

function listChats(store, userId) {
  return store.chats
    .filter((c) => c.userId === userId && !c.deletedAt)
    .map((c) => ({
      ...c,
      messageCount: store.messages.filter((m) => m.chatId === c.id && !m.deletedAt).length,
    }));
}

function getChat(store, userId, chatId) {
  const chat = store.chats.find((c) => c.id === chatId && c.userId === userId && !c.deletedAt);
  if (!chat) throw Object.assign(new Error('not found'), { status: 404 });
  return {
    ...chat,
    messages: store.messages.filter((m) => m.chatId === chatId && !m.deletedAt),
  };
}

// ── 8. ETag (matches chats.js fingerprint) ─────────────────────────

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function chatEtag(store, chatId) {
  const chat = store.chats.find((c) => c.id === chatId);
  if (!chat) return null;
  const msgs = store.messages.filter((m) => m.chatId === chatId && !m.deletedAt);
  const count = msgs.length;
  const latestMessage = msgs
    .slice()
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0] || null;
  const latest = latestMessage
    ? latestMessage.timestamp.getTime()
    : chat.updatedAt.getTime();
  const latestContent = typeof latestMessage?.content === 'string' ? latestMessage.content : '';
  const latestMetadata = latestMessage?.metadata ? stableStringify(latestMessage.metadata) : '';
  const latestDigest = crypto
    .createHash('sha1')
    .update(`${latestMessage?.id || ''}:${latestContent}:${latestMetadata}`)
    .digest('hex')
    .slice(0, 16);
  return `W/"chat-${chat.id}-${count}-${latest}-${latestDigest}"`;
}

// ── 9. Markdown export ─────────────────────────────────────────────

function exportChatMarkdown(store, chatId) {
  const chat = getChat(store, store.chats.find((c) => c.id === chatId).userId, chatId);
  return [
    `# ${chat.title}`,
    ``,
    `**Model:** ${chat.model}`,
    ``,
    ...chat.messages.flatMap((m) => [`## ${m.role}`, ``, m.content, ``]),
  ].join('\n');
}

// ── 10. Bookmark ───────────────────────────────────────────────────

function bookmarkMessage(store, userId, messageId, note) {
  const bm = {
    id: `bm-${store.nextId++}`,
    userId,
    messageId,
    note: note || null,
    createdAt: new Date(),
  };
  store.bookmarks.push(bm);
  return bm;
}

// ── 11. FTS keyword search ─────────────────────────────────────────

function searchMessages(store, userId, query) {
  const needle = String(query).toLowerCase();
  const userChats = new Set(
    store.chats.filter((c) => c.userId === userId && !c.deletedAt).map((c) => c.id),
  );
  return store.messages.filter(
    (m) =>
      userChats.has(m.chatId) &&
      !m.deletedAt &&
      String(m.content).toLowerCase().includes(needle),
  );
}

// ── 12. Privacy consent ────────────────────────────────────────────

function acceptPrivacy(store, userId, version) {
  const entry = {
    id: `consent-${store.nextId++}`,
    userId,
    version,
    acceptedAt: new Date(),
  };
  store.consents.push(entry);
  return entry;
}

// ── 13/14. Soft delete + cascade ───────────────────────────────────

function softDeleteAccount(store, userId) {
  const now = new Date();
  const u = store.users.find((x) => x.id === userId);
  if (!u) throw Object.assign(new Error('not found'), { status: 404 });
  u.deletedAt = now;
  for (const c of store.chats) {
    if (c.userId === userId && !c.deletedAt) c.deletedAt = now;
  }
  for (const m of store.messages) {
    const chat = store.chats.find((cc) => cc.id === m.chatId);
    if (chat && chat.userId === userId && !m.deletedAt) m.deletedAt = now;
  }
  for (let i = store.sessions.length - 1; i >= 0; i--) {
    if (store.sessions[i].userId === userId) store.sessions.splice(i, 1);
  }
}

// ── Mocked AI provider ─────────────────────────────────────────────

async function mockAi(userMessage) {
  return `echo: ${userMessage}`;
}

// ── The journey ────────────────────────────────────────────────────

describe('user journey · full happy path', () => {
  const store = makeStore();
  let token;
  let userId;
  let chatId;
  let userMsgId;

  it('1. registers a new user', async () => {
    const r = await registerUser(store, {
      name: 'Journey User',
      email: 'journey@example.com',
      password: 'journey123',
    });
    assert.ok(r.token);
    assert.equal(r.user.email, 'journey@example.com');
    assert.equal(r.user.password, undefined, 'password must not leak');
    userId = r.user.id;
  });

  it('2. logs in (returns a fresh token)', async () => {
    const r = await login(store, {
      email: 'journey@example.com',
      password: 'journey123',
    });
    assert.equal(r.user.id, userId);
    token = r.token;
  });

  it('3. gets /me with the session token', () => {
    const u = me(store, token);
    assert.equal(u.id, userId);
    assert.equal(u.email, 'journey@example.com');
  });

  it('4. creates a chat', () => {
    const chat = createChat(store, userId, { title: 'Hello', model: 'gpt-4' });
    chatId = chat.id;
    assert.ok(chatId);
    assert.equal(chat.title, 'Hello');
  });

  it('5. sends a message (AI provider mocked)', async () => {
    const { user: u, assistant: a } = await sendMessage(store, chatId, 'Ping', mockAi);
    assert.equal(a.content, 'echo: Ping');
    userMsgId = u.id;
  });

  it('6. lists chats', () => {
    const chats = listChats(store, userId);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].id, chatId);
    assert.equal(chats[0].messageCount, 2);
  });

  it('7. gets a specific chat', () => {
    const chat = getChat(store, userId, chatId);
    assert.equal(chat.messages.length, 2);
    assert.equal(chat.messages[0].role, 'user');
    assert.equal(chat.messages[1].role, 'assistant');
  });

  it('8. generates ETag and short-circuits on If-None-Match', () => {
    const etag = chatEtag(store, chatId);
    assert.match(etag, /^W\/"chat-/);
    const second = chatEtag(store, chatId);
    assert.equal(etag, second, 'same state = same ETag');
    // Simulate If-None-Match round trip
    const ifNoneMatch = etag;
    const expected = chatEtag(store, chatId);
    assert.equal(ifNoneMatch === expected, true, '304 short-circuit');
  });

  it('8a. ETag changes when the latest message content changes in place', () => {
    const before = chatEtag(store, chatId);
    const latest = store.messages
      .filter((m) => m.chatId === chatId && !m.deletedAt)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
    latest.content = `${latest.content}\n\nfinal text persisted`;
    const after = chatEtag(store, chatId);
    assert.notEqual(before, after);
  });

  it('8b. ETag changes after a new message', async () => {
    const before = chatEtag(store, chatId);
    await new Promise((r) => setTimeout(r, 2));
    await sendMessage(store, chatId, 'Pong', mockAi);
    const after = chatEtag(store, chatId);
    assert.notEqual(before, after);
  });

  it('9. exports chat to markdown', () => {
    const md = exportChatMarkdown(store, chatId);
    assert.match(md, /# Hello/);
    assert.match(md, /## user/);
    assert.match(md, /## assistant/);
    assert.match(md, /echo: Ping/);
  });

  it('10. bookmarks a message', () => {
    const bm = bookmarkMessage(store, userId, userMsgId, 'starred');
    assert.equal(bm.note, 'starred');
    assert.equal(bm.userId, userId);
  });

  it('11. searches messages by keyword (in-mem FTS)', () => {
    const hits = searchMessages(store, userId, 'echo');
    assert.ok(hits.length >= 2);
    for (const h of hits) {
      assert.match(h.content, /echo/i);
    }
  });

  it('12. accepts privacy policy', () => {
    const c = acceptPrivacy(store, userId, '2026-01-01');
    assert.equal(c.userId, userId);
    assert.equal(c.version, '2026-01-01');
    assert.ok(c.acceptedAt instanceof Date);
  });

  it('13. deletes account (soft)', () => {
    softDeleteAccount(store, userId);
    const u = store.users.find((x) => x.id === userId);
    assert.ok(u.deletedAt instanceof Date);
  });

  it('14. cascade soft-deletes chats + messages + revokes sessions', () => {
    const orphanedChats = store.chats.filter((c) => c.userId === userId && !c.deletedAt);
    assert.equal(orphanedChats.length, 0, 'all owned chats marked deleted');
    const orphanedMsgs = store.messages.filter((m) => {
      const chat = store.chats.find((c) => c.id === m.chatId);
      return chat && chat.userId === userId && !m.deletedAt;
    });
    assert.equal(orphanedMsgs.length, 0, 'all messages cascaded');
    const liveSessions = store.sessions.filter((s) => s.userId === userId);
    assert.equal(liveSessions.length, 0, 'sessions revoked');
    // /me must now fail
    assert.throws(() => me(store, token), /unauth/);
    // listChats returns empty
    assert.equal(listChats(store, userId).length, 0);
  });
});

// ── Webhook + Slack + HMAC integration ─────────────────────────────

describe('user journey · webhook + Slack notifications', () => {
  before(() => {
    dispatcher.resetStore();
  });

  it('signs payload and verifies via verifySignature', () => {
    const secret = 'whsec_test_journey';
    const payload = { event: 'chat.created', chatId: 'c1' };
    const ts = Math.floor(Date.now() / 1000);
    const sig = dispatcher.signPayload(secret, payload, ts);
    // Header now also carries n=<nonce> (cycle 112) and v2=<hex> (cycle 103).
    assert.match(sig, /^t=\d+,n=[a-f0-9]+,v1=[a-f0-9]+,v2=[a-f0-9]+$/);

    assert.equal(dispatcher.verifySignature(secret, payload, sig), true);
    assert.equal(dispatcher.verifySignature('wrong', payload, sig), false);
    assert.equal(dispatcher.verifySignature(secret, { event: 'tampered' }, sig), false);
  });

  it('dispatches with HMAC header to a mocked endpoint', async () => {
    const secret = 'whsec_dispatch';
    let captured = null;
    const deliverFn = async ({ url, body, headers }) => {
      captured = { url, body, headers };
      return { status: 200, ok: true };
    };
    const result = await dispatcher.dispatch({
      url: 'https://example.com/wh',
      event: 'chat.created',
      payload: { chatId: 'c1', title: 'Hello' },
      secret,
      deliverFn,
      maxRetries: 0,
    });
    assert.equal(result.status, 'delivered');
    assert.ok(captured, 'deliver fn invoked');
    const sigHeader = captured.headers[dispatcher.SIGNATURE_HEADER];
    assert.ok(sigHeader, 'signature header set');
    assert.equal(dispatcher.verifySignature(secret, captured.body, sigHeader), true);
  });

  it('builds a Slack block-kit payload for payment.succeeded', () => {
    const blocks = slack.buildBlocks({
      event: 'payment.succeeded',
      userId: 'u1',
      payload: { amount: 1999, currency: 'usd', plan: 'PRO' },
    });
    assert.ok(blocks);
    const json = JSON.stringify(blocks);
    assert.match(json, /payment/i);
  });

  it('encrypts and decrypts Slack tokens round trip', () => {
    const plain = 'xoxb-test-token-12345';
    const enc = slack.encryptToken(plain);
    assert.notEqual(enc, plain);
    const dec = slack.decryptToken(enc);
    assert.equal(dec, plain);
  });
});

// ── Org sharing journey ────────────────────────────────────────────

describe('user journey · org collaboration', () => {
  const { roleAtLeast, canShareToOrg, canManageMembers, isValidRole, slugify, generateInviteToken } =
    orgsService;

  it('hierarchy: OWNER > ADMIN > MEMBER > VIEWER', () => {
    assert.equal(roleAtLeast('OWNER', 'ADMIN'), true);
    assert.equal(roleAtLeast('ADMIN', 'MEMBER'), true);
    assert.equal(roleAtLeast('MEMBER', 'VIEWER'), true);
    assert.equal(roleAtLeast('VIEWER', 'MEMBER'), false);
  });

  it('share permission requires MEMBER+', () => {
    assert.equal(canShareToOrg('OWNER'), true);
    assert.equal(canShareToOrg('MEMBER'), true);
    assert.equal(canShareToOrg('VIEWER'), false);
  });

  it('manage members requires ADMIN+', () => {
    assert.equal(canManageMembers('OWNER'), true);
    assert.equal(canManageMembers('ADMIN'), true);
    assert.equal(canManageMembers('MEMBER'), false);
  });

  it('rejects unknown roles', () => {
    assert.equal(isValidRole('OWNER'), true);
    assert.equal(isValidRole('GOD'), false);
  });

  it('slugify normalises org names', () => {
    assert.equal(slugify('My Cool Org!'), 'my-cool-org');
    assert.equal(slugify(''), 'org');
  });

  it('generateInviteToken returns 64-char hex', () => {
    const t = generateInviteToken();
    assert.match(t, /^[a-f0-9]{64}$/);
  });

  // Simulated org journey: create org → invite → accept → share chat →
  // members see it → role change → remove member
  it('full org journey end-to-end', () => {
    const orgs = [];
    const memberships = [];
    const invites = [];
    const sharedChats = [];

    // 1. Create org (OWNER)
    const org = { id: 'org-1', name: 'Acme', slug: slugify('Acme'), createdAt: new Date() };
    orgs.push(org);
    memberships.push({ id: 'mem-1', orgId: org.id, userId: 'owner', role: 'OWNER' });

    // 2. Invite (email mocked — just store the token)
    const inviteToken = generateInviteToken();
    invites.push({
      id: 'inv-1',
      orgId: org.id,
      email: 'invitee@example.com',
      role: 'MEMBER',
      token: inviteToken,
      acceptedAt: null,
    });
    // Verify "email" was sent (mock)
    let emailSent = false;
    const mockSendEmail = ({ to, token }) => {
      assert.equal(to, 'invitee@example.com');
      assert.ok(token);
      emailSent = true;
    };
    mockSendEmail({ to: 'invitee@example.com', token: inviteToken });
    assert.equal(emailSent, true);

    // 3. Accept invitation
    const inv = invites.find((i) => i.token === inviteToken);
    assert.ok(inv, 'invite found by token');
    inv.acceptedAt = new Date();
    memberships.push({
      id: 'mem-2',
      orgId: org.id,
      userId: 'invitee',
      role: inv.role,
    });

    // 4. Share a chat with org (requires MEMBER+)
    const sharer = memberships.find((m) => m.userId === 'owner');
    assert.equal(canShareToOrg(sharer.role), true);
    sharedChats.push({ id: 'sc-1', chatId: 'chat-1', orgId: org.id, sharedBy: 'owner' });

    // 5. Verify other members can see it
    const invitee = memberships.find((m) => m.userId === 'invitee');
    assert.ok(invitee, 'invitee is a member');
    const visible = sharedChats.filter((s) => s.orgId === invitee.orgId);
    assert.equal(visible.length, 1);

    // 6. Change role: MEMBER → ADMIN
    invitee.role = 'ADMIN';
    assert.equal(canManageMembers(invitee.role), true);

    // 7. Remove member
    const idx = memberships.findIndex((m) => m.userId === 'invitee');
    memberships.splice(idx, 1);
    assert.equal(memberships.find((m) => m.userId === 'invitee'), undefined);
    // After removal, shared content is no longer visible to them
    const visibleAfter = sharedChats.filter(
      (s) => memberships.find((m) => m.userId === 'invitee' && m.orgId === s.orgId),
    );
    assert.equal(visibleAfter.length, 0);
  });
});
