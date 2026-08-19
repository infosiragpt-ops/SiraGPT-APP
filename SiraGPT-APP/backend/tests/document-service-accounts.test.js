'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-service-accounts');
const { extractServiceAccounts, buildServiceAccountsForFiles, renderServiceAccountsBlock, _internal } = engine;
const { maskLocal } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractServiceAccounts('').total, 0);
  assert.equal(extractServiceAccounts(null).total, 0);
});

test('maskLocal handles short / long', () => {
  assert.equal(maskLocal('a'), '*');
  assert.equal(maskLocal('ab'), 'a*');
  assert.equal(maskLocal('abcdef'), 'ab***ef');
});

test('detects GCP service account', () => {
  const r = extractServiceAccounts('Use my-runner@my-project-123.iam.gserviceaccount.com for CI');
  assert.ok(r.entries.some((e) => e.provider === 'gcp'));
});

test('GCP local is masked', () => {
  const r = extractServiceAccounts('my-runner@my-project-123.iam.gserviceaccount.com');
  for (const e of r.entries) {
    assert.ok(!/my-runner/.test(e.masked));
  }
});

test('GCP project is preserved', () => {
  const r = extractServiceAccounts('my-runner@my-project-123.iam.gserviceaccount.com');
  const entry = r.entries.find((e) => e.provider === 'gcp');
  assert.equal(entry.project, 'my-project-123');
});

test('detects GitHub bot email', () => {
  const r = extractServiceAccounts('Committer: 12345+dependabot[bot]@users.noreply.github.com');
  assert.ok(r.entries.some((e) => e.provider === 'github'));
});

test('detects Azure AD service principal', () => {
  const r = extractServiceAccounts('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@mytenant.onmicrosoft.com');
  assert.ok(r.entries.some((e) => e.provider === 'azure'));
});

test('dedupes identical accounts', () => {
  const r = extractServiceAccounts(
    'my-runner@my-project-123.iam.gserviceaccount.com and again my-runner@my-project-123.iam.gserviceaccount.com'
  );
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 20; i++) {
    text += `runner-${i}@proj-${i}-test.iam.gserviceaccount.com `;
  }
  const r = extractServiceAccounts(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by provider', () => {
  const r = extractServiceAccounts(
    'name@proj-x.iam.gserviceaccount.com and 12345+ci-bot[bot]@users.noreply.github.com'
  );
  assert.ok(r.totals.gcp >= 1);
  assert.ok(r.totals.github >= 1);
});

test('buildServiceAccountsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'name@proj-x.iam.gserviceaccount.com' },
    { name: 'b', extractedText: '12345+ci-bot[bot]@users.noreply.github.com' },
  ];
  const r = buildServiceAccountsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderServiceAccountsBlock NEVER contains full local', () => {
  const files = [{ name: 'iam', extractedText: 'my-runner@my-project-123.iam.gserviceaccount.com' }];
  const r = buildServiceAccountsForFiles(files);
  const md = renderServiceAccountsBlock(r);
  assert.ok(!/my-runner@/.test(md));
});

test('renderServiceAccountsBlock empty when nothing surfaces', () => {
  assert.equal(renderServiceAccountsBlock({ perFile: [] }), '');
  assert.equal(renderServiceAccountsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildServiceAccountsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'name@proj-x.iam.gserviceaccount.com' },
  ]);
  assert.equal(r.perFile.length, 1);
});
