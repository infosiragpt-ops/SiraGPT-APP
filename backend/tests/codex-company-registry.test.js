'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/services/codex/company-registry');

test('company registry materializes the linked business profile and formats a shared SOUL', async () => {
  const codexProject = {
    id: 'codex-1',
    userId: 'user-1',
    name: 'Runtime',
    brief: {
      companyProfile: {
        companyName: 'Nexora',
        mission: 'Simplificar operaciones.',
        vision: 'Automatización confiable.',
        industry: 'SaaS',
        websiteUrl: 'https://nexora.test',
        offer: 'Automatización empresarial',
        targetCustomer: 'Pymes',
      },
    },
  };
  let stored = null;
  const prisma = {
    companyCodexProjectLink: {
      findUnique: async () => ({
        project: { id: 'project-1', userId: 'user-1', name: 'Nexora Workspace' },
      }),
    },
    company: {
      upsert: async ({ create, update }) => {
        stored = stored ? { ...stored, ...update } : { id: 'company-1', ...create };
        return structuredClone(stored);
      },
    },
  };

  const first = await registry.ensureCompanyForCodexProject({ prisma, codexProject });
  const soul = registry.formatCompanySoul(first);
  assert.equal(first.projectId, 'project-1');
  assert.equal(first.name, 'Nexora');
  assert.equal(first.urls.web, 'https://nexora.test');
  assert.match(soul, /Company SOUL\.md/);
  assert.match(soul, /TODOS sus departamentos/);
  assert.match(soul, /No inventes hechos/);

  codexProject.brief.companyProfile.mission = 'Nueva misión verificable.';
  const second = await registry.ensureCompanyForCodexProject({ prisma, codexProject });
  assert.equal(second.id, first.id);
  assert.equal(second.mission, 'Nueva misión verificable.');
});

test('company registry refuses a cross-owner association', async () => {
  const prisma = {
    companyCodexProjectLink: {
      findUnique: async () => ({
        project: { id: 'project-1', userId: 'other-user', name: 'Foreign' },
      }),
    },
    company: {
      upsert: async () => {
        throw new Error('must not write');
      },
    },
  };
  const result = await registry.ensureCompanyForCodexProject({
    prisma,
    codexProject: { id: 'codex-1', userId: 'user-1', name: 'Owned', brief: {} },
  });
  assert.equal(result, null);
});
