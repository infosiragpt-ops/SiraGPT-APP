'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-sentry');
const { extractSentry, buildSentryForFiles, renderSentryBlock, _internal } = engine;
const { isSentryLike, maskDsn } = _internal;

const SENTRY_FIXTURE = `import * as Sentry from '@sentry/node';
import { BrowserTracing, Replay } from '@sentry/browser';

Sentry.init({
  dsn: 'https://abcdef1234567890abcdef@o123456.ingest.sentry.io/7891011',
  environment: process.env.NODE_ENV,
  integrations: [
    new BrowserTracing(),
    new Replay(),
    new ProfilingIntegration(),
  ],
  tracesSampleRate: 0.1,
});

function reportError(err) {
  Sentry.setTag('component', 'checkout');
  Sentry.setTag('userId', String(user.id));
  Sentry.setUser({ id: user.id, email: user.email });
  Sentry.setContext('order', { orderId, total });

  Sentry.addBreadcrumb({
    category: 'auth',
    level: 'info',
    message: 'User logged in',
  });

  Sentry.addBreadcrumb({
    category: 'http',
    level: 'warning',
    message: 'API timeout',
  });

  Sentry.captureException(err);
  Sentry.captureMessage('Critical failure', 'fatal');

  Sentry.withScope((scope) => {
    scope.setLevel('error');
    Sentry.captureException(err);
  });
}

await Sentry.flush(2000);
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractSentry('').total, 0);
  assert.equal(extractSentry(null).total, 0);
});

test('non-Sentry text returns empty', () => {
  const r = extractSentry('Just regular code without Sentry references');
  assert.equal(r.total, 0);
});

test('isSentryLike heuristic', () => {
  assert.ok(isSentryLike('Sentry.captureException(e)'));
  assert.ok(isSentryLike('import "@sentry/node"'));
  assert.ok(!isSentryLike('plain text'));
});

test('maskDsn truncates public key', () => {
  const masked = maskDsn('abcdef1234567890abcdef', 'o123.ingest.sentry.io', '789');
  assert.match(masked, /^abcd…/);
  assert.match(masked, /@o123\.ingest\.sentry\.io\/789$/);
});

test('detects Sentry.init', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'api' && e.name === 'Sentry.init'));
});

test('detects captureException / captureMessage', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'api' && e.name === 'Sentry.captureException'));
  assert.ok(r.entries.some((e) => e.kind === 'api' && e.name === 'Sentry.captureMessage'));
});

test('detects addBreadcrumb', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'api' && e.name === 'Sentry.addBreadcrumb'));
});

test('detects setTag / setUser / setContext', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'api' && e.name === 'Sentry.setTag'));
  assert.ok(r.entries.some((e) => e.kind === 'api' && e.name === 'Sentry.setUser'));
  assert.ok(r.entries.some((e) => e.kind === 'api' && e.name === 'Sentry.setContext'));
});

test('detects withScope / flush', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'api' && e.name === 'Sentry.withScope'));
  assert.ok(r.entries.some((e) => e.kind === 'api' && e.name === 'Sentry.flush'));
});

test('detects log levels (info / warning / error / fatal)', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'level' && e.name === 'info'));
  assert.ok(r.entries.some((e) => e.kind === 'level' && e.name === 'warning'));
});

test('detects breadcrumb categories', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'category' && e.name === 'auth'));
  assert.ok(r.entries.some((e) => e.kind === 'category' && e.name === 'http'));
});

test('detects + masks DSN URLs', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  const dsn = r.entries.find((e) => e.kind === 'dsn');
  assert.ok(dsn);
  // Should be masked — no full public key
  assert.ok(!/abcdef1234567890abcdef/.test(dsn.name));
  assert.ok(/…/.test(dsn.name));
});

test('detects integrations (BrowserTracing / Replay / ProfilingIntegration)', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'integration' && e.name === 'BrowserTracing'));
  assert.ok(r.entries.some((e) => e.kind === 'integration' && e.name === 'Replay'));
  assert.ok(r.entries.some((e) => e.kind === 'integration' && e.name === 'ProfilingIntegration'));
});

test('detects tag names', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'tag' && e.name === 'component'));
  assert.ok(r.entries.some((e) => e.kind === 'tag' && e.name === 'userId'));
});

test('dedupes identical APIs', () => {
  const r = extractSentry('Sentry.captureException(a); Sentry.captureException(b);');
  assert.equal(r.entries.filter((e) => e.kind === 'api' && e.name === 'Sentry.captureException').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Sentry.setTag("t${i}", "v"); `;
  const r = extractSentry(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractSentry(SENTRY_FIXTURE);
  assert.ok(r.totals.api >= 5);
});

test('buildSentryForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.ts', extractedText: 'Sentry.captureException(e)' },
    { name: 'b.ts', extractedText: 'Sentry.captureMessage("hi")' },
  ];
  const r = buildSentryForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSentryBlock returns markdown when entries exist', () => {
  const files = [{ name: 'errors.ts', extractedText: SENTRY_FIXTURE }];
  const r = buildSentryForFiles(files);
  const md = renderSentryBlock(r);
  assert.match(md, /^## SENTRY/);
});

test('renderSentryBlock empty when nothing surfaces', () => {
  assert.equal(renderSentryBlock({ perFile: [] }), '');
  assert.equal(renderSentryBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSentryForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: SENTRY_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
