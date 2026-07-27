'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const inbox = require('../src/services/codex/company-operations/inbox-triage');

function fakePrisma() {
  const state = { items: [], actions: [], drafts: 0 };
  return {
    state,
    codexCompanyInboxItem: {
      upsert: async ({ where, create, update }) => {
        const key = where.projectId_provider_externalId;
        let row = state.items.find(
          (item) => item.projectId === key.projectId
            && item.provider === key.provider
            && item.externalId === key.externalId,
        );
        if (row) Object.assign(row, update);
        else {
          row = { id: `item-${state.items.length + 1}`, providerDraftId: null, ...create };
          state.items.push(row);
        }
        return structuredClone(row);
      },
      update: async ({ where, data }) => {
        const row = state.items.find((item) => item.id === where.id);
        Object.assign(row, data);
        return structuredClone(row);
      },
      updateMany: async ({ where, data }) => {
        const rows = state.items.filter(
          (item) => item.projectId === where.projectId
            && item.userId === where.userId
            && item.externalId === where.externalId,
        );
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    codexExternalAction: {
      count: async () => 0,
      findUnique: async ({ where }) => state.actions.find(
        (action) => action.idempotencyKey === where.idempotencyKey || action.id === where.id,
      ) || null,
      findFirst: async ({ where }) => state.actions.find(
        (action) => (!where.id || action.id === where.id)
          && (!where.idempotencyKey || action.idempotencyKey === where.idempotencyKey)
          && (!where.projectId || action.projectId === where.projectId)
          && (!where.userId || action.userId === where.userId),
      ) || null,
      create: async ({ data }) => {
        const row = { id: `action-${state.actions.length + 1}`, ...data };
        state.actions.push(row);
        return structuredClone(row);
      },
      update: async ({ where, data }) => {
        const row = state.actions.find((action) => action.id === where.id);
        Object.assign(row, data);
        return structuredClone(row);
      },
      updateMany: async ({ where, data }) => {
        const rows = state.actions.filter((action) =>
          (!where.id || action.id === where.id)
          && (!where.projectId || action.projectId === where.projectId)
          && (!where.userId || action.userId === where.userId));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
  };
}

test('review mode creates one Gmail draft and one idempotent action', async () => {
  const prisma = fakePrisma();
  const gmail = {
    getEmails: async () => [{
      id: 'gmail-1',
      threadId: 'thread-1',
      from: 'Cliente <cliente@example.com>',
      subject: 'Necesito ayuda',
      snippet: 'No puedo completar el registro.',
      date: '2026-07-27T10:00:00.000Z',
      labelIds: ['INBOX', 'UNREAD'],
    }],
    createReplyDraft: async () => {
      prisma.state.drafts += 1;
      return { draftId: 'draft-1', messageId: 'draft-message-1' };
    },
  };
  const args = {
    prisma,
    project: { id: 'project-a', userId: 'user-a' },
    companyContext: {
      profile: {
        companyName: 'SiraGPT',
        offer: 'Software empresarial',
        autonomy: { emailReplies: 'review' },
      },
      readiness: { evidence: { gmailConnected: true } },
    },
    chatComplete: async () => ({
      content: JSON.stringify({
        items: [{
          id: 'gmail-1',
          category: 'support',
          urgency: 'high',
          confidence: 0.9,
          draftBody: 'Hola, revisaremos tu registro. ¿Puedes confirmar el correo usado?',
          reason: 'Bloqueo de onboarding',
        }],
      }),
    }),
    gmailLoader: async () => ({ client: gmail }),
    env: { CODEX_EMAIL_REPLY_DAILY_LIMIT: '20' },
  };
  const first = await inbox.triageInbox(args);
  const second = await inbox.triageInbox(args);
  assert.equal(first.action, 'triaged_review');
  assert.equal(first.items[0].category, 'support');
  assert.equal(first.actions[0].status, 'pending_review');
  assert.equal(second.actions[0].id, first.actions[0].id);
  assert.equal(prisma.state.drafts, 1);
  assert.equal(prisma.state.items.length, 1);
  assert.equal(prisma.state.actions.length, 1);
});
