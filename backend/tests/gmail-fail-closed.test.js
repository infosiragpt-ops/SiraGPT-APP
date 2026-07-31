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
});
test('legacy Gmail send/reply/forward routes cannot call the provider directly', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/gmail.js'), 'utf8');
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_send'\)/);
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_reply'\)/);
  assert.match(source, /rejectDirectGmailMutation\(req, res, 'email_forward'\)/);
  assert.doesNotMatch(source, /gmailService\.sendEmail\s*\(/);
  assert.doesNotMatch(source, /gmailService\.replyToEmail\s*\(/);
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
  assert.match(first.record.idempotencyKey, /^[a-f0-9]{64}$/);
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
});
