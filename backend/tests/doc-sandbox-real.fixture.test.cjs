'use strict';

// Fixture/CLI unit tests only: no provider request, no validation attestation.
const test = require('node:test');
const assert = require('node:assert/strict');
const PizZip = require('pizzip');
const ExcelJS = require('exceljs');
const { PDFDocument } = require('pdf-lib');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const ts = require('typescript');
const { makeFixtures, digest } = require('./doc-sandbox-real.fixtures.cjs');
const { options, loadPreflightConfig, loadRunnerConfig } = require('./doc-sandbox-real.cjs');

test('real campaign requires explicit mode, capped total authorization and a private output location', () => {
  for (const args of [[], ['--preflight'], ['--preflight', '--campaign=test', '--authorize-usd=6', '--out=/private/tmp/evidence'],
    ['--execute-real', '--preflight', '--campaign=test', '--authorize-usd=5', '--out=/private/tmp/evidence'],
    ['--execute-real', '--campaign=test', '--authorize-usd=5', '--out=relative']]) assert.throws(() => options(args));
  const accepted = options(['--preflight', '--campaign=test', '--authorize-usd=5', '--out=/private/tmp/evidence']);
  assert.equal(accepted.authorizationUsd, 5); assert.equal(accepted.marginUsd, 0.75);
  assert.equal(accepted.mode, 'preflight');
  assert.equal(accepted.suite, 'smoke');
});

test('complex suite requires an explicit absolute fixture bundle and retains the same aggregate budget', () => {
  const base = ['--preflight', '--campaign=complex-a', '--authorize-usd=5', '--out=/private/tmp/evidence'];
  for (const extra of [['--suite=complex'], ['--suite=unknown'], ['--fixtures-dir=/private/tmp/docs'],
    ['--suite=complex', '--fixtures-dir=relative'], ['--suite=complex', '--fixtures-dir=/'],
    ['--suite=complex', '--fixtures-dir=/private/tmp/../docs'], ['--suite=complex', '--suite=smoke']])
    assert.throws(() => options([...base, ...extra]));
  const accepted = options([...base, '--suite=complex', '--fixtures-dir=/private/tmp/complex-docs']);
  assert.equal(accepted.suite, 'complex'); assert.equal(accepted.authorizationUsd, 5); assert.equal(accepted.marginUsd, 0.75);
  assert.equal(accepted['fixtures-dir'], '/private/tmp/complex-docs');
});

test('five reduced synthetic SMOKE cases contain readable originals without claiming specification goldens', async () => {
  const fixtures = await makeFixtures();
  assert.deepEqual(fixtures.map((entry) => entry.id), ['SMOKE_DOCX', 'SMOKE_XLSX', 'SMOKE_PPTX', 'SMOKE_PDF_MERGE', 'SMOKE_NOOP']);
  const [word, excel, powerpoint, merged, noop] = fixtures;
  assert.ok(word.inputs[0].data.equals(noop.inputs[0].data));
  assert.match(new PizZip(word.inputs[0].data).file('word/document.xml').asText(), /Informe anual 2026/);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(excel.inputs[0].data);
  assert.equal(workbook.getWorksheet('Presupuesto').getCell('A1').value, 10);
  assert.equal(workbook.getWorksheet('Presupuesto').getCell('B1').value, 77);
  const slides = new PizZip(powerpoint.inputs[0].data);
  assert.match(slides.file('ppt/slides/slide1.xml').asText(), /Titulo original 2026/);
  assert.match(slides.file('ppt/notesSlides/notesSlide1.xml').asText(), /Nota original para presentador/);
  for (const input of merged.inputs) assert.equal((await PDFDocument.load(input.data)).getPageCount(), 1);
  for (const smoke of fixtures) for (const input of smoke.inputs) assert.equal(digest(input.data), input.sha256);
});

function infrastructureEnv() {
  return { DOC_SANDBOX_VALIDATOR_IMAGE: `registry.test/validator@sha256:${'a'.repeat(64)}`,
    DOC_SANDBOX_VALIDATION_STAGING_ROOT: '/private/tmp/doc-smoke-shared',
    DOC_SANDBOX_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    R2_BUCKET: 'doc-sandbox-phase1-real', R2_ACCESS_KEY_ID: 'local-infrastructure-unit',
    R2_SECRET_ACCESS_KEY: 'local-infrastructure-unit-only' };
}

test('preflight config needs only infrastructure and never reads or synthesizes Anthropic configuration', () => {
  const env = infrastructureEnv();
  for (const name of ['ANTHROPIC_API_KEY', 'DOC_SANDBOX_ENGINE', 'DOC_SANDBOX_MODELS_JSON',
    'DOC_SANDBOX_SKILL_VERSIONS_JSON', 'DOC_SANDBOX_MAX_COST_USD', 'REDIS_URL', 'R2_ACCOUNT_ID']) {
    Object.defineProperty(env, name, { get() { throw new Error(`Preflight must not access ${name}`); } });
  }
  const config = loadRunnerConfig('preflight', env);
  assert.equal(config.bucket, 'doc-sandbox-phase1-real'); assert.equal(config.storageKey.length, 32);
  assert.equal(config.validatorStagingRoot, '/private/tmp/doc-smoke-shared');
  for (const forbidden of ['apiKey', 'models', 'prices', 'skillVersions', 'engine', 'redisUrl']) assert.equal(Object.hasOwn(config, forbidden), false);
});

test('preflight fails on missing/unsafe real infrastructure rather than inserting placeholders', () => {
  const env = infrastructureEnv();
  for (const name of ['DOC_SANDBOX_VALIDATOR_IMAGE', 'DOC_SANDBOX_VALIDATION_STAGING_ROOT', 'DOC_SANDBOX_ENCRYPTION_KEY',
    'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    const missing = { ...env }; delete missing[name];
    assert.throws(() => loadPreflightConfig(missing), (error) => error.code === 'DOC_REAL_ENV_MISSING' && error.setting === name);
  }
  assert.throws(() => loadPreflightConfig({ ...env, DOC_SANDBOX_VALIDATION_STAGING_ROOT: '/' }));
  assert.throws(() => loadPreflightConfig({ ...env, DOC_SANDBOX_VALIDATOR_IMAGE: 'validator:latest' }));
  assert.throws(() => loadPreflightConfig({ ...env, DOC_SANDBOX_ENCRYPTION_KEY: 'invalid' }));
});

test('execute-real still refuses an infrastructure-only configuration', () => {
  assert.throws(() => loadRunnerConfig('execute-real', infrastructureEnv()));
});

test('both runner modes await real validator tool preflight before infrastructure or paid provider access', async () => {
  // Static control-flow regression, NOT a mock successful validator or runtime
  // isolation attestation. The unconditional awaited statement must stay first
  // in main's guarded block; a rejection goes to the terminal throwing catch.
  const filename = path.join(__dirname, 'doc-sandbox-real.cjs');
  const source = ts.createSourceFile(filename, await fs.readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const main = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'main');
  assert.ok(main?.body);
  const guarded = main.body.statements.find(ts.isTryStatement); assert.ok(guarded?.catchClause);
  const first = guarded.tryBlock.statements[0];
  assert.ok(ts.isExpressionStatement(first) && ts.isAwaitExpression(first.expression));
  const call = first.expression.expression;
  assert.ok(ts.isCallExpression(call));
  assert.equal(call.expression.getText(source), 'validator.preflight');
  assert.deepEqual(call.arguments.map((argument) => argument.getText(source)), ['controller.signal']);
  assert.ok(ts.isThrowStatement(guarded.catchClause.block.statements.at(-1)), 'Preflight failures must escape instead of continuing');
  const createsProvider = guarded.tryBlock.statements.findIndex((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => declaration.initializer
      && ts.isNewExpression(declaration.initializer) && declaration.initializer.expression.getText(source) === 'AnthropicDocumentProviderClient'));
  assert.ok(createsProvider > 0, 'Provider construction must remain after the awaited preflight');
  const modeBranch = guarded.tryBlock.statements.findIndex((statement) => ts.isIfStatement(statement)
    && statement.expression.getText(source) === "opt.mode === 'preflight'");
  assert.ok(modeBranch > 0 && modeBranch < createsProvider, 'No CLI mode may bypass the real tool preflight');
});
