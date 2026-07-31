'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const actions = require('../src/services/codex/company-operations/external-actions');

const root = path.resolve(__dirname, '..');

test('Gmail chat connector never auto-approves mutating tools', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/ai.js'), 'utf8');
  assert.doesNotMatch(source, /require_approval:\s*["']never["']/);
  assert.match(source, /require_approval:\s*\{\s*always:\s*\{\s*read_only:\s*false\s*\}\s*\}/);
  assert.match(source, /mcp_approval_request/);
  assert.match(source, /findGmailMutationToolCall\(resp\)/);
  assert.match(source, /return !GMAIL_READ_ONLY_MCP_TOOLS\.has\(name\)/);
});
test('legacy Gmail send/reply/forward routes cannot call the provider directly', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/gmail.js'), 'utf8');
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_send'\)/);
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_reply'\)/);
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_forward'\)/);
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_delete'\)/);
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_mark'\)/);
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_star'\)/);
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_archive'\)/);
  assert.doesNotMatch(source, /gmailService\.sendEmail\s*\(/);
  assert.doesNotMatch(source, /gmailService\.replyToEmail\s*\(/);
  assert.doesNotMatch(source, /gmailService\.(deleteEmail|markEmail|starEmail|archiveEmail)\s*\(/);
});

test('email actions are always pending review with a stable hash/version and idempotency', async () => {
  let created = null;
  const prisma = {
    codexExternalAction: {
      findUnique: async () => created,
      create: async ({ data }) => {
        created = { id: 'action-1', ...data };
        return created;
      },
    },
  };
  const project = { id: 'project-1', userId: 'user-1' };
  const first = await actions.ensureExternalAction({
    prisma,
    project,
    kind: 'email_send',
    targetRef: 'recipient-1',
    status: 'approved',
    payload: { to: 'client@example.com', subject: 'Hola', body: 'Borrador' },
  });
  const second = await actions.ensureExternalAction({
    prisma,
    project,
    kind: 'email_send',
    targetRef: 'recipient-1',
    status: 'approved',
    payload: { to: 'client@example.com', subject: 'Hola', body: 'Borrador' },
  });

  assert.equal(first.record.status, 'pending_review');
  assert.equal(second.created, false);
  assert.equal(second.record.id, first.record.id);
  assert.equal(first.record.payload._approval.mode, 'pending_review');
  assert.equal(first.record.payload._approval.version, actions.ACTION_VERSION);
  assert.match(first.record.payload._approval.actionHash, /^[a-f0-9]{64}$/);
  assert.match(first.record.payload._approval.expiresAt, /T/);
  assert.equal(first.record.attemptId, 'attempt-1');
  assert.match(first.record.idempotencyKey, /^[a-f0-9]{64}$/);
});

test('email idempotency separates payloads while preserving the same draft action', async () => {
  const records = [];
  const prisma = {
    codexExternalAction: {
      findUnique: async ({ where }) => records.find((row) => row.idempotencyKey === where.idempotencyKey) || null,
      create: async ({ data }) => {
        const row = { id: `action-${records.length + 1}`, ...data };
        records.push(row);
        return row;
      },
    },
  };
  const project = { id: 'project-1', userId: 'user-1' };
  const first = await actions.ensureExternalAction({
    prisma, project, kind: 'email_send', targetRef: 'recipient-1',
    payload: { to: 'client@example.com', subject: 'Uno', body: 'Mensaje uno' },
  });
  const same = await actions.ensureExternalAction({
    prisma, project, kind: 'email_send', targetRef: 'recipient-1',
    payload: { to: 'client@example.com', subject: 'Uno', body: 'Mensaje uno', providerDraftId: 'draft-new' },
  });
  const different = await actions.ensureExternalAction({
    prisma, project, kind: 'email_send', targetRef: 'recipient-1',
    payload: { to: 'client@example.com', subject: 'Dos', body: 'Mensaje dos' },
  });
  assert.equal(same.created, false);
  assert.equal(same.record.id, first.record.id);
  assert.equal(different.created, true);
  assert.equal(records.length, 2);
});

test('approval rejects expired records before any provider call', async () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const payload = { to: 'client@example.com', subject: 'Hola', body: 'Borrador' };
  const action = {
    id: 'expired-1', projectId: 'project-1', userId: 'user-1', kind: 'email_send',
    targetRef: 'recipient-1', status: 'pending_review', attemptId: 'attempt-1',
    expiresAt: new Date(now.getTime() - 1000), consumedAt: null, revokedAt: null,
    payload: { ...payload },
  };
  action.payload._approval = {
    version: actions.ACTION_VERSION,
    actionHash: actions.actionHash(action),
    mode: 'pending_review', actorId: null, attemptId: action.attemptId,
  };
  const prisma = {
    codexExternalAction: {
      findFirst: async () => action,
      update: async ({ data }) => Object.assign(action, data),
    },
  };
  let loads = 0;
  const result = await actions.approveExternalAction({
    prisma, project: { id: 'project-1', userId: 'user-1' }, actionId: action.id,
    actionHash: action.payload._approval.actionHash, actionVersion: 1, actorId: 'user-1',
    gmailLoader: async () => { loads += 1; return { client: {} }; }, now: () => now,
  });
  assert.equal(result.action, 'approval_expired');
  assert.equal(action.status, 'expired');
  assert.equal(loads, 0);
});

test('human approval gate binds email output to actor, version, and content hash', () => {
  const pending = {
    kind: 'email_reply',
    targetRef: 'message-1',
    payload: {
      messageId: 'message-1',
      body: 'Respuesta exacta',
    },
  };
  const hash = actions.actionHash(pending);
  const approved = {
    ...pending,
    payload: {
      ...pending.payload,
      _approval: {
        mode: 'human',
        actorId: 'human-1',
        version: actions.ACTION_VERSION,
        actionHash: hash,
      },
    },
  };

  assert.equal(actions.humanApprovalForAction({
    kind: approved.kind,
    action: approved,
    actorId: 'human-1',
  }).allowed, true);
  assert.equal(actions.humanApprovalForAction({
    kind: approved.kind,
    action: approved,
    actorId: 'different-human',
  }).allowed, false);
  assert.equal(actions.humanApprovalForAction({
    kind: approved.kind,
    action: {
      ...approved,
      payload: { ...approved.payload, body: 'contenido cambiado' },
    },
    actorId: 'human-1',
  }).allowed, false);
  assert.notEqual(
    actions.actionHash({ ...pending, payload: { ...pending.payload, providerDraftId: 'draft-a' } }),
    actions.actionHash({ ...pending, payload: { ...pending.payload, providerDraftId: 'draft-b' } }),
  );
});
