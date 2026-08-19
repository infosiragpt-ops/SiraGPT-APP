'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-graphql-fragments');
const { extractGraphqlFragments, buildGraphqlFragmentsForFiles, renderGraphqlFragmentsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractGraphqlFragments('').total, 0);
  assert.equal(extractGraphqlFragments(null).total, 0);
});

test('detects fragment X on Y', () => {
  const r = extractGraphqlFragments('fragment UserBasic on User { id name email }');
  assert.ok(r.entries.some((e) => e.kind === 'fragment' && e.name === 'UserBasic'));
});

test('detects inline fragments (... on Type)', () => {
  const r = extractGraphqlFragments('{ search { ... on User { id } ... on Post { title } } }');
  assert.ok(r.entries.some((e) => e.kind === 'inlineFragment' && e.name === 'User'));
  assert.ok(r.entries.some((e) => e.kind === 'inlineFragment' && e.name === 'Post'));
});

test('detects fragment spreads', () => {
  const r = extractGraphqlFragments('query { me { ...UserFields ...AdminPermissions } }');
  assert.ok(r.entries.some((e) => e.kind === 'spread' && e.name === 'UserFields'));
  assert.ok(r.entries.some((e) => e.kind === 'spread' && e.name === 'AdminPermissions'));
});

test('inline fragment does not also count as spread', () => {
  const r = extractGraphqlFragments('... on Admin { perms }');
  // should only show inlineFragment, not spread for "Admin"
  assert.ok(r.entries.some((e) => e.kind === 'inlineFragment' && e.name === 'Admin'));
});

test('detects @include / @skip directives', () => {
  const r = extractGraphqlFragments('field @include(if: $cond) other @skip(if: $skip)');
  assert.ok(r.entries.some((e) => e.kind === 'directive' && e.name === '@include'));
  assert.ok(r.entries.some((e) => e.kind === 'directive' && e.name === '@skip'));
});

test('detects @deprecated directive', () => {
  const r = extractGraphqlFragments('oldField: String @deprecated(reason: "use newField")');
  assert.ok(r.entries.some((e) => e.name === '@deprecated'));
});

test('detects type definitions', () => {
  const r = extractGraphqlFragments('type User { id: ID! } interface Node { id: ID! } enum Role { ADMIN }');
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'User'));
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'Node'));
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'Role'));
});

test('detects schema definitions', () => {
  const r = extractGraphqlFragments('schema { query: Query mutation: Mutation }');
  assert.ok(r.entries.some((e) => e.kind === 'schema'));
});

test('detects union and scalar types', () => {
  const r = extractGraphqlFragments('union SearchResult = User | Post scalar DateTime');
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'SearchResult' && e.detail === 'union'));
  assert.ok(r.entries.some((e) => e.kind === 'type' && e.name === 'DateTime' && e.detail === 'scalar'));
});

test('dedupes identical fragment names', () => {
  const r = extractGraphqlFragments('fragment X on Y { id } fragment X on Y { id }');
  assert.equal(r.entries.filter((e) => e.kind === 'fragment' && e.name === 'X').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `fragment F${i} on T { id } `;
  const r = extractGraphqlFragments(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractGraphqlFragments('fragment F on T { id } ...F @include(if: $x) type X { y: Y }');
  assert.ok(r.totals.fragment >= 1);
  assert.ok(r.totals.spread >= 1);
  assert.ok(r.totals.directive >= 1);
  assert.ok(r.totals.type >= 1);
});

test('buildGraphqlFragmentsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.graphql', extractedText: 'fragment A on T { id }' },
    { name: 'b.graphql', extractedText: 'fragment B on T { id }' },
  ];
  const r = buildGraphqlFragmentsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGraphqlFragmentsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'q.graphql', extractedText: 'fragment X on T { id }' }];
  const r = buildGraphqlFragmentsForFiles(files);
  const md = renderGraphqlFragmentsBlock(r);
  assert.match(md, /^## GRAPHQL/);
});

test('renderGraphqlFragmentsBlock empty when nothing surfaces', () => {
  assert.equal(renderGraphqlFragmentsBlock({ perFile: [] }), '');
  assert.equal(renderGraphqlFragmentsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGraphqlFragmentsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'fragment X on T { id }' },
  ]);
  assert.equal(r.perFile.length, 1);
});
