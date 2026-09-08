'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadGmailClientForUser } = require('../src/services/gmail-user-client');

test('concurrent users receive different OAuth clients and credentials', async () => {
  const clients = [];
  const users = {
    'user-a': { gmailTokens: JSON.stringify({ accessToken: 'token-a', expiresAt: Date.now() + 60_000 }) },
    'user-b': { gmailTokens: JSON.stringify({ accessToken: 'token-b', expiresAt: Date.now() + 60_000 }) },
  };
  const prisma = {
    user: {
      findUnique: async ({ where }) => users[where.id] || null,
      update: async () => { throw new Error('must not refresh'); },
    },
  };
  const createClient = () => {
    const client = {
      credentials: null,
      setCredentials(tokens) { this.credentials = structuredClone(tokens); },
      refreshTokens: async () => null,
    };
    clients.push(client);
    return client;
  };
  const [a, b] = await Promise.all([
    loadGmailClientForUser({
      prisma,
      userId: 'user-a',
      createClient,
      decrypt: (value) => value,
      encrypt: (value) => value,
    }),
    loadGmailClientForUser({
      prisma,
      userId: 'user-b',
      createClient,
      decrypt: (value) => value,
      encrypt: (value) => value,
    }),
  ]);
  assert.notEqual(a.client, b.client);
  assert.equal(a.client.credentials.accessToken, 'token-a');
  assert.equal(b.client.credentials.accessToken, 'token-b');
  assert.equal(clients.length, 2);
});
