'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const analyzer = require('../src/services/codex/business-analyzer');

const NOW = new Date('2026-07-28T18:00:00.000Z');

function project(overrides = {}) {
  return {
    id: 'project-1',
    userId: 'user-1',
    name: 'Acme Andes',
    status: 'ready',
    workspacePath: '/workspaces/project-1',
    brief: {},
    ...overrides,
  };
}

test('business analyzer grounds landing, software, SEO and social signals in remote evidence', async () => {
  const result = await analyzer.analyzeBusiness({
    project: project(),
    companyContext: {
      profile: { companyName: 'Acme Andes', websiteUrl: null },
      readiness: {
        areas: [{ id: 'software', status: 'ready' }],
        evidence: { workspaceReady: true, socialConnections: [] },
      },
    },
    webSearch: async (query) => ({
      provider: 'brave',
      results: /LinkedIn/.test(query)
        ? [{
          title: 'Acme Andes en LinkedIn',
          url: 'https://www.linkedin.com/company/acme-andes',
          snippet: 'Perfil publico',
        }]
        : [{
          title: 'Acme Andes',
          url: 'https://acme.example',
          snippet: 'Software para empresas andinas',
        }],
    }),
    webFetch: async ({ url }) => ({
      url,
      finalUrl: url,
      status: 200,
      title: 'Acme Andes | Software empresarial',
      contentType: 'text/html',
      text: 'Plataforma de software empresarial. '.repeat(30),
    }),
    browserAudit: async () => ({
      ok: true,
      rendered: true,
      rootChars: 800,
      title: 'Acme Andes',
      errors: [],
    }),
    now: () => NOW,
  });

  assert.equal(result.networkUsed, true);
  assert.equal(result.websiteUrl, 'https://acme.example');
  assert.equal(result.signals.find((item) => item.id === 'software').status, 'ready');
  assert.equal(result.signals.find((item) => item.id === 'landing').status, 'ready');
  assert.equal(result.signals.find((item) => item.id === 'seo').status, 'ready');
  assert.equal(result.signals.find((item) => item.id === 'social').status, 'observed');
  assert.deepEqual(result.gaps.map((item) => item.id), ['social']);
  assert.ok(result.sources.some((source) => source.provider === 'brave'));
});

test('business analyzer routes missing software and landing to Product Engineering first', async () => {
  const result = await analyzer.analyzeBusiness({
    project: project({ status: 'pending', workspacePath: null }),
    companyContext: {
      profile: { companyName: 'Nueva Empresa', websiteUrl: null },
      readiness: { areas: [], evidence: { workspaceReady: false, socialConnections: [] } },
    },
    networkEnabled: false,
    now: () => NOW,
  });

  assert.equal(result.score, 12);
  assert.deepEqual(result.gaps.slice(0, 2).map((item) => item.id), ['software', 'landing']);
  assert.ok(result.gaps.slice(0, 2).every((item) => item.priority === 'P0'));
  assert.ok(result.gaps.slice(0, 2).every((item) => item.departmentId === 'product-engineering'));
  assert.match(result.gaps.find((item) => item.id === 'landing').action, /Vite/);
});

test('business audits persist without replacing other brief state and honor freshness', async () => {
  const current = project({ brief: { proactive: { enabled: true }, objectives: [{ id: 'o1' }] } });
  const prisma = {
    codexProject: {
      findFirst: async () => structuredClone(current),
      update: async ({ data }) => {
        current.brief = structuredClone(data.brief);
        return structuredClone(current);
      },
    },
  };
  const audit = await analyzer.analyzeBusiness({
    project: current,
    companyContext: {
      profile: { companyName: current.name },
      readiness: { areas: [], evidence: { workspaceReady: true, socialConnections: [] } },
    },
    networkEnabled: false,
    now: () => NOW,
  });
  await analyzer.persistBusinessAudit({ prisma, project: current, audit });

  assert.equal(current.brief.proactive.enabled, true);
  assert.equal(current.brief.objectives[0].id, 'o1');
  assert.equal(analyzer.readBusinessAudit(current).generatedAt, NOW.toISOString());
  assert.equal(analyzer.isAuditFresh(audit, new Date(NOW.getTime() + 60_000)), true);
  assert.equal(
    analyzer.isAuditFresh(audit, new Date(NOW.getTime() + analyzer.DEFAULT_MAX_AGE_MS + 1)),
    false,
  );
  assert.match(analyzer.formatBusinessAudit(audit), /BRECHAS PRIORIZADAS/);
});
