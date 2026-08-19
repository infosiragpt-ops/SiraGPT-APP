'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-i18n-keys');
const { extractI18nKeys, buildI18nKeysForFiles, renderI18nKeysBlock, _internal } = engine;
const { looksLikeI18nKey, namespaceOf } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractI18nKeys('').total, 0);
  assert.equal(extractI18nKeys(null).total, 0);
});

test('looksLikeI18nKey: requires dot/dash/underscore', () => {
  assert.equal(looksLikeI18nKey('common.save'), true);
  assert.equal(looksLikeI18nKey('hello world'), false);
  assert.equal(looksLikeI18nKey('hello'), false);
});

test('namespaceOf: extracts first segment', () => {
  assert.equal(namespaceOf('user.profile.title'), 'user');
  assert.equal(namespaceOf('common'), '');
});

test('detects t() call', () => {
  const r = extractI18nKeys("const txt = t('common.save');");
  assert.ok(r.entries.some((e) => e.key === 'common.save'));
});

test('detects I18n.t (Rails)', () => {
  const r = extractI18nKeys("I18n.t('users.create.success')");
  assert.ok(r.entries.some((e) => e.key === 'users.create.success'));
});

test('detects $t (Vue)', () => {
  const r = extractI18nKeys("{{ $t('foo.bar') }}");
  assert.ok(r.entries.some((e) => e.key === 'foo.bar'));
});

test('detects formatJS id pattern', () => {
  const r = extractI18nKeys("intl.formatMessage({ id: 'user.greeting', defaultMessage: 'Hello' });");
  assert.ok(r.entries.some((e) => e.key === 'user.greeting'));
});

test('detects Angular translate pipe', () => {
  const r = extractI18nKeys("{{ 'user.name' | translate }}");
  assert.ok(r.entries.some((e) => e.key === 'user.name' && e.source === 'angular-pipe'));
});

test('detects useTranslation with namespace', () => {
  const r = extractI18nKeys("const { t } = useTranslation('common.shared');");
  assert.ok(r.entries.some((e) => e.key === 'common.shared'));
});

test('rejects sentence-like content', () => {
  const r = extractI18nKeys("t('Hello world')");
  assert.equal(r.entries.length, 0);
});

test('extracts namespace from dotted key', () => {
  const r = extractI18nKeys("t('user.profile.title')");
  const entry = r.entries.find((e) => e.key === 'user.profile.title');
  assert.ok(entry);
  assert.equal(entry.namespace, 'user');
});

test('dedupes identical keys', () => {
  const r = extractI18nKeys("t('a.b') and again t('a.b')");
  assert.equal(r.entries.filter((e) => e.key === 'a.b').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `t('ns.key${i}'); `;
  const r = extractI18nKeys(text);
  assert.ok(r.entries.length <= 20);
});

test('counts totals by namespace', () => {
  const r = extractI18nKeys("t('user.a') and t('user.b') and t('admin.c')");
  assert.equal(r.totals.user, 2);
  assert.equal(r.totals.admin, 1);
});

test('buildI18nKeysForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.tsx', extractedText: "t('common.save')" },
    { name: 'b.tsx', extractedText: "t('common.cancel')" },
  ];
  const r = buildI18nKeysForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderI18nKeysBlock returns markdown when entries exist', () => {
  const files = [{ name: 'a.tsx', extractedText: "t('common.save')" }];
  const r = buildI18nKeysForFiles(files);
  const md = renderI18nKeysBlock(r);
  assert.match(md, /^## I18N KEYS/);
});

test('renderI18nKeysBlock empty when nothing surfaces', () => {
  assert.equal(renderI18nKeysBlock({ perFile: [] }), '');
  assert.equal(renderI18nKeysBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildI18nKeysForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: "t('common.save')" },
  ]);
  assert.equal(r.perFile.length, 1);
});
