'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-openapi-keys');
const { extractOpenapiKeys, buildOpenapiKeysForFiles, renderOpenapiKeysBlock } = engine;

const SPEC = `openapi: 3.0.3
info:
  title: User API
  version: 1.0.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UserList'
  /users/{id}:
    get:
      operationId: getUser
components:
  schemas:
    User:
      type: object
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractOpenapiKeys('').total, 0);
  assert.equal(extractOpenapiKeys(null).total, 0);
});

test('detects openapi version', () => {
  const r = extractOpenapiKeys(SPEC);
  assert.ok(r.entries.some((e) => e.kind === 'version' && /3\.0\.3/.test(e.name)));
});

test('detects swagger version', () => {
  const r = extractOpenapiKeys('swagger: "2.0"');
  assert.ok(r.entries.some((e) => e.kind === 'version'));
});

test('detects info.title', () => {
  const r = extractOpenapiKeys(SPEC);
  assert.ok(r.entries.some((e) => e.kind === 'info' && /User API/.test(e.name)));
});

test('detects /users path', () => {
  const r = extractOpenapiKeys(SPEC);
  assert.ok(r.entries.some((e) => e.kind === 'path' && e.name === '/users'));
});

test('detects /users/{id} path', () => {
  const r = extractOpenapiKeys(SPEC);
  assert.ok(r.entries.some((e) => e.kind === 'path' && /\{id\}/.test(e.name)));
});

test('detects operationId', () => {
  const r = extractOpenapiKeys(SPEC);
  assert.ok(r.entries.some((e) => e.kind === 'operation' && e.name === 'listUsers'));
});

test('detects $ref', () => {
  const r = extractOpenapiKeys(SPEC);
  assert.ok(r.entries.some((e) => e.kind === 'ref' && /UserList/.test(e.name)));
});

test('detects security scheme type', () => {
  const r = extractOpenapiKeys(SPEC);
  assert.ok(r.entries.some((e) => e.kind === 'security'));
});

test('dedupes identical entries', () => {
  const r = extractOpenapiKeys('operationId: foo\noperationId: foo');
  assert.equal(r.entries.filter((e) => e.name === 'foo').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `operationId: op${i}\n`;
  const r = extractOpenapiKeys(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractOpenapiKeys(SPEC);
  assert.ok(r.totals.version >= 1);
  assert.ok(r.totals.path >= 1);
  assert.ok(r.totals.operation >= 1);
  assert.ok(r.totals.ref >= 1);
});

test('buildOpenapiKeysForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.yml', extractedText: 'openapi: 3.0.3' },
    { name: 'b.yml', extractedText: 'swagger: "2.0"' },
  ];
  const r = buildOpenapiKeysForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderOpenapiKeysBlock returns markdown when entries exist', () => {
  const files = [{ name: 'api.yml', extractedText: SPEC }];
  const r = buildOpenapiKeysForFiles(files);
  const md = renderOpenapiKeysBlock(r);
  assert.match(md, /^## OPENAPI/);
});

test('renderOpenapiKeysBlock empty when nothing surfaces', () => {
  assert.equal(renderOpenapiKeysBlock({ perFile: [] }), '');
  assert.equal(renderOpenapiKeysBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildOpenapiKeysForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'openapi: 3.0.3' },
  ]);
  assert.equal(r.perFile.length, 1);
});
