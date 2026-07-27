'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveCompanyMissionPortfolio,
  formatMissionContext,
  selectMissionForCycle,
} = require('../src/services/codex/company-mission-orchestrator');

function context(overrides = {}) {
  const readiness = {
    score: 29,
    areas: [
      { id: 'purpose', status: 'needs_attention', evidence: 'Misión pendiente.' },
      { id: 'customer', status: 'needs_attention', evidence: 'Oferta pendiente.' },
      { id: 'software', status: 'ready', evidence: 'Workspace listo.' },
      { id: 'website', status: 'needs_attention', evidence: 'Sin publicación.' },
      { id: 'social', status: 'needs_attention', evidence: 'Sin OAuth.' },
      { id: 'email', status: 'ready', evidence: 'Gmail conectado.' },
      { id: 'sales', status: 'needs_attention', evidence: 'Sin proceso comercial.' },
    ],
    evidence: {
      workspaceReady: true,
      socialConnections: [],
      gmailConnected: true,
    },
    ...overrides.readiness,
  };
  return {
    profile: {
      companyName: 'SiraGPT.COM',
      autonomy: {
        research: true,
        codeChanges: 'auto',
      },
      ...overrides.profile,
    },
    readiness,
    safeguards: {
      socialPublishing: 'review',
      emailReplies: 'review',
      leadOutreach: 'review',
      ...overrides.safeguards,
    },
  };
}

test('portfolio routes grounded gaps to professional departments', () => {
  const portfolio = deriveCompanyMissionPortfolio({
    project: { id: 'p1', name: 'SiraGPT.COM' },
    context: context(),
    now: new Date('2026-07-27T12:00:00.000Z'),
  });

  assert.equal(portfolio.version, 1);
  assert.equal(portfolio.summary.total, 9);
  assert.equal(portfolio.summary.highestPriorityMissionId, 'company-purpose');
  assert.equal(
    portfolio.missions.find((item) => item.id === 'code-excellence').departmentId,
    'product-engineering',
  );
  assert.equal(
    portfolio.missions.find((item) => item.id === 'agent-orchestration').status,
    'ready_to_execute',
  );
});

test('external missions fail closed without a real connection', () => {
  const portfolio = deriveCompanyMissionPortfolio({
    project: { id: 'p1', name: 'SiraGPT.COM' },
    context: context(),
  });

  const social = portfolio.missions.find((item) => item.id === 'social-operations');
  assert.equal(social.status, 'blocked_connection');
  assert.equal(social.autoExecutable, false);
  assert.match(social.nextAction, /Conectar una cuenta OAuth/);
  assert.equal(
    portfolio.missions.find((item) => item.id === 'email-operations').status,
    'integration_required',
  );
});

test('connected social account prepares review drafts and auto mode can execute', () => {
  const reviewPortfolio = deriveCompanyMissionPortfolio({
    project: { id: 'p1' },
    context: context({
      readiness: {
        evidence: {
          workspaceReady: true,
          socialConnections: [{ platform: 'linkedin' }],
          gmailConnected: true,
        },
      },
    }),
  });
  const review = reviewPortfolio.missions.find((item) => item.id === 'social-operations');
  assert.equal(review.status, 'review_required');
  assert.equal(review.autoExecutable, false);
  assert.equal(selectMissionForCycle(reviewPortfolio, 5).id, 'social-operations');

  const autoPortfolio = deriveCompanyMissionPortfolio({
    project: { id: 'p1' },
    context: context({
      readiness: {
        evidence: {
          workspaceReady: true,
          socialConnections: [{ platform: 'linkedin' }],
          gmailConnected: true,
        },
      },
      safeguards: { socialPublishing: 'auto' },
    }),
  });
  const auto = autoPortfolio.missions.find((item) => item.id === 'social-operations');
  assert.equal(auto.status, 'ready_to_execute');
  assert.equal(auto.autoExecutable, true);
  assert.equal(auto.executor, 'social-publish');
});

test('mission selector is bounded and mission context preserves effect policy', () => {
  const portfolio = deriveCompanyMissionPortfolio({
    project: { id: 'p1' },
    context: context(),
  });
  const first = selectMissionForCycle(portfolio, 0);
  const wrapped = selectMissionForCycle(portfolio, 999);
  assert.equal(first.id, 'company-purpose');
  assert.ok(wrapped);
  assert.match(formatMissionContext(first), /Misión priorizada por CEO Office/);
  assert.match(formatMissionContext(first), /evidencia verificable/);
});
