'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const sales = require('../src/services/codex/company-operations/sales-pipeline');

test('lead research persists only candidates backed by returned source URLs', async () => {
  const rows = [];
  const prisma = {
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
    }),
  });
  assert.equal(result.action, 'leads_saved');
  assert.equal(result.leads.length, 1);
  assert.equal(rows[0].projectId, 'project-a');
  assert.equal(rows[0].userId, 'user-a');
  assert.equal(rows[0].companyName, 'Empresa Alfa');
  assert.equal(rows[0].status, 'qualified');
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
