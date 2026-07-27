'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/services/codex/company-operations/external-action-policy');

function context(mode) {
  return {
    profile: {
      autonomy: {
        emailReplies: mode,
        leadOutreach: mode,
        socialReplies: mode,
      },
    },
  };
}

test('external effects default to review and never infer auto', () => {
  const decision = policy.decideExternalAction({
    companyContext: { profile: { autonomy: {} } },
    kind: 'email_reply',
    connected: true,
    sentToday: 0,
    env: {},
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.action, 'review');
});

test('off, disconnected provider and daily limit block execution', () => {
  assert.equal(policy.decideExternalAction({
    companyContext: context('off'), kind: 'lead_outreach', connected: true,
  }).reason, 'policy_off');
  assert.equal(policy.decideExternalAction({
    companyContext: context('auto'), kind: 'email_reply', connected: false,
  }).reason, 'provider_not_connected');
  assert.equal(policy.decideExternalAction({
    companyContext: context('auto'),
    kind: 'email_reply',
    connected: true,
    sentToday: 2,
    env: { CODEX_EMAIL_REPLY_DAILY_LIMIT: '2' },
  }).reason, 'daily_limit_reached');
});

test('auto is available only when explicitly stored', () => {
  const decision = policy.decideExternalAction({
    companyContext: context('auto'),
    kind: 'lead_outreach',
    connected: true,
    sentToday: 0,
    env: { CODEX_LEAD_OUTREACH_DAILY_LIMIT: '5' },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.action, 'execute');
});
