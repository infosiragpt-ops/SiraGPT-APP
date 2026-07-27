'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const company = require('../src/services/codex/company-operating-profile');

const NOW = new Date('2026-07-26T12:00:00.000Z');

test('company profile defaults every external effect to review and keeps code autonomous', () => {
  const profile = company.readCompanyProfile({
    id: 'p1',
    name: 'SiraGPT.COM',
    brief: null,
  }, { now: NOW });

  assert.equal(profile.companyName, 'SiraGPT.COM');
  assert.equal(profile.stage, 'unknown');
  assert.equal(profile.autonomy.codeChanges, 'auto');
  assert.equal(profile.autonomy.socialPublishing, 'review');
  assert.equal(profile.autonomy.socialReplies, 'review');
  assert.equal(profile.autonomy.emailReplies, 'review');
  assert.equal(profile.autonomy.leadOutreach, 'review');
});

test('readiness uses real workspace, publication, OAuth and Gmail evidence', async () => {
  const project = {
    id: 'p1',
    userId: 'u1',
    name: 'SiraGPT.COM',
    status: 'ready',
    workspacePath: 'projects/p1',
    brief: {
      publication: { url: 'https://app.apps.siragpt.com' },
      companyProfile: {
        mission: 'Ayudar a empresas a ejecutar trabajo con agentes.',
        vision: 'Ser el mejor agente de código empresarial.',
        offer: 'Software operativo con agentes.',
        targetCustomer: 'Empresas que construyen productos digitales.',
        salesProcess: 'Diagnóstico, propuesta, piloto y cierre.',
      },
    },
  };
  const context = await company.loadCompanyOperatingContext({
    project,
    now: NOW,
    prisma: {
      socialConnection: {
        findMany: async () => [
          { platform: 'linkedin', accountName: '@siragpt' },
          { platform: 'linkedin', accountName: '@duplicate' },
        ],
      },
      user: {
        findUnique: async () => ({ gmailTokens: 'encrypted-envelope' }),
      },
    },
  });

  assert.equal(context.readiness.score, 100);
  assert.equal(context.readiness.evidence.publishedUrl, 'https://app.apps.siragpt.com');
  assert.equal(context.readiness.evidence.socialConnections.length, 1);
  assert.equal(context.readiness.evidence.gmailConnected, true);
  assert.equal(context.readiness.gaps.length, 0);
});

test('missing integrations remain visible even when the business profile is complete', async () => {
  const context = await company.loadCompanyOperatingContext({
    project: {
      id: 'p1',
      userId: 'u1',
      name: 'SiraGPT.COM',
      status: 'ready',
      workspacePath: 'projects/p1',
      brief: {
        companyProfile: {
          mission: 'Misión',
          vision: 'Visión',
          offer: 'Oferta',
          targetCustomer: 'Cliente',
          salesProcess: 'Proceso',
        },
      },
    },
    now: NOW,
    prisma: {
      socialConnection: { findMany: async () => [] },
      user: { findUnique: async () => ({ gmailTokens: null }) },
    },
  });

  assert.equal(context.readiness.areas.find((row) => row.id === 'social').status, 'needs_attention');
  assert.equal(context.readiness.areas.find((row) => row.id === 'email').status, 'needs_attention');
  assert.equal(context.readiness.areas.find((row) => row.id === 'website').status, 'needs_attention');
  assert.ok(context.readiness.gaps.some((gap) => gap.id === 'social'));
});

test('profile writes preserve proactive memory, objectives and publication', async () => {
  const state = {
    project: {
      id: 'p1',
      name: 'SiraGPT.COM',
      brief: {
        proactive: { enabled: true },
        objectives: [{ id: 'okr-1', title: 'Crecer' }],
        publication: { url: 'https://demo.apps.siragpt.com' },
      },
    },
  };
  const prisma = {
    codexProject: {
      findUnique: async () => state.project,
      update: async ({ data }) => {
        state.project = { ...state.project, ...data };
        return state.project;
      },
    },
  };
  const profile = await company.writeCompanyProfile({
    prisma,
    project: state.project,
    patch: {
      stage: 'existing',
      mission: 'Automatizar trabajo empresarial con evidencia.',
      autonomy: { emailReplies: 'auto' },
    },
    now: NOW,
  });

  assert.equal(profile.stage, 'existing');
  assert.equal(profile.autonomy.emailReplies, 'auto');
  assert.equal(profile.autonomy.socialPublishing, 'review');
  assert.equal(state.project.brief.proactive.enabled, true);
  assert.equal(state.project.brief.objectives[0].id, 'okr-1');
  assert.equal(state.project.brief.publication.url, 'https://demo.apps.siragpt.com');
});

test('profile writes preserve a legacy text brief as the project objective', async () => {
  const state = {
    project: {
      id: 'p1',
      name: 'SiraGPT.COM',
      brief: 'Construir el mejor agente de código empresarial.',
    },
  };
  const prisma = {
    codexProject: {
      findUnique: async () => state.project,
      update: async ({ data }) => {
        state.project = { ...state.project, ...data };
        return state.project;
      },
    },
  };

  await company.writeCompanyProfile({
    prisma,
    project: state.project,
    patch: { mission: 'Automatizar trabajo verificable.' },
    now: NOW,
  });

  assert.equal(state.project.brief.objective, 'Construir el mejor agente de código empresarial.');
  assert.equal(state.project.brief.companyProfile.mission, 'Automatizar trabajo verificable.');
});

test('formatted CEO context calls out verified gaps and anti-hallucination rule', () => {
  const profile = company.readCompanyProfile({
    name: 'SiraGPT.COM',
    brief: { companyProfile: { mission: 'Construir', vision: 'Liderar' } },
  }, { now: NOW });
  const readiness = company.deriveCompanyReadiness({
    project: { name: 'SiraGPT.COM', status: 'ready', workspacePath: 'projects/p1', brief: {} },
    profile,
  });
  const text = company.formatCompanyContext({ profile, readiness });

  assert.match(text, /Brechas verificadas/);
  assert.match(text, /no conviertas una hipótesis en hecho/);
  assert.match(text, /Redes sociales/);
});
