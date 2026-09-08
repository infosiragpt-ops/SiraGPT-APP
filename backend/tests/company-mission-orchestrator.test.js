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

  assert.equal(portfolio.version, 2);
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
  const replies = portfolio.missions.find((item) => item.id === 'social-replies');
  assert.equal(social.status, 'blocked_connection');
  assert.equal(social.autoExecutable, false);
  assert.match(social.nextAction, /Conectar una cuenta OAuth/);
  assert.equal(replies.status, 'blocked_connection');
  assert.equal(replies.autoExecutable, false);
  assert.equal(replies.executor, null);
  assert.equal(
    portfolio.missions.find((item) => item.id === 'email-operations').status,
    'review_required',
  );
  assert.equal(
    portfolio.missions.find((item) => item.id === 'email-operations').executor,
    'company-operation',
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
  const reviewReplies = reviewPortfolio.missions.find((item) => item.id === 'social-replies');
  assert.equal(review.status, 'review_required');
  assert.equal(review.autoExecutable, false);
  assert.equal(reviewReplies.status, 'review_required');
  assert.equal(reviewReplies.departmentId, 'customer-success');
  assert.equal(reviewReplies.executor, 'company-operation');
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
      safeguards: { socialPublishing: 'auto', socialReplies: 'auto' },
    }),
  });
  const auto = autoPortfolio.missions.find((item) => item.id === 'social-operations');
  const autoReplies = autoPortfolio.missions.find((item) => item.id === 'social-replies');
  assert.equal(auto.status, 'ready_to_execute');
  assert.equal(auto.autoExecutable, true);
  assert.equal(auto.executor, 'social-publish');
  assert.equal(autoReplies.status, 'ready_to_execute');
  assert.equal(autoReplies.autoExecutable, true);
  assert.equal(autoReplies.executor, 'company-operation');
});

test('social replies remain blocked until the connected account grants conversation scopes', () => {
  const portfolio = deriveCompanyMissionPortfolio({
    project: { id: 'p1' },
    context: context({
      readiness: {
        evidence: {
          workspaceReady: true,
          socialConnections: [{
            platform: 'linkedin',
            conversationsReady: false,
          }],
          gmailConnected: true,
        },
      },
    }),
  });
  const publishing = portfolio.missions.find((item) => item.id === 'social-operations');
  const replies = portfolio.missions.find((item) => item.id === 'social-replies');
  assert.equal(publishing.status, 'review_required');
  assert.equal(replies.status, 'blocked_connection');
  assert.equal(replies.executor, null);
  assert.match(replies.nextAction, /Reconectar/);
});

test('grounded sales and email missions route to real company operations', () => {
  const portfolio = deriveCompanyMissionPortfolio({
    project: { id: 'p1' },
    context: context({
      profile: {
        offer: 'Agentes de software',
        targetCustomer: 'Empresas B2B',
      },
      readiness: {
        areas: [
          { id: 'purpose', status: 'ready', evidence: 'Misión definida.' },
          { id: 'customer', status: 'ready', evidence: 'Oferta y cliente definidos.' },
          { id: 'software', status: 'ready', evidence: 'Workspace listo.' },
          { id: 'website', status: 'ready', evidence: 'Sitio publicado.' },
          { id: 'social', status: 'needs_attention', evidence: 'Sin OAuth.' },
          { id: 'email', status: 'ready', evidence: 'Gmail conectado.' },
          { id: 'sales', status: 'ready', evidence: 'Proceso comercial definido.' },
        ],
      },
    }),
  });

  const email = portfolio.missions.find((item) => item.id === 'email-operations');
  const sales = portfolio.missions.find((item) => item.id === 'sales-operations');
  assert.equal(email.departmentId, 'customer-success');
  assert.equal(email.executor, 'company-operation');
  assert.equal(sales.departmentId, 'sales');
  assert.equal(sales.executor, 'company-operation');
  assert.match(sales.nextAction, /fuentes públicas/);
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

test('CEO Office prioritizes audit, failed ledger work and OKRs for the responsible department', () => {
  const portfolio = deriveCompanyMissionPortfolio({
    project: {
      id: 'p1',
      name: 'SiraGPT.COM',
      brief: {
        businessPresenceAudit: {
          gaps: [{
            id: 'landing-missing',
            area: 'website',
            severity: 'critical',
            title: 'La empresa no tiene landing',
            present: false,
            recommendation: 'Construir una landing verificable con el generador Vite.',
            evidence: 'La auditoría no encontró una URL empresarial.',
          }],
        },
        ledger: [{
          runId: 'run-sales-failed',
          department: 'Ventas',
          outcome: 'failed',
          task: 'Calificar prospectos B2B',
          learnings: ['Faltaron fuentes públicas verificables.'],
        }],
        objectives: [{
          id: 'okr-retention',
          title: 'Mejorar retención de clientes',
          ownerDepartmentId: 'customer-success',
          status: 'at_risk',
          priority: 1,
          keyResults: [{ title: 'Reducir churn', target: '3%' }],
        }],
      },
    },
    context: context(),
    now: new Date('2026-07-28T12:00:00.000Z'),
  });

  const website = portfolio.missions.find((item) => item.id === 'business-website');
  const salesRecovery = portfolio.missions.find((item) => item.id === 'sales-operations');
  const okr = portfolio.missions.find((item) => item.id === 'okr-okr-retention');
  assert.equal(website.departmentId, 'product-engineering');
  assert.ok(website.sourceTypes.includes('audit'));
  assert.match(website.nextAction, /generador Vite/);
  assert.equal(salesRecovery.departmentId, 'sales');
  assert.equal(salesRecovery.executionMode, 'research');
  assert.equal(okr.departmentId, 'customer-success');
  assert.deepEqual(okr.objectiveIds, ['okr-retention']);
  assert.equal(portfolio.summary.sources.auditFindings, 1);
  assert.equal(portfolio.summary.sources.ledgerBlockers, 1);
  assert.equal(portfolio.summary.sources.objectives, 1);
  assert.ok(Math.max(website.priority, salesRecovery.priority, okr.priority) <= 4);
});

test('audit-derived external work stays blocked without a connected account', () => {
  const portfolio = deriveCompanyMissionPortfolio({
    project: {
      id: 'p1',
      brief: {
        presenceAudit: {
          findings: [{
            id: 'social-gap',
            area: 'social',
            severity: 'high',
            title: 'Activar presencia social',
            recommendation: 'Preparar el canal social.',
          }],
        },
      },
    },
    context: context(),
  });
  const social = portfolio.missions.find((item) => item.id === 'social-operations');
  assert.equal(social.departmentId, 'marketing');
  assert.equal(social.status, 'blocked_connection');
  assert.equal(social.autoExecutable, false);
  assert.ok(social.sourceTypes.includes('audit'));
});
