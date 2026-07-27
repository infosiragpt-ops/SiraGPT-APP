'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const departments = require('../src/services/codex/company-departments');

function fakePrisma(project) {
  const state = { project: structuredClone(project) };
  return {
    state,
    codexProject: {
      findUnique: async () => structuredClone(state.project),
      update: async ({ data }) => {
        state.project = { ...state.project, ...structuredClone(data) };
        return structuredClone(state.project);
      },
    },
  };
}

test('built-in departments expose bounded logical capacity', () => {
  const rows = departments.readDepartments({ brief: null });
  const capacity = departments.capacitySummary(rows);
  assert.ok(rows.length >= 12);
  assert.ok(rows.some((row) => row.id === 'sales'));
  assert.ok(rows.some((row) => row.id === 'customer-success'));
  assert.equal(capacity.departments, rows.length);
  assert.ok(capacity.logicalAgents > rows.length);
  assert.equal(capacity.writerConcurrency, 1);
  assert.equal(capacity.strategy, 'parallel_readers_serialized_writer');
});

test('custom departments persist in brief and clamp capacity to 1000', async () => {
  const project = { id: 'p1', brief: { goal: 'operate company' } };
  const prisma = fakePrisma(project);
  const rows = await departments.upsertDepartment({
    prisma,
    project,
    department: {
      name: 'Ventas Enterprise',
      mission: 'Califica cuentas objetivo con evidencia.',
      kind: 'external',
      desiredAgents: 99_999,
    },
  });
  const row = rows.find((item) => item.name === 'Ventas Enterprise');
  assert.ok(row);
  assert.equal(row.custom, true);
  assert.equal(row.desiredAgents, 1000);
  assert.equal(prisma.state.project.brief.goal, 'operate company');
  assert.equal(prisma.state.project.brief.companyDepartments.length, 1);
});

test('upsert replaces the same custom department without duplicating it', async () => {
  const project = {
    id: 'p1',
    brief: {
      companyDepartments: [{
        id: 'custom-research',
        name: 'Research',
        desiredAgents: 4,
      }],
    },
  };
  const prisma = fakePrisma(project);
  const rows = await departments.upsertDepartment({
    prisma,
    project,
    department: {
      id: 'custom-research',
      name: 'Research',
      desiredAgents: 48,
    },
  });
  const custom = rows.filter((item) => item.custom);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].desiredAgents, 48);
});

test('built-in departments can be renamed via overrides and deleted by hiding', async () => {
  const project = { id: 'p1', brief: { goal: 'operate company' } };
  const prisma = fakePrisma(project);
  const renamed = await departments.upsertDepartment({
    prisma,
    project,
    department: {
      id: 'sales',
      name: 'Ventas Enterprise',
      description: 'Pipeline B2B',
      desiredAgents: 40,
    },
  });
  const sales = renamed.find((item) => item.id === 'sales');
  assert.ok(sales);
  assert.equal(sales.custom, false);
  assert.equal(sales.name, 'Ventas Enterprise');
  assert.equal(sales.desiredAgents, 40);
  assert.equal(prisma.state.project.brief.goal, 'operate company');

  const afterDelete = await departments.deleteDepartment({
    prisma,
    project: prisma.state.project,
    departmentId: 'sales',
  });
  assert.equal(afterDelete.some((item) => item.id === 'sales'), false);
  assert.deepEqual(prisma.state.project.brief.companyDepartmentHidden, ['sales']);
});

test('custom departments can be deleted and ceo-office is protected', async () => {
  const project = {
    id: 'p1',
    brief: {
      companyDepartments: [{
        id: 'custom-ops',
        name: 'Ops',
        desiredAgents: 8,
      }],
    },
  };
  const prisma = fakePrisma(project);
  const remaining = await departments.deleteDepartment({
    prisma,
    project,
    departmentId: 'custom-ops',
  });
  assert.equal(remaining.some((item) => item.id === 'custom-ops'), false);
  assert.equal(prisma.state.project.brief.companyDepartments.length, 0);

  await assert.rejects(
    () => departments.deleteDepartment({
      prisma,
      project: prisma.state.project,
      departmentId: 'ceo-office',
    }),
    /cannot_delete_ceo_office/,
  );
});
