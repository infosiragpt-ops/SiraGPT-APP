'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-module-federation');
const { extractModuleFederation, buildModuleFederationForFiles, renderModuleFederationBlock, _internal } = engine;
const { isFederationLike } = _internal;

const MF_FIXTURE = `const { ModuleFederationPlugin } = require('webpack').container;

module.exports = {
  plugins: [
    new ModuleFederationPlugin({
      name: 'host_app',
      filename: 'remoteEntry.js',
      remotes: {
        'app1': 'app1@http://localhost:3001/remoteEntry.js',
        'app2': 'app2@http://localhost:3002/remoteEntry.js',
        'shop': 'shop@https://shop.example.com/mf-manifest.json',
      },
      exposes: {
        './Button': './src/components/Button',
        './Header': './src/components/Header',
        './utils': './src/lib/utils',
      },
      shared: {
        react: { singleton: true, requiredVersion: '^18' },
        'react-dom': { singleton: true },
        zod: '^3.22.0',
      },
      shareScope: 'default',
    }),
  ],
};

// Dynamic remote loading
async function loadRemote() {
  await __webpack_init_sharing__('default');
  const container = window.app1;
  await container.init(__webpack_share_scopes__.default);
}
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractModuleFederation('').total, 0);
  assert.equal(extractModuleFederation(null).total, 0);
});

test('non-MF text returns empty', () => {
  const r = extractModuleFederation('Just regular webpack config without federation');
  assert.equal(r.total, 0);
});

test('isFederationLike heuristic', () => {
  assert.ok(isFederationLike('new ModuleFederationPlugin({})'));
  assert.ok(isFederationLike('remotes: { a: "..." }'));
  assert.ok(!isFederationLike('plain text'));
});

test('detects ModuleFederationPlugin', () => {
  const r = extractModuleFederation(MF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'plugin' && e.name === 'ModuleFederationPlugin'));
});

test('detects name field', () => {
  const r = extractModuleFederation(MF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'name' && e.name === 'host_app'));
});

test('detects filename', () => {
  const r = extractModuleFederation(MF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'filename' && e.name === 'remoteEntry.js'));
});

test('detects remotes with their URLs', () => {
  const r = extractModuleFederation(MF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'remote' && e.name === 'app1'));
  assert.ok(r.entries.some((e) => e.kind === 'remote' && e.name === 'app2'));
  assert.ok(r.entries.some((e) => e.kind === 'remote' && /http:\/\/localhost:3001/.test(e.detail)));
});

test('detects exposes', () => {
  const r = extractModuleFederation(MF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'expose' && e.name === './Button'));
  assert.ok(r.entries.some((e) => e.kind === 'expose' && e.name === './Header'));
  assert.ok(r.entries.some((e) => e.kind === 'expose' && /src\/components\/Button/.test(e.detail)));
});

test('detects shared dependencies', () => {
  const r = extractModuleFederation(MF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'shared' && e.name === 'react'));
  assert.ok(r.entries.some((e) => e.kind === 'shared' && e.name === 'react-dom'));
  assert.ok(r.entries.some((e) => e.kind === 'shared' && e.name === 'zod'));
});

test('detects shareScope', () => {
  const r = extractModuleFederation(MF_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'shareScope' && e.name === 'default'));
});

test('detects __webpack_init_sharing__ dynamic loading', () => {
  const r = extractModuleFederation(MF_FIXTURE);
  assert.ok(r.totals.dynamic >= 1);
});

test('dedupes identical entries', () => {
  const r = extractModuleFederation('new ModuleFederationPlugin({ name: "x", name: "x" })');
  assert.equal(r.entries.filter((e) => e.kind === 'name' && e.name === 'x').length, 1);
});

test('caps entries per file', () => {
  let text = 'new ModuleFederationPlugin({ remotes: {';
  for (let i = 0; i < 30; i++) text += `"r${i}": "r${i}@http://x/r${i}.js",`;
  text += '} })';
  const r = extractModuleFederation(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractModuleFederation(MF_FIXTURE);
  assert.ok(r.totals.remote >= 3);
  assert.ok(r.totals.expose >= 3);
  assert.ok(r.totals.shared >= 3);
});

test('buildModuleFederationForFiles aggregates across batch', () => {
  const files = [
    { name: 'webpack.host.js', extractedText: 'new ModuleFederationPlugin({ name: "host", remotes: { a: "a@http://x" } })' },
    { name: 'webpack.remote.js', extractedText: 'new ModuleFederationPlugin({ name: "remote", exposes: { "./X": "./src/X" } })' },
  ];
  const r = buildModuleFederationForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderModuleFederationBlock returns markdown when entries exist', () => {
  const files = [{ name: 'webpack.config.js', extractedText: MF_FIXTURE }];
  const r = buildModuleFederationForFiles(files);
  const md = renderModuleFederationBlock(r);
  assert.match(md, /^## MODULE FEDERATION/);
});

test('renderModuleFederationBlock empty when nothing surfaces', () => {
  assert.equal(renderModuleFederationBlock({ perFile: [] }), '');
  assert.equal(renderModuleFederationBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildModuleFederationForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: MF_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
