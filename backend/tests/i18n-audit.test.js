'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  flattenKeys,
  extractKeysFromSource,
  loadAllLocales,
  auditI18n,
  formatReport,
} = require('../src/i18n/audit');

function mkTmp(prefix = 'i18n-audit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('flattenKeys returns dot-paths for nested objects', () => {
  const keys = flattenKeys({
    a: 'x',
    nested: { b: 'y', deep: { c: 'z' } },
    arr: ['ignored'],
  });
  assert.ok(keys.has('a'));
  assert.ok(keys.has('nested.b'));
  assert.ok(keys.has('nested.deep.c'));
  assert.ok(keys.has('arr'));
});

test('flattenKeys handles empty objects', () => {
  const keys = flattenKeys({});
  assert.equal(keys.size, 0);
});

test('extractKeysFromSource picks up useTranslations namespace', () => {
  const src = `
    const t = useTranslations("settings");
    const tc = useTranslations("common");
    function Comp() {
      return t("general.title") + tc("save") + t("general.subtitle");
    }
  `;
  const keys = extractKeysFromSource(src);
  assert.ok(keys.has('settings.general.title'));
  assert.ok(keys.has('settings.general.subtitle'));
  assert.ok(keys.has('common.save'));
});

test('extractKeysFromSource handles bare translator (no namespace)', () => {
  const src = `
    const t = useTranslations();
    t("global.title");
  `;
  const keys = extractKeysFromSource(src);
  assert.ok(keys.has('global.title'));
});

test('extractKeysFromSource supports getTranslations and t.rich/.raw', () => {
  const src = `
    const t = await getTranslations("auth");
    t.rich("welcome", {});
    t.raw("legal");
    t("submit");
  `;
  const keys = extractKeysFromSource(src);
  assert.ok(keys.has('auth.welcome'));
  assert.ok(keys.has('auth.legal'));
  assert.ok(keys.has('auth.submit'));
});

test('extractKeysFromSource ignores non-string-literal keys', () => {
  const src = `
    const t = useTranslations("dyn");
    const k = "x";
    t(k);
    t(\`tpl\`);
    t("ok.key");
  `;
  const keys = extractKeysFromSource(src);
  assert.ok(keys.has('dyn.ok.key'));
  assert.equal(keys.size, 1);
});

test('loadAllLocales reads every JSON in dir', () => {
  const dir = mkTmp();
  writeJson(path.join(dir, 'en.json'), { a: 'x', b: { c: 'y' } });
  writeJson(path.join(dir, 'es.json'), { a: 'x', b: { c: 'y' }, extra: 'z' });
  const map = loadAllLocales(dir);
  assert.equal(map.size, 2);
  assert.ok(map.get('en').has('b.c'));
  assert.ok(map.get('es').has('extra'));
});

test('auditI18n reports missing keys (used in code, absent in base)', () => {
  const root = mkTmp();
  const messagesDir = path.join(root, 'messages');
  const codeDir = path.join(root, 'app');
  writeJson(path.join(messagesDir, 'en.json'), {
    settings: { title: 'Settings', save: 'Save' },
  });
  writeFile(
    path.join(codeDir, 'page.tsx'),
    `const t = useTranslations("settings"); t("title"); t("nonexistent");`,
  );

  const report = auditI18n({
    messagesDir,
    codeDirs: [codeDir],
    baseLocale: 'en',
  });

  const missingKeys = report.missing.map((m) => m.key);
  assert.deepEqual(missingKeys, ['settings.nonexistent']);
  assert.ok(report.unused.includes('settings.save'));
});

test('auditI18n treats namespace-prefix usage as covering nested keys', () => {
  const root = mkTmp();
  const messagesDir = path.join(root, 'messages');
  const codeDir = path.join(root, 'src');
  writeJson(path.join(messagesDir, 'en.json'), {
    nav: { home: 'Home', settings: 'Settings' },
  });
  writeFile(
    path.join(codeDir, 'a.ts'),
    `const t = useTranslations(); t("nav");`,
  );

  const report = auditI18n({
    messagesDir,
    codeDirs: [codeDir],
    baseLocale: 'en',
  });
  assert.equal(report.missing.length, 0);
  assert.equal(report.unused.length, 0);
});

test('auditI18n compares locales against base', () => {
  const root = mkTmp();
  const messagesDir = path.join(root, 'messages');
  const codeDir = path.join(root, 'src');
  writeJson(path.join(messagesDir, 'en.json'), {
    a: 'x',
    b: 'y',
    c: 'z',
  });
  writeJson(path.join(messagesDir, 'es.json'), { a: 'x', b: 'y' });
  writeJson(path.join(messagesDir, 'fr.json'), { a: 'x', b: 'y', c: 'z', extra: 'w' });
  writeFile(path.join(codeDir, 'a.ts'), `const t = useTranslations(); t("a"); t("b"); t("c");`);

  const report = auditI18n({ messagesDir, codeDirs: [codeDir], baseLocale: 'en' });
  assert.deepEqual(report.perLocale.es.missingFromBase, ['c']);
  assert.deepEqual(report.perLocale.es.extraVsBase, []);
  assert.deepEqual(report.perLocale.fr.missingFromBase, []);
  assert.deepEqual(report.perLocale.fr.extraVsBase, ['extra']);
});

test('auditI18n ignores non-source files and ignored dirs', () => {
  const root = mkTmp();
  const messagesDir = path.join(root, 'messages');
  const codeDir = path.join(root, 'src');
  writeJson(path.join(messagesDir, 'en.json'), { a: 'x' });
  writeFile(path.join(codeDir, 'README.md'), `const t = useTranslations("x"); t("y");`);
  writeFile(
    path.join(codeDir, 'node_modules', 'lib.ts'),
    `const t = useTranslations("x"); t("y");`,
  );
  writeFile(path.join(codeDir, 'real.ts'), `const t = useTranslations(); t("a");`);

  const report = auditI18n({ messagesDir, codeDirs: [codeDir], baseLocale: 'en' });
  assert.equal(report.totalUsed, 1);
  assert.equal(report.missing.length, 0);
});

test('auditI18n throws on missing base locale', () => {
  const root = mkTmp();
  const messagesDir = path.join(root, 'messages');
  writeJson(path.join(messagesDir, 'es.json'), { a: 'x' });
  assert.throws(
    () => auditI18n({ messagesDir, codeDirs: [root], baseLocale: 'en' }),
    /base locale "en" not found/,
  );
});

test('formatReport produces a non-empty multi-line summary', () => {
  const root = mkTmp();
  const messagesDir = path.join(root, 'messages');
  const codeDir = path.join(root, 'src');
  writeJson(path.join(messagesDir, 'en.json'), { a: 'x', b: 'y' });
  writeJson(path.join(messagesDir, 'es.json'), { a: 'x' });
  writeFile(path.join(codeDir, 'a.ts'), `const t = useTranslations(); t("a"); t("missing");`);

  const report = auditI18n({ messagesDir, codeDirs: [codeDir], baseLocale: 'en' });
  const text = formatReport(report);
  assert.match(text, /i18n audit/);
  assert.match(text, /missing in base: 1/);
  assert.match(text, /unused in base: 1/);
  assert.match(text, /es:/);
});
