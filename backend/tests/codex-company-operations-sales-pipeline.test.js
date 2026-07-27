'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const sales = require('../src/services/codex/company-operations/sales-pipeline');

test('lead research persists only candidates backed by returned source URLs', async () => {
  const rows = [];
  const prisma = {
    codexCompanyLead: {
      upsert: async ({ create }) => {
        const row = { id: `lead-${rows.length + 1}`, ...create };
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
