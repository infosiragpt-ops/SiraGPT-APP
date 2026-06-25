'use strict';

// Regression: GmailService.getEmails() used Promise.all over per-message
// messages.get() with no per-item error handling, so a single failed fetch
// (429 from the parallel fan-out, a 404 race, transient network) rejected the
// whole batch and returned ZERO emails. It now uses allSettled + filter so the
// healthy messages survive.

const test = require('node:test');
const assert = require('node:assert/strict');

const gmailService = require('../src/services/gmail');
const { clampMaxResults } = require('../src/routes/gmail');

test('clampMaxResults bounds limit + radix-10 + sane default (no NaN/hex to the Gmail API)', () => {
  assert.equal(clampMaxResults('5'), 5);
  assert.equal(clampMaxResults('abc'), 10); // NaN → default (was NaN → Gmail 400/500)
  assert.equal(clampMaxResults(undefined), 10);
  assert.equal(clampMaxResults(''), 10);
  assert.equal(clampMaxResults('0x10'), 10); // radix 10 → 0, not hex 16
  assert.equal(clampMaxResults('10abc'), 10);
  assert.equal(clampMaxResults('999'), 100); // capped at max
  assert.equal(clampMaxResults('-5'), 1); // floored at 1
  assert.equal(clampMaxResults('0'), 10); // 0 → default
});

function fakeClient({ failIds = [], messages = ['1', '2', '3'] } = {}) {
  return {
    users: {
      messages: {
        list: async () => ({ data: { messages: messages.map((id) => ({ id })) } }),
        get: async ({ id }) => {
          if (failIds.includes(id)) throw new Error(`fetch failed for ${id}`);
          return {
            data: {
              threadId: `t-${id}`,
              snippet: `snip-${id}`,
              labelIds: ['INBOX'],
              payload: {
                mimeType: 'text/plain',
                headers: [{ name: 'Subject', value: `Subj ${id}` }],
                body: { data: Buffer.from(`Body ${id}`).toString('base64') },
              },
            },
          };
        },
      },
    },
  };
}

async function withClient(client, fn) {
  const orig = gmailService.getGmailClient;
  gmailService.getGmailClient = () => client;
  try { return await fn(); } finally { gmailService.getGmailClient = orig; }
}

test('getEmails isolates a single failed message fetch and returns the rest', async () => {
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => { warnings.push(a); };
  try {
    const emails = await withClient(fakeClient({ failIds: ['2'] }), () =>
      gmailService.getEmails({ query: 'is:unread', maxResults: 10 }));
    assert.equal(emails.length, 2, 'the 2 healthy messages still return (not 0)');
    assert.deepEqual(emails.map((e) => e.id).sort(), ['1', '3']);
    assert.equal(emails.find((e) => e.id === '1').subject, 'Subj 1');
    assert.equal(warnings.length, 1, 'the failed fetch is logged once');
  } finally {
    console.warn = realWarn;
  }
});

test('getEmails returns every message when all fetches succeed', async () => {
  const emails = await withClient(fakeClient({ failIds: [] }), () =>
    gmailService.getEmails({ query: '', maxResults: 10 }));
  assert.equal(emails.length, 3);
});

test('getEmails returns [] when the list is empty', async () => {
  const client = { users: { messages: { list: async () => ({ data: {} }), get: async () => { throw new Error('should not be called'); } } } };
  const emails = await withClient(client, () => gmailService.getEmails({ query: 'x' }));
  assert.deepEqual(emails, []);
});
