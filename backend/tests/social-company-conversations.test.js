'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  listSocialInteractions,
  sendSocialReply,
} = require('../src/services/social-company/conversations');

const ACCESS_TOKEN = 'opened-provider-token-value';
const SOCIAL_ENV = Object.freeze({
  NODE_ENV: 'test',
  FRONTEND_URL: 'http://localhost:3000',
  BACKEND_PUBLIC_URL: 'http://localhost:5000',
  SOCIAL_FACEBOOK_API_VERSION: 'v23.0',
  SOCIAL_LINKEDIN_API_VERSION: '202607',
  SOCIAL_X_CLIENT_ID: 'x-client',
});

const vault = {
  openProviderTokens: () => ({
    accessToken: ACCESS_TOKEN,
    expiresAt: Date.now() + 60_000,
  }),
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function connection(platform, overrides = {}) {
  const scopes = {
    facebook: ['pages_read_engagement', 'pages_manage_engagement'],
    linkedin: ['r_member_social', 'w_member_social'],
    x: ['tweet.read', 'tweet.write', 'users.read'],
  };
  return {
    id: `connection-${platform}`,
    platform,
    accountId: `${platform}-owner`,
    accessToken: 'sealed-token-envelope',
    scopes: scopes[platform],
    profile: { kind: 'person' },
    ...overrides,
  };
}

function assertTokenOnlyInHeader(calls) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url.includes(ACCESS_TOKEN), false);
    assert.equal(call.url.includes('access_token='), false);
    assert.equal(call.init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  }
}

test('lists Facebook Page comments, filters own comments, and never puts token in URL', async () => {
  const calls = [];
  const interactions = await listSocialInteractions({
    connection: connection('facebook', { accountId: 'page-9' }),
    env: SOCIAL_ENV,
    vault,
    limit: 3,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        data: [{
          id: 'page-9_post-1',
          message: 'Oferta de la semana',
          comments: {
            data: [
              {
                id: 'comment-customer',
                message: '¿Todavía está disponible?',
                created_time: '2026-07-27T10:00:00Z',
                from: { id: 'customer-1', name: 'Ana Cliente' },
                parent: { id: 'page-9_post-1' },
              },
              {
                id: 'comment-own',
                message: 'Sí, escríbenos.',
                created_time: '2026-07-27T10:01:00Z',
                from: { id: 'page-9', name: 'Página' },
              },
            ],
          },
        }],
      });
    },
  });

  assert.equal(interactions.length, 1);
  assert.deepEqual(interactions[0], {
    platform: 'facebook',
    id: 'comment-customer',
    threadId: 'page-9_post-1',
    parentId: 'page-9_post-1',
    authorId: 'customer-1',
    authorName: 'Ana Cliente',
    text: '¿Todavía está disponible?',
    createdAt: '2026-07-27T10:00:00.000Z',
    subject: 'Oferta de la semana',
    metadata: {
      postId: 'page-9_post-1',
      commentId: 'comment-customer',
      parentId: 'page-9_post-1',
    },
  });
  const request = new URL(calls[0].url);
  assert.equal(request.pathname, '/v23.0/page-9/feed');
  assert.match(request.searchParams.get('fields'), /comments\.limit\(3\)/);
  assertTokenOnlyInHeader(calls);
});

test('sends a Facebook reply to the comment endpoint with form content', async () => {
  const calls = [];
  const evidence = await sendSocialReply({
    connection: connection('facebook', { accountId: 'page-9' }),
    env: SOCIAL_ENV,
    interaction: {
      platform: 'facebook',
      id: 'comment-1',
      threadId: 'post-1',
    },
    text: 'Sí, te enviamos los detalles.',
    vault,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ id: 'reply-fb-1' }, 201);
    },
  });

  assert.equal(new URL(calls[0].url).pathname, '/v23.0/comment-1/comments');
  assert.equal(calls[0].init.body.get('message'), 'Sí, te enviamos los detalles.');
  assert.equal(
    calls[0].init.headers['Content-Type'],
    'application/x-www-form-urlencoded',
  );
  assert.equal(evidence.platform, 'facebook');
  assert.equal(evidence.externalId, 'reply-fb-1');
  assert.match(evidence.repliedAt, /^\d{4}-\d{2}-\d{2}T/);
  assertTokenOnlyInHeader(calls);
});

test('lists LinkedIn post comments through the author finder and filters own actor', async () => {
  const calls = [];
  const postUrn = 'urn:li:share:7001';
  const customerCommentUrn = 'urn:li:comment:(urn:li:activity:7001,8001)';
  const interactions = await listSocialInteractions({
    connection: connection('linkedin', { accountId: 'member-1' }),
    env: SOCIAL_ENV,
    vault,
    limit: 5,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/rest/posts?')) {
        return jsonResponse({
          elements: [{
            id: postUrn,
            commentary: 'Lanzamiento del producto',
          }],
        });
      }
      return jsonResponse({
        elements: [
          {
            actor: 'urn:li:person:customer-1',
            actorName: 'Cliente LinkedIn',
            commentUrn: customerCommentUrn,
            id: '8001',
            object: 'urn:li:activity:7001',
            created: { time: 1785146400000 },
            message: { text: 'Quiero una demostración' },
          },
          {
            actor: 'urn:li:person:member-1',
            commentUrn: 'urn:li:comment:(urn:li:activity:7001,8002)',
            id: '8002',
            message: { text: 'Te contactaremos.' },
          },
        ],
      });
    },
  });

  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].id, customerCommentUrn);
  assert.equal(interactions[0].threadId, postUrn);
  assert.equal(interactions[0].authorId, 'urn:li:person:customer-1');
  assert.equal(interactions[0].text, 'Quiero una demostración');
  assert.equal(interactions[0].metadata.commentId, '8001');
  const finder = new URL(calls[0].url);
  assert.equal(finder.pathname, '/rest/posts');
  assert.equal(finder.searchParams.get('q'), 'author');
  assert.equal(finder.searchParams.get('author'), 'urn:li:person:member-1');
  assert.match(calls[1].url, /\/rest\/socialActions\/urn%3Ali%3Ashare%3A7001\/comments/);
  assert.equal(calls[0].init.headers['Linkedin-Version'], '202607');
  assertTokenOnlyInHeader(calls);
});

test('sends a nested LinkedIn comment with parentComment and object evidence', async () => {
  const calls = [];
  const postUrn = 'urn:li:share:7001';
  const commentUrn = 'urn:li:comment:(urn:li:activity:7001,8001)';
  const evidence = await sendSocialReply({
    connection: connection('linkedin', { accountId: 'member-1' }),
    env: SOCIAL_ENV,
    interaction: {
      platform: 'linkedin',
      id: commentUrn,
      threadId: postUrn,
      metadata: {
        commentUrn,
        objectUrn: 'urn:li:activity:7001',
      },
    },
    text: 'Coordinemos la demostración.',
    vault,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(
        { id: 'reply-body-id' },
        201,
        { 'x-restli-id': 'reply-linkedin-1' },
      );
    },
  });

  assert.match(calls[0].url, /\/rest\/socialActions\/urn%3Ali%3Ashare%3A7001\/comments$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    actor: 'urn:li:person:member-1',
    object: 'urn:li:activity:7001',
    message: { text: 'Coordinemos la demostración.' },
    parentComment: commentUrn,
  });
  assert.deepEqual(
    { platform: evidence.platform, externalId: evidence.externalId },
    { platform: 'linkedin', externalId: 'reply-linkedin-1' },
  );
  assertTokenOnlyInHeader(calls);
});

test('lists X mentions with expanded authors, filters self, and respects API minimum page size', async () => {
  const calls = [];
  const interactions = await listSocialInteractions({
    connection: connection('x', { accountId: '2244994945' }),
    env: SOCIAL_ENV,
    vault,
    limit: 2,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        data: [
          {
            id: 'tweet-customer',
            author_id: 'customer-x',
            text: '@empresa necesito información',
            created_at: '2026-07-27T12:00:00Z',
            conversation_id: 'conversation-1',
            referenced_tweets: [{ type: 'replied_to', id: 'tweet-root' }],
          },
          {
            id: 'tweet-own',
            author_id: '2244994945',
            text: 'Respuesta propia',
            conversation_id: 'conversation-1',
          },
        ],
        includes: {
          users: [{
            id: 'customer-x',
            name: 'Cliente X',
            username: 'cliente_x',
          }],
        },
      });
    },
  });

  assert.equal(interactions.length, 1);
  assert.deepEqual(interactions[0], {
    platform: 'x',
    id: 'tweet-customer',
    threadId: 'conversation-1',
    parentId: 'tweet-root',
    authorId: 'customer-x',
    authorName: 'Cliente X',
    text: '@empresa necesito información',
    createdAt: '2026-07-27T12:00:00.000Z',
    subject: 'Mention from @cliente_x',
    metadata: {
      conversationId: 'conversation-1',
      username: 'cliente_x',
    },
  });
  const request = new URL(calls[0].url);
  assert.equal(request.pathname, '/2/users/2244994945/mentions');
  assert.equal(request.searchParams.get('max_results'), '5');
  assert.equal(request.searchParams.get('expansions'), 'author_id');
  assertTokenOnlyInHeader(calls);
});

test('sends an X reply with reply.in_reply_to_tweet_id', async () => {
  const calls = [];
  const evidence = await sendSocialReply({
    connection: connection('x', { accountId: '2244994945' }),
    env: SOCIAL_ENV,
    interaction: {
      platform: 'x',
      id: 'tweet-customer',
      threadId: 'conversation-1',
    },
    text: 'Te escribimos con la información.',
    vault,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        data: { id: 'tweet-reply-1' },
      }, 201);
    },
  });

  assert.equal(calls[0].url, 'https://api.x.com/2/tweets');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: 'Te escribimos con la información.',
    reply: { in_reply_to_tweet_id: 'tweet-customer' },
  });
  assert.equal(evidence.platform, 'x');
  assert.equal(evidence.externalId, 'tweet-reply-1');
  assertTokenOnlyInHeader(calls);
});

test('fails closed on missing provider scopes before any network call', async (t) => {
  const cases = [
    ['facebook', [], 'pages_read_engagement'],
    ['linkedin', ['w_member_social'], 'r_member_social'],
    ['x', ['tweet.read'], 'users.read'],
  ];
  for (const [platform, scopes, expected] of cases) {
    await t.test(platform, async () => {
      let called = false;
      await assert.rejects(
        () => listSocialInteractions({
          connection: connection(platform, { scopes }),
          env: SOCIAL_ENV,
          vault,
          fetchImpl: async () => {
            called = true;
            return jsonResponse({});
          },
        }),
        (error) => {
          assert.equal(error.code, 'SOCIAL_SCOPE_REQUIRED');
          assert.match(error.message, new RegExp(expected.replace('.', '\\.')));
          assert.equal(error.message.includes(ACCESS_TOKEN), false);
          return true;
        },
      );
      assert.equal(called, false);
    });
  }
});

test('fails closed for a connected platform without a conversations adapter', async () => {
  let called = false;
  await assert.rejects(
    () => listSocialInteractions({
      connection: {
        id: 'connection-instagram',
        platform: 'instagram',
        accountId: 'instagram-owner',
        accessToken: 'sealed-token-envelope',
        scopes: [],
      },
      env: SOCIAL_ENV,
      vault,
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    }),
    (error) => {
      assert.equal(error.code, 'SOCIAL_CONVERSATIONS_UNSUPPORTED');
      return true;
    },
  );
  assert.equal(called, false);
});

test('fails closed on missing reply scopes for every provider', async (t) => {
  const cases = [
    ['facebook', ['pages_read_engagement'], 'facebook-comment'],
    ['linkedin', ['r_member_social'], 'urn:li:comment:(urn:li:activity:1,2)'],
    ['x', ['tweet.read', 'users.read'], 'x-post-1'],
  ];
  for (const [platform, scopes, interactionId] of cases) {
    await t.test(platform, async () => {
      let called = false;
      await assert.rejects(
        () => sendSocialReply({
          connection: connection(platform, { scopes }),
          interaction: {
            platform,
            id: interactionId,
            threadId: platform === 'linkedin' ? 'urn:li:share:1' : 'thread-1',
          },
          text: 'Respuesta',
          env: SOCIAL_ENV,
          vault,
          fetchImpl: async () => {
            called = true;
            return jsonResponse({});
          },
        }),
        (error) => error.code === 'SOCIAL_SCOPE_REQUIRED',
      );
      assert.equal(called, false);
    });
  }
});

test('surfaces explicit provider rejection without exposing bearer token', async () => {
  await assert.rejects(
    () => listSocialInteractions({
      connection: connection('x'),
      env: SOCIAL_ENV,
      vault,
      fetchImpl: async () => jsonResponse({
        error: {
          message: 'insufficient provider access',
        },
      }, 403),
    }),
    (error) => {
      assert.equal(error.code, 'SOCIAL_PROVIDER_REJECTED');
      assert.equal(error.status, 422);
      assert.match(error.message, /HTTP 403/);
      assert.equal(error.message.includes(ACCESS_TOKEN), false);
      return true;
    },
  );
});

test('rejects oversized replies and cross-platform interactions before fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({});
  };

  await assert.rejects(
    () => sendSocialReply({
      connection: connection('x'),
      env: SOCIAL_ENV,
      interaction: { platform: 'x', id: 'tweet-1' },
      text: 'x'.repeat(281),
      vault,
      fetchImpl,
    }),
    (error) => error.code === 'SOCIAL_REPLY_TOO_LONG',
  );
  await assert.rejects(
    () => sendSocialReply({
      connection: connection('facebook'),
      env: SOCIAL_ENV,
      interaction: { platform: 'x', id: 'tweet-1' },
      text: 'Respuesta válida',
      vault,
      fetchImpl,
    }),
    (error) => error.code === 'SOCIAL_INTERACTION_PLATFORM_MISMATCH',
  );
  assert.equal(calls, 0);
});
