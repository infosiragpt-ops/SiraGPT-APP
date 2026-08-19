'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-file-paths');
const { extractFilePaths, buildFilePathsForFiles, renderFilePathsBlock, _internal } = engine;
const { isLikelyFilePath, getExtension } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractFilePaths('').total, 0);
  assert.equal(extractFilePaths(null).total, 0);
});

test('getExtension: returns lowercase extension', () => {
  assert.equal(getExtension('foo.JS'), 'js');
  assert.equal(getExtension('bar.tar.gz'), 'gz');
  assert.equal(getExtension('no-ext'), null);
});

test('isLikelyFilePath: posix-abs requires depth ≥ 2', () => {
  assert.equal(isLikelyFilePath('/etc', 'posix-abs'), false);
  assert.equal(isLikelyFilePath('/etc/nginx/foo.conf', 'posix-abs'), true);
});

test('isLikelyFilePath: project-rel requires known extension', () => {
  assert.equal(isLikelyFilePath('src/foo/bar.js', 'project-rel'), true);
  assert.equal(isLikelyFilePath('src/foo/bar.xyz123', 'project-rel'), false);
});

test('detects POSIX absolute path', () => {
  const r = extractFilePaths('Edit /etc/nginx/conf.d/site.conf to fix.');
  assert.ok(r.paths.some((p) => p.kind === 'posix-abs' && p.path === '/etc/nginx/conf.d/site.conf'));
});

test('detects home-relative path', () => {
  const r = extractFilePaths('Config is in ~/.config/myapp/settings.toml');
  assert.ok(r.paths.some((p) => p.kind === 'home' && /\.config/.test(p.path)));
});

test('detects project-relative path', () => {
  const r = extractFilePaths('See src/services/auth.ts for details.');
  assert.ok(r.paths.some((p) => p.kind === 'project-rel' && p.path === 'src/services/auth.ts'));
});

test('detects Windows absolute path', () => {
  const r = extractFilePaths('Save to C:\\Users\\foo\\Documents\\file.txt today.');
  assert.ok(r.paths.some((p) => p.kind === 'windows-abs'));
});

test('rejects too-short paths', () => {
  const r = extractFilePaths('/x');
  assert.equal(r.paths.length, 0);
});

test('rejects URLs (no scheme paths only)', () => {
  const r = extractFilePaths('Visit http://example.com/path');
  // URL is fully captured by URL extractor, not file-paths.
  // Our project-rel regex shouldn't match URLs because of leading scheme
  assert.equal(r.paths.filter((p) => p.path.includes('example.com')).length, 0);
});

test('dedupes same path mentioned twice', () => {
  const r = extractFilePaths('See src/foo.js and src/foo.js again.');
  assert.equal(r.paths.filter((p) => p.path === 'src/foo.js').length, 1);
});

test('caps paths per file', () => {
  let text = '';
  for (let i = 0; i < 50; i++) text += `src/path/file-${i}.js `;
  const r = extractFilePaths(text);
  assert.ok(r.paths.length <= 32);
});

test('totals reports by kind', () => {
  const r = extractFilePaths('Edit /etc/foo/bar.conf and src/x.js and ~/.bashrc/y.sh');
  assert.ok(r.totals['posix-abs'] >= 1);
  assert.ok(r.totals['project-rel'] >= 1);
  assert.ok(r.totals['home'] >= 1);
});

test('handles various common extensions', () => {
  const r = extractFilePaths('Files: app.py, lib/main.go, conf/site.yaml, docs/README.md');
  const exts = r.paths.map((p) => getExtension(p.path));
  assert.ok(exts.includes('go'));
  assert.ok(exts.includes('yaml'));
  assert.ok(exts.includes('md'));
});

test('strips trailing punctuation', () => {
  const r = extractFilePaths('See src/foo.js. Then look at /etc/nginx/foo.conf,');
  assert.ok(r.paths.some((p) => p.path === 'src/foo.js'));
  assert.ok(r.paths.some((p) => p.path === '/etc/nginx/foo.conf'));
});

test('buildFilePathsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'See /etc/nginx/foo.conf' },
    { name: 'b.md', extractedText: 'Edit src/main.js' },
  ];
  const r = buildFilePathsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderFilePathsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'See src/foo.js' }];
  const r = buildFilePathsForFiles(files);
  const md = renderFilePathsBlock(r);
  assert.match(md, /^## FILE PATHS/);
});

test('renderFilePathsBlock empty when nothing surfaces', () => {
  assert.equal(renderFilePathsBlock({ perFile: [] }), '');
  assert.equal(renderFilePathsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildFilePathsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'src/foo.js' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('rejects single-segment POSIX (just /etc)', () => {
  const r = extractFilePaths('Set /etc as the prefix.');
  assert.equal(r.paths.filter((p) => p.kind === 'posix-abs').length, 0);
});
