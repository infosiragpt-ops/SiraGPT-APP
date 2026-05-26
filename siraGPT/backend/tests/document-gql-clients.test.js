'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-gql-clients');
const { extractGqlClients, buildGqlClientsForFiles, renderGqlClientsBlock, _internal } = engine;
const { classifyOperation, isGqlClientLike } = _internal;

const APOLLO_FIXTURE = `import { ApolloClient, InMemoryCache, ApolloProvider, useQuery, useMutation, gql } from '@apollo/client';
import { TypedDocumentNode } from '@graphql-typed-document-node/core';

const client = new ApolloClient({
  uri: 'https://api.example.com/graphql',
  cache: new InMemoryCache(),
});

const GET_USERS: TypedDocumentNode = gql\`
  query GetUsers($limit: Int!) {
    users(limit: $limit) {
      id
      name
      email
    }
  }
\`;

const CREATE_USER = gql\`
  mutation CreateUser($input: CreateUserInput!) {
    createUser(input: $input) {
      id
      name
    }
  }
\`;

const USER_FIELDS = gql\`
  fragment UserFields on User {
    id
    name
    email
  }
\`;

const USER_UPDATES = gql\`
  subscription OnUserUpdate($id: ID!) {
    userUpdate(id: $id) {
      id
      name
    }
  }
\`;

function UserList() {
  const { data, loading } = useQuery(GET_USERS, {
    variables: { limit: 10 },
    fetchPolicy: 'cache-and-network',
    errorPolicy: 'all',
  });
  const [createUser, { loading: creating }] = useMutation(CREATE_USER);
  return <ApolloProvider client={client}>...</ApolloProvider>;
}
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractGqlClients('').total, 0);
  assert.equal(extractGqlClients(null).total, 0);
});

test('non-GQL text returns empty', () => {
  const r = extractGqlClients('Just regular code without GraphQL');
  assert.equal(r.total, 0);
});

test('isGqlClientLike heuristic', () => {
  assert.ok(isGqlClientLike('@apollo/client'));
  assert.ok(isGqlClientLike('useQuery(GET_X)'));
  assert.ok(!isGqlClientLike('plain text'));
});

test('classifyOperation: query / mutation / subscription / fragment', () => {
  assert.equal(classifyOperation('query GetX { x }'), 'query');
  assert.equal(classifyOperation('  mutation Y { y }'), 'mutation');
  assert.equal(classifyOperation('subscription Z { z }'), 'subscription');
  assert.equal(classifyOperation('fragment F on User { f }'), 'fragment');
  assert.equal(classifyOperation('{ x }'), 'anon');
});

test('detects ApolloClient and InMemoryCache', () => {
  const r = extractGqlClients(APOLLO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'apollo' && e.name === 'ApolloClient'));
  assert.ok(r.entries.some((e) => e.kind === 'apollo' && e.name === 'InMemoryCache'));
});

test('detects ApolloProvider', () => {
  const r = extractGqlClients(APOLLO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'apollo' && e.name === 'ApolloProvider'));
});

test('detects useQuery / useMutation hooks', () => {
  const r = extractGqlClients(APOLLO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'hook' && e.name === 'useQuery'));
  assert.ok(r.entries.some((e) => e.kind === 'hook' && e.name === 'useMutation'));
});

test('detects gql tagged templates by operation type', () => {
  const r = extractGqlClients(APOLLO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'gqlTag' && /^query:/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'gqlTag' && /^mutation:/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'gqlTag' && /^fragment:/.test(e.name)));
  assert.ok(r.entries.some((e) => e.kind === 'gqlTag' && /^subscription:/.test(e.name)));
});

test('extracts operation names from gql tags', () => {
  const r = extractGqlClients(APOLLO_FIXTURE);
  assert.ok(r.entries.some((e) => /GetUsers/.test(e.name)));
  assert.ok(r.entries.some((e) => /CreateUser/.test(e.name)));
});

test('counts query/mutation/subscription/fragment in totals', () => {
  const r = extractGqlClients(APOLLO_FIXTURE);
  assert.ok(r.totals.query >= 1);
  assert.ok(r.totals.mutation >= 1);
  assert.ok(r.totals.subscription >= 1);
  assert.ok(r.totals.fragment >= 1);
});

test('detects TypedDocumentNode', () => {
  const r = extractGqlClients(APOLLO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'typed' && e.name === 'TypedDocumentNode'));
});

test('detects fetchPolicy and errorPolicy', () => {
  const r = extractGqlClients(APOLLO_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'fetchPolicy' && e.name === 'cache-and-network'));
  assert.ok(r.entries.some((e) => e.kind === 'errorPolicy' && e.name === 'all'));
});

test('detects urql constructs', () => {
  const r = extractGqlClients('import { createClient, cacheExchange, fetchExchange } from "urql"; const c = createClient({});');
  assert.ok(r.entries.some((e) => e.kind === 'urql' && e.name === 'createClient'));
  assert.ok(r.entries.some((e) => e.kind === 'urql' && e.name === 'cacheExchange'));
});

test('detects Relay constructs', () => {
  const r = extractGqlClients('import { useFragment, usePreloadedQuery, RelayEnvironmentProvider } from "react-relay";');
  assert.ok(r.entries.some((e) => e.kind === 'relay' && e.name === 'useFragment'));
  assert.ok(r.entries.some((e) => e.kind === 'relay' && e.name === 'usePreloadedQuery'));
});

test('detects GraphQLClient (graphql-request)', () => {
  const r = extractGqlClients('import { GraphQLClient } from "graphql-request"; new GraphQLClient("https://api/graphql");');
  assert.ok(r.entries.some((e) => e.kind === 'apollo' || /GraphQLClient/.test(e.name)));
});

test('dedupes identical entries', () => {
  const r = extractGqlClients('@apollo/client\nuseQuery(X); useQuery(X);');
  assert.equal(r.entries.filter((e) => e.kind === 'hook' && e.name === 'useQuery').length, 1);
});

test('caps entries per file', () => {
  let text = `import {} from "@apollo/client";\n`;
  for (let i = 0; i < 30; i++) text += `useQuery(Q${i}); useMutation(M${i}); `;
  const r = extractGqlClients(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractGqlClients(APOLLO_FIXTURE);
  assert.ok(r.totals.apollo >= 2);
  assert.ok(r.totals.hook >= 2);
  assert.ok(r.totals.gqlTag >= 4);
});

test('buildGqlClientsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.tsx', extractedText: 'import {} from "@apollo/client"; useQuery(X);' },
    { name: 'b.tsx', extractedText: 'import { useFragment } from "react-relay";' },
  ];
  const r = buildGqlClientsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGqlClientsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'queries.ts', extractedText: APOLLO_FIXTURE }];
  const r = buildGqlClientsForFiles(files);
  const md = renderGqlClientsBlock(r);
  assert.match(md, /^## GRAPHQL CLIENTS/);
});

test('renderGqlClientsBlock empty when nothing surfaces', () => {
  assert.equal(renderGqlClientsBlock({ perFile: [] }), '');
  assert.equal(renderGqlClientsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGqlClientsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: APOLLO_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
