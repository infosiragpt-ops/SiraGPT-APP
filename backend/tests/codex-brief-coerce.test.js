'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coerceBriefRecord } = require('../src/services/codex/project-brief-store');
const departments = require('../src/services/codex/company-departments');

test('string briefs coerce into companyProfile mission records', () => {
  const brief = coerceBriefRecord('Misión legada de prueba');
  assert.equal(brief.objective, 'Misión legada de prueba');
  assert.equal(brief.legacyBriefText, 'Misión legada de prueba');
  assert.equal(brief.companyProfile.mission, 'Misión legada de prueba');
});

test('readDepartments keeps built-ins when brief is a legacy string', () => {
  const rows = departments.readDepartments({
    id: 'p1',
    brief: 'Empresa autónoma de prueba',
  });
  assert.ok(rows.some((row) => row.id === 'ceo-office'));
  assert.ok(rows.length >= 5);
});
