'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const sales = require('../src/services/codex/company-operations/sales-pipeline');

test('lead research persists only candidates backed by returned source URLs', async () => {
  const rows = [];
  const usageRows = [];
  const prisma = {
    codexDepartmentPool: {
      findUnique: async () => ({
        id: 'pool-sales',
        projectId: 'project-a',
        departmentId: 'sales',
        size: 2,
        enabled: true,
      }),
    },
    codexUsageEntry: {
      create: async ({ data }) => {
        const row = { id: `usage-${usageRows.length + 1}`, ...data };
        usageRows.push(row);
        return row;
      },
      findUnique: async () => null,
      findMany: async () => usageRows.map((row) => structuredClone(row)),
    },
    codexRunMetric: { findMany: async () => [] },
    codexCompanyLead: {
      create: async ({ data }) => {
        const row = { id: `lead-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
    },
  };
  const result = await sales.researchLeads({
    prisma,
    project: { id: 'project-a', userId: 'user-a' },
    companyContext: {
      profile: {
        companyName: 'SiraGPT',
        offer: 'Agentes de software para empresas',
        targetCustomer: 'Empresas de servicios B2B',
        market: 'Perú',
        autonomy: { research: true },
      },
    },
    webSearch: async () => ({
      results: [{
        title: 'Empresa Alfa',
        url: 'https://alfa.example/?utm_source=test',
        snippet: 'Empresa peruana de servicios B2B.',
        source: 'test',
      }],
    }),
    chatComplete: async () => ({
      content: JSON.stringify({
        leads: [
          {
            sourceUrl: 'https://alfa.example',
            companyName: 'Empresa Alfa',
            domain: 'alfa.example',
            score: 82,
            evidence: 'Opera servicios B2B en Perú.',
            tags: ['b2b'],
          },
          {
            sourceUrl: 'https://inventado.example',
            companyName: 'Inventada',
            score: 99,
          },
        ],
      }),
      usage: {
        tokensIn: 220,
        tokensOut: 80,
        provider: 'Anthropic',
        model: 'claude-sonnet-4-6',
        generationId: 'sales-research-1',
      },
    }),
  });
  assert.equal(result.action, 'leads_saved');
  assert.equal(result.leads.length, 1);
  assert.equal(rows[0].projectId, 'project-a');
  assert.equal(rows[0].userId, 'user-a');
  assert.equal(rows[0].companyName, 'Empresa Alfa');
  assert.equal(rows[0].status, 'qualified');
  assert.equal(usageRows.length, 1);
  assert.equal(usageRows[0].source, 'sales_research');
  assert.equal(usageRows[0].projectId, 'project-a');
  assert.equal(usageRows[0].departmentPoolId, 'pool-sales');
});

test('lead research budget zero blocks the LLM provider before spend', async () => {
  let llmCalls = 0;
  await assert.rejects(
    sales.researchLeads({
      prisma: {
        codexRunMetric: { findMany: async () => [] },
        codexUsageEntry: { findMany: async () => [] },
      },
      project: {
        id: 'project-budget-zero',
        userId: 'user-a',
        brief: { proactive: { configuredDailyBudgetUsd: 0 } },
      },
      companyContext: {
        profile: {
          offer: 'Agentes de software',
          targetCustomer: 'Empresas B2B',
          autonomy: { research: true },
        },
      },
      webSearch: async () => ({
        results: [{
          title: 'Empresa Alfa',
          url: 'https://alfa.example',
          snippet: 'Empresa B2B verificada.',
        }],
      }),
      chatComplete: async () => {
        llmCalls += 1;
        return { content: '{"leads":[]}' };
      },
    }),
    (error) => error?.code === 'company_daily_budget_exceeded' && error?.status === 429,
  );
  assert.equal(llmCalls, 0);
});

test('lead research without a configured Sales pool fails closed before the LLM provider', async () => {
  let llmCalls = 0;
  await assert.rejects(
    sales.researchLeads({
      prisma: {
        codexRunMetric: { findMany: async () => [] },
        codexUsageEntry: { findMany: async () => [] },
        codexDepartmentPool: { findUnique: async () => null },
      },
      project: { id: 'project-without-sales-pool', userId: 'user-a' },
      companyContext: {
        profile: {
          offer: 'Agentes de software',
          targetCustomer: 'Empresas B2B',
          autonomy: { research: true },
        },
      },
      webSearch: async () => ({
        results: [{
          title: 'Empresa Alfa',
          url: 'https://alfa.example',
          snippet: 'Empresa B2B verificada.',
        }],
      }),
      chatComplete: async () => {
        llmCalls += 1;
        return { content: '{"leads":[]}' };
      },
    }),
    (error) => error?.code === 'department_pool_budget_check_failed'
      && error?.status === 503
      && error?.budget?.reason === 'department_pool_not_configured',
  );
  assert.equal(llmCalls, 0);
});

test('re-research preserves protected commercial states and only upgrades discovered leads', async () => {
  const protectedStatuses = ['review', 'contacted', 'replied', 'won', 'lost', 'do_not_contact'];
  for (const initialStatus of protectedStatuses) {
    const row = {
      id: `lead-${initialStatus}`,
      projectId: 'project-a',
      userId: 'user-a',
      fingerprint: 'fingerprint-a',
      companyName: 'Empresa anterior',
      status: initialStatus,
    };
    const prisma = {
      codexCompanyLead: {
        create: async () => {
          const error = new Error('duplicate');
          error.code = 'P2002';
          throw error;
        },
        findUnique: async () => structuredClone(row),
        update: async ({ data }) => {
          Object.assign(row, data);
          return structuredClone(row);
        },
        updateMany: async ({ where, data }) => {
          if (row.id === where.id && row.status === where.status) {
            Object.assign(row, data);
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
    };
    const persisted = await sales.persistResearchedLead({
      prisma,
      data: {
        projectId: 'project-a',
        userId: 'user-a',
        fingerprint: 'fingerprint-a',
        companyName: 'Empresa actualizada',
        domain: 'empresa.example',
        websiteUrl: 'https://empresa.example',
        sourceTitle: 'Fuente verificada',
        evidence: 'Evidencia más reciente.',
        status: 'qualified',
        score: 95,
        tags: ['b2b'],
        updatedAt: new Date('2026-07-27T18:00:00.000Z'),
      },
    });
    assert.equal(persisted.status, initialStatus);
    assert.equal(persisted.companyName, 'Empresa actualizada');
  }
});

test('lead research refuses to run without offer and target customer', async () => {
  const result = await sales.researchLeads({
    prisma: {},
    project: { id: 'p', userId: 'u' },
    companyContext: { profile: { autonomy: { research: true } } },
    chatComplete: async () => { throw new Error('must not call'); },
    webSearch: async () => { throw new Error('must not call'); },
  });
  assert.equal(result.action, 'profile_incomplete');
});

test('repeating outreach returns the existing action without creating another draft', async () => {
  const existing = {
    id: 'action-1',
    projectId: 'p',
    userId: 'u',
    kind: 'lead_outreach',
    targetRef: 'lead-1',
    status: 'pending_review',
  };
  const result = await sales.prepareLeadOutreach({
    prisma: {
      codexProject: {
        findFirst: async () => ({
          id: 'p',
          userId: 'u',
          deletedAt: null,
          brief: {
            companyProfile: { autonomy: { leadOutreach: 'review' } },
            companyResources: {
              assignments: { 'connector:gmail': 'sales' },
              pinned: [],
            },
          },
          companyLink: {
            project: { id: 'company-p', userId: 'u', deletedAt: null },
          },
        }),
      },
      connectorAccount: {
        findFirst: async () => ({
          id: 'connector-gmail',
          userId: 'u',
          provider: 'gmail',
          status: 'connected',
        }),
      },
      projectConnectorAssignment: {
        findFirst: async () => ({
          id: 'assignment-gmail',
          projectId: 'company-p',
          connectorAccountId: 'connector-gmail',
          status: 'active',
        }),
      },
      user: {
        findUnique: async () => ({ gmailTokens: 'encrypted-gmail' }),
      },
      codexCompanyLead: {
        findFirst: async () => ({
          id: 'lead-1',
          projectId: 'p',
          userId: 'u',
          companyName: 'Alfa',
          email: 'ventas@alfa.example',
          status: 'qualified',
        }),
      },
      codexExternalAction: {
        count: async () => 0,
        findFirst: async () => existing,
      },
    },
    project: { id: 'p', userId: 'u' },
    companyContext: {
      profile: { autonomy: { leadOutreach: 'review' } },
      readiness: { evidence: { gmailConnected: true } },
    },
    chatComplete: async () => { throw new Error('must not regenerate content'); },
    gmailLoader: async () => { throw new Error('must not create a second draft'); },
  });
  assert.equal(result.action, 'outreach_already_prepared');
  assert.equal(result.record.id, 'action-1');
});
