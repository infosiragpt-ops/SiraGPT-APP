'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-graphql-ops');
const { extractGraphqlOps, buildGraphqlOpsForFiles, renderGraphqlOpsBlock, _internal } = engine;
const { classifyKind, constantToKind } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractGraphqlOps('').total, 0);
  assert.equal(extractGraphqlOps(null).total, 0);
});

test('classifyKind / constantToKind helpers', () => {
  assert.equal(classifyKind('query'), 'query');
  assert.equal(classifyKind('mutation'), 'mutation');
  assert.equal(constantToKind('GET_USER_QUERY'), 'query');
  assert.equal(constantToKind('CREATE_POST_MUTATION'), 'mutation');
});

test('detects query GetUser', () => {
  const r = extractGraphqlOps('query GetUser($id: ID!) { user(id: $id) { name } }');
  assert.ok(r.entries.some((e) => e.kind === 'query' && e.name === 'GetUser'));
});

test('detects mutation CreatePost', () => {
  const r = extractGraphqlOps('mutation CreatePost($input: PostInput!) { createPost(input: $input) { id } }');
  assert.ok(r.entries.some((e) => e.kind === 'mutation' && e.name === 'CreatePost'));
});

test('detects subscription OnMessageReceived', () => {
  const r = extractGraphqlOps('subscription OnMessageReceived { messages { id text } }');
  assert.ok(r.entries.some((e) => e.kind === 'subscription' && e.name === 'OnMessageReceived'));
});

test('detects fragment with onType', () => {
  const r = extractGraphqlOps('fragment UserFields on User { id name email }');
  const entry = r.entries.find((e) => e.kind === 'fragment' && e.name === 'UserFields');
  assert.ok(entry);
  assert.equal(entry.onType, 'User');
});

test('detects constant references', () => {
  const r = extractGraphqlOps('const GET_USER_QUERY = gql`query { user }`;');
  assert.ok(r.entries.some((e) => e.source === 'constant' && e.name === 'GET_USER'));
});

test('detects multiple operations in one file', () => {
  const r = extractGraphqlOps(`
    query GetUser { user { id } }
    mutation UpdateUser { updateUser { id } }
    fragment UserBits on User { id name }
  `);
  assert.ok(r.entries.length >= 3);
});

test('dedupes identical kind+name', () => {
  const r = extractGraphqlOps('query GetUser { x } and later query GetUser { y }');
  assert.equal(r.entries.filter((e) => e.kind === 'query' && e.name === 'GetUser').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `query GetThing${i} { x }\n`;
  const r = extractGraphqlOps(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractGraphqlOps(
    'query GetXYZ { x } mutation MakeYY { y } subscription OnZZ { z } fragment FFF on User { }'
  );
  assert.ok(r.totals.query >= 1);
  assert.ok(r.totals.mutation >= 1);
  assert.ok(r.totals.subscription >= 1);
  assert.ok(r.totals.fragment >= 1);
});

test('rejects reserved Type names', () => {
  const r = extractGraphqlOps('type Query { user: User } type Mutation { addPost: Post }');
  for (const e of r.entries) {
    assert.notEqual(e.name, 'Query');
    assert.notEqual(e.name, 'Mutation');
  }
});

test('buildGraphqlOpsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.graphql', extractedText: 'query GetA { a }' },
    { name: 'b.graphql', extractedText: 'mutation MakeB { b }' },
  ];
  const r = buildGraphqlOpsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGraphqlOpsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'a.graphql', extractedText: 'query GetA { a }' }];
  const r = buildGraphqlOpsForFiles(files);
  const md = renderGraphqlOpsBlock(r);
  assert.match(md, /^## GRAPHQL OPERATIONS/);
});

test('renderGraphqlOpsBlock empty when nothing surfaces', () => {
  assert.equal(renderGraphqlOpsBlock({ perFile: [] }), '');
  assert.equal(renderGraphqlOpsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGraphqlOpsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'query GetA { a }' },
  ]);
  assert.equal(r.perFile.length, 1);
});
