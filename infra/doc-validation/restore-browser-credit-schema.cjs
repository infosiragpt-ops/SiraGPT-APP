'use strict';
// Test fixture repair only: restore raw credit DDL discarded by the CI-style
// db push in this exact synthetic browser DB. No production connection/data.
const cp = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const container = 'doc-sandbox-history-postgres';
const source = 'doc_sandbox_history_46398ff88700c639';
const target = 'doc_sandbox_history_browser_561_20260905';
const evidence = fs.mkdtempSync('/tmp/doc-sandbox-browser-credit-restore-');
const report = { source, target, container, schemaOnly: true, noProductionData: true, startedAt: new Date().toISOString() };
function docker(args, input) {
  const result = cp.spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.code);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function query(database, sql) {
  assert.ok([source, target].includes(database));
  return docker(['exec', '-i', container, 'psql', '-X', '-U', 'doc_fixture', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1'], sql);
}
function shape(database, tables) {
  const list = tables.map(name => `'${name}'`).join(',');
  return query(database, `SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(x ORDER BY table_name,ordinal_position) FROM
      (SELECT table_name,column_name,ordinal_position,is_nullable,udt_name,column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name IN (${list})) x),
    'constraints',(SELECT jsonb_agg(x ORDER BY tablename,conname) FROM
      (SELECT c.relname AS tablename,conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN (${list})) x),
    'indexes',(SELECT jsonb_agg(x ORDER BY tablename,indexname) FROM
      (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN (${list})) x));`);
}
try {
  const metadata = docker(['inspect', container, '--format', '{{.State.Status}} {{index .Config.Labels "siragpt.scope"}} {{.Image}} {{len .HostConfig.PortBindings}}']);
  assert.equal(metadata, 'running doc-sandbox-phase1-test sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b 0');
  const historicalShape = shape(source, ['credits', 'credit_transactions']);
  const appBefore = shape(target, ['users', 'chats', 'files', 'doc_jobs']);
  assert.equal(query(target, `SELECT (to_regclass('public.credits') IS NULL AND to_regclass('public.credit_transactions') IS NULL
    AND to_regtype('public."CreditTransactionType"') IS NULL)::text;`), 'true', 'refuse to replace any existing credit object');
  const type = query(source, `SELECT 'CREATE TYPE public."CreditTransactionType" AS ENUM (' ||
    string_agg(quote_literal(e.enumlabel), ',' ORDER BY e.enumsortorder) || ');'
    FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='CreditTransactionType';`);
  assert.ok(type.startsWith('CREATE TYPE public."CreditTransactionType" AS ENUM ('), 'historical type unavailable');
  const ddl = docker(['exec', container, 'pg_dump', '-U', 'doc_fixture', '--dbname', source, '--schema-only', '--no-owner', '--no-privileges',
    '--no-comments', '--table=public.credits', '--table=public.credit_transactions']);
  assert.ok(ddl.includes('CREATE TABLE public.credits') && ddl.includes('CREATE TABLE public.credit_transactions'));
  assert.ok(!/\b(?:DROP|TRUNCATE|INSERT INTO|COPY .*FROM stdin)\b/.test(ddl), 'unexpected destructive or data SQL');
  const sql = `${type}\n${ddl}\n`;
  fs.writeFileSync(`${evidence}/credit-schema.sql`, sql, { mode: 0o600 });
  docker(['exec', '-i', container, 'psql', '-X', '-U', 'doc_fixture', '-d', target, '--single-transaction', '-v', 'ON_ERROR_STOP=1'], sql);
  assert.equal(shape(target, ['credits', 'credit_transactions']), historicalShape);
  assert.equal(shape(source, ['credits', 'credit_transactions']), historicalShape);
  assert.equal(shape(target, ['users', 'chats', 'files', 'doc_jobs']), appBefore);
  assert.equal(query(target, 'SELECT (SELECT count(*) FROM credits)+(SELECT count(*) FROM credit_transactions);'), '0');
  report.status = 'passed';
  report.objects = ['public."CreditTransactionType"', 'public.credits', 'public.credit_transactions'];
  report.tablesIncludeHistoricalIndexesAndForeignKeys = true;
  report.alignedAppColumnsUnchanged = true;
  report.sourceSchemaUnchanged = true;
  report.sqlSha256 = crypto.createHash('sha256').update(sql).digest('hex');
  console.log(JSON.stringify({ ...report, evidence }));
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  console.error(JSON.stringify({ status: 'failed', message: error.message, evidence })); process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  fs.writeFileSync(`${evidence}/report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
