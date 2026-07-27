'use strict';

const { cleanPlatform, providerConfig } = require('./platforms');
const {
  publicationError,
  _internal: {
    ensureConnectionTokens,
    fetchJson,
  },
} = require('./publisher');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_LINKEDIN_POSTS = 10;
const MAX_ID_CHARS = 512;
const MAX_TEXT_CHARS = 4_000;
const MAX_SUBJECT_CHARS = 500;
const MAX_AUTHOR_NAME_CHARS = 200;
const MAX_REPLY_CHARS = 2_000;
const MAX_X_REPLY_CHARS = 280;
const CONVERSATION_PLATFORMS = new Set(['facebook', 'linkedin', 'x']);

function boundedText(value, max = MAX_TEXT_CHARS) {
  if (value === null || value === undefined) return '';
  return Array.from(String(value).trim()).slice(0, max).join('');
}

function optionalText(value, max) {
  const normalized = boundedText(value, max);
  return normalized || null;
}

function requiredIdentifier(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw publicationError(
      'SOCIAL_INTERACTION_INVALID',
      `${label} is required`,
      400,
    );
  }
  if (Array.from(normalized).length > MAX_ID_CHARS) {
    throw publicationError(
      'SOCIAL_INTERACTION_INVALID',
      `${label} is too long`,
      400,
    );
  }
  return normalized;
}

function normalizedLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

function isoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  let normalized = value;
  if (typeof value === 'number' && value > 0 && value < 1_000_000_000_000) {
    normalized = value * 1_000;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function providerUrl(config, path, query = {}) {
  const base = String(config.apiBase || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${suffix}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function scopeSet(...values) {
  const scopes = new Set();
  const collect = (value) => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value !== 'string') return;
    for (const scope of value.split(/[\s,]+/)) {
      const normalized = scope.trim().toLowerCase();
      if (normalized) scopes.add(normalized);
    }
  };
  values.forEach(collect);
  return scopes;
}

function linkedinActor(connection) {
  const accountId = requiredIdentifier(connection?.accountId, 'Social account id');
  if (accountId.startsWith('urn:li:')) return accountId;
  const organization = connection?.profile?.kind === 'organization';
  return `urn:li:${organization ? 'organization' : 'person'}:${accountId}`;
}

function requiredScopes(platform, operation, connection, tokens) {
  const scopes = scopeSet(
    connection?.scopes,
    tokens?.scope,
    tokens?.scopes,
  );
  let required;
  if (platform === 'facebook') {
    required = [operation === 'list' ? 'pages_read_engagement' : 'pages_manage_engagement'];
  } else if (platform === 'linkedin') {
    const actor = linkedinActor(connection);
    const organization = actor.startsWith('urn:li:organization:');
    required = [
      operation === 'list'
        ? (organization ? 'r_organization_social' : 'r_member_social')
        : (organization ? 'w_organization_social' : 'w_member_social'),
    ];
  } else {
    required = operation === 'list'
      ? ['tweet.read', 'users.read']
      : ['tweet.write'];
  }
  const missing = required.filter((scope) => !scopes.has(scope));
  if (missing.length) {
    throw publicationError(
      'SOCIAL_SCOPE_REQUIRED',
      `${platform} connection requires ${missing.join(', ')} permission`,
      409,
    );
  }
}

function bearerHeaders(accessToken, extra = {}) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    ...extra,
  };
}

function linkedinHeaders(config, accessToken, extra = {}) {
  return bearerHeaders(accessToken, {
    'Linkedin-Version': config.apiVersion,
    'X-Restli-Protocol-Version': '2.0.0',
    ...extra,
  });
}

async function connectionContext({
  connection,
  env,
  fetchImpl,
  vault,
  prisma,
  operation,
}) {
  const platform = cleanPlatform(connection?.platform);
  const config = providerConfig(platform, env);
  if (!platform || !config || !CONVERSATION_PLATFORMS.has(platform)) {
    throw publicationError(
      'SOCIAL_CONVERSATIONS_UNSUPPORTED',
      'Social conversations are not supported for this platform',
      400,
    );
  }
  requiredIdentifier(connection?.accountId, 'Social account id');
  const tokens = await ensureConnectionTokens({
    platform,
    config,
    connection,
    prisma,
    vault,
    fetchImpl,
  });
  requiredScopes(platform, operation, connection, tokens);
  return {
    platform,
    config,
    connection,
    tokens,
    fetchImpl,
  };
}

function newestFirst(interactions, limit) {
  return interactions
    .sort((left, right) => {
      const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
      const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
      return rightTime - leftTime;
    })
    .slice(0, limit);
}

async function listFacebookInteractions(context, limit) {
  const {
    config,
    connection,
    tokens,
    fetchImpl,
  } = context;
  const accountId = requiredIdentifier(connection.accountId, 'Facebook Page id');
  const fields = [
    'id',
    'message',
    'created_time',
    `comments.limit(${limit}){id,message,created_time,from{id,name},parent{id}}`,
  ].join(',');
  const result = await fetchJson(providerUrl(
    config,
    `/${encodeURIComponent(accountId)}/feed`,
    { fields, limit },
  ), {
    method: 'GET',
    headers: bearerHeaders(tokens.accessToken),
  }, fetchImpl);
  const posts = Array.isArray(result.body.data) ? result.body.data : [];
  const interactions = [];

  for (const post of posts) {
    const threadId = optionalText(post?.id, MAX_ID_CHARS);
    if (!threadId) continue;
    const comments = Array.isArray(post?.comments?.data) ? post.comments.data : [];
    for (const comment of comments) {
      const id = optionalText(comment?.id, MAX_ID_CHARS);
      const authorId = optionalText(comment?.from?.id, MAX_ID_CHARS);
      if (!id || (authorId && authorId === accountId)) continue;
      const parentId = optionalText(comment?.parent?.id, MAX_ID_CHARS) || threadId;
      interactions.push({
        platform: 'facebook',
        id,
        threadId,
        parentId,
        authorId,
        authorName: optionalText(comment?.from?.name, MAX_AUTHOR_NAME_CHARS),
        text: boundedText(comment?.message),
        createdAt: isoTimestamp(comment?.created_time),
        subject: optionalText(post?.message, MAX_SUBJECT_CHARS),
        metadata: {
          postId: threadId,
          commentId: id,
          parentId,
        },
      });
    }
  }
  return newestFirst(interactions, limit);
}

function linkedinAuthorName(comment) {
  const actor = comment?.['actor~'] || comment?.actorDetails || {};
  const explicit = optionalText(
    comment?.actorName || actor.name || actor.localizedName,
    MAX_AUTHOR_NAME_CHARS,
  );
  if (explicit) return explicit;
  return optionalText(
    [actor.localizedFirstName, actor.localizedLastName].filter(Boolean).join(' '),
    MAX_AUTHOR_NAME_CHARS,
  );
}

async function listLinkedInInteractions(context, limit) {
  const {
    config,
    connection,
    tokens,
    fetchImpl,
  } = context;
  const actor = linkedinActor(connection);
  const postsResult = await fetchJson(providerUrl(config, '/rest/posts', {
    q: 'author',
    author: actor,
    count: limit,
    sortBy: 'LAST_MODIFIED',
  }), {
    method: 'GET',
    headers: linkedinHeaders(config, tokens.accessToken),
  }, fetchImpl);
  const posts = Array.isArray(postsResult.body.elements)
    ? postsResult.body.elements.slice(0, Math.min(limit, MAX_LINKEDIN_POSTS))
    : [];
  const interactions = [];

  for (const post of posts) {
    if (interactions.length >= limit) break;
    const threadId = optionalText(post?.id, MAX_ID_CHARS);
    if (!threadId) continue;
    const commentsResult = await fetchJson(providerUrl(
      config,
      `/rest/socialActions/${encodeURIComponent(threadId)}/comments`,
      { count: Math.min(MAX_LIMIT, limit - interactions.length) },
    ), {
      method: 'GET',
      headers: linkedinHeaders(config, tokens.accessToken),
    }, fetchImpl);
    const comments = Array.isArray(commentsResult.body.elements)
      ? commentsResult.body.elements
      : [];
    for (const comment of comments) {
      const commentUrn = optionalText(comment?.commentUrn, MAX_ID_CHARS);
      const commentId = optionalText(comment?.id, MAX_ID_CHARS);
      const id = commentUrn || commentId;
      const authorUrn = optionalText(comment?.actor, MAX_ID_CHARS);
      if (!id || (authorUrn && authorUrn === actor)) continue;
      const parentId = optionalText(comment?.parentComment, MAX_ID_CHARS) || threadId;
      const objectUrn = optionalText(comment?.object, MAX_ID_CHARS) || threadId;
      interactions.push({
        platform: 'linkedin',
        id,
        threadId,
        parentId,
        authorId: authorUrn,
        authorName: linkedinAuthorName(comment),
        text: boundedText(comment?.message?.text || comment?.message),
        createdAt: isoTimestamp(comment?.created?.time || comment?.createdAt),
        subject: optionalText(post?.commentary, MAX_SUBJECT_CHARS),
        metadata: {
          postUrn: threadId,
          commentId,
          commentUrn,
          objectUrn,
          actorUrn: authorUrn,
        },
      });
      if (interactions.length >= limit) break;
    }
  }
  return newestFirst(interactions, limit);
}

async function listXInteractions(context, limit) {
  const {
    config,
    connection,
    tokens,
    fetchImpl,
  } = context;
  const accountId = requiredIdentifier(connection.accountId, 'X account id');
  const result = await fetchJson(providerUrl(
    config,
    `/2/users/${encodeURIComponent(accountId)}/mentions`,
    {
      max_results: Math.max(5, limit),
      'tweet.fields': 'author_id,created_at,conversation_id,referenced_tweets',
      expansions: 'author_id',
      'user.fields': 'id,name,username',
    },
  ), {
    method: 'GET',
    headers: bearerHeaders(tokens.accessToken),
  }, fetchImpl);
  const users = new Map(
    (Array.isArray(result.body.includes?.users) ? result.body.includes.users : [])
      .map((user) => [String(user?.id || ''), user]),
  );
  const posts = Array.isArray(result.body.data) ? result.body.data : [];
  const interactions = [];

  for (const post of posts) {
    const id = optionalText(post?.id, MAX_ID_CHARS);
    const authorId = optionalText(post?.author_id, MAX_ID_CHARS);
    if (!id || (authorId && authorId === accountId)) continue;
    const author = users.get(authorId) || {};
    const parentId = optionalText(
      post?.referenced_tweets?.find((reference) => reference?.type === 'replied_to')?.id,
      MAX_ID_CHARS,
    );
    const threadId = optionalText(post?.conversation_id, MAX_ID_CHARS) || id;
    const username = optionalText(author?.username || post?.username, MAX_AUTHOR_NAME_CHARS);
    interactions.push({
      platform: 'x',
      id,
      threadId,
      parentId,
      authorId,
      authorName: optionalText(author?.name, MAX_AUTHOR_NAME_CHARS) || username,
      text: boundedText(post?.text),
      createdAt: isoTimestamp(post?.created_at),
      subject: username ? `Mention from @${username.replace(/^@/, '')}` : 'Mention on X',
      metadata: {
        conversationId: threadId,
        username,
      },
    });
  }
  return newestFirst(interactions, limit);
}

async function listSocialInteractions({
  connection,
  env = process.env,
  fetchImpl = globalThis.fetch,
  vault = null,
  prisma = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const normalized = normalizedLimit(limit);
  const context = await connectionContext({
    connection,
    env,
    fetchImpl,
    vault,
    prisma,
    operation: 'list',
  });
  if (context.platform === 'facebook') {
    return listFacebookInteractions(context, normalized);
  }
  if (context.platform === 'linkedin') {
    return listLinkedInInteractions(context, normalized);
  }
  return listXInteractions(context, normalized);
}

function replyText(value, platform) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw publicationError(
      'SOCIAL_REPLY_REQUIRED',
      'Reply text is required',
      400,
    );
  }
  const maximum = platform === 'x' ? MAX_X_REPLY_CHARS : MAX_REPLY_CHARS;
  if (Array.from(normalized).length > maximum) {
    throw publicationError(
      'SOCIAL_REPLY_TOO_LONG',
      `${platform} replies are limited to ${maximum} characters`,
      422,
    );
  }
  return normalized;
}

function validateInteraction(interaction, platform) {
  if (cleanPlatform(interaction?.platform) !== platform) {
    throw publicationError(
      'SOCIAL_INTERACTION_PLATFORM_MISMATCH',
      'Interaction does not belong to the connected platform',
      409,
    );
  }
  return {
    id: requiredIdentifier(interaction?.id, 'Interaction id'),
    threadId: interaction?.threadId
      ? requiredIdentifier(interaction.threadId, 'Interaction thread id')
      : null,
    metadata: interaction?.metadata && typeof interaction.metadata === 'object'
      ? interaction.metadata
      : {},
  };
}

function replyEvidence(platform, externalId) {
  const normalized = optionalText(externalId, MAX_ID_CHARS);
  if (!normalized) {
    throw publicationError(
      'SOCIAL_REPLY_ID_MISSING',
      `${platform} returned no reply id`,
      503,
    );
  }
  return {
    platform,
    externalId: normalized,
    repliedAt: new Date().toISOString(),
  };
}

async function sendFacebookReply(context, interaction, text) {
  const result = await fetchJson(providerUrl(
    context.config,
    `/${encodeURIComponent(interaction.id)}/comments`,
  ), {
    method: 'POST',
    headers: bearerHeaders(context.tokens.accessToken, {
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    body: new URLSearchParams({ message: text }),
  }, context.fetchImpl);
  return replyEvidence('facebook', result.body.id);
}

async function sendLinkedInReply(context, interaction, text) {
  if (!interaction.threadId) {
    throw publicationError(
      'SOCIAL_INTERACTION_INVALID',
      'LinkedIn interaction thread id is required',
      400,
    );
  }
  const parentComment = requiredIdentifier(
    interaction.metadata.commentUrn || interaction.id,
    'LinkedIn parent comment',
  );
  const objectUrn = requiredIdentifier(
    interaction.metadata.objectUrn || interaction.threadId,
    'LinkedIn interaction object',
  );
  const result = await fetchJson(providerUrl(
    context.config,
    `/rest/socialActions/${encodeURIComponent(interaction.threadId)}/comments`,
  ), {
    method: 'POST',
    headers: linkedinHeaders(context.config, context.tokens.accessToken, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({
      actor: linkedinActor(context.connection),
      object: objectUrn,
      message: { text },
      parentComment,
    }),
  }, context.fetchImpl);
  return replyEvidence(
    'linkedin',
    result.response.headers?.get?.('x-restli-id')
      || result.body.commentUrn
      || result.body.id,
  );
}

async function sendXReply(context, interaction, text) {
  const result = await fetchJson(providerUrl(context.config, '/2/tweets'), {
    method: 'POST',
    headers: bearerHeaders(context.tokens.accessToken, {
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({
      text,
      reply: {
        in_reply_to_tweet_id: interaction.id,
      },
    }),
  }, context.fetchImpl);
  return replyEvidence('x', result.body.data?.id);
}

async function sendSocialReply({
  connection,
  interaction,
  text,
  env = process.env,
  fetchImpl = globalThis.fetch,
  vault = null,
  prisma = null,
} = {}) {
  const platform = cleanPlatform(connection?.platform);
  const normalizedText = replyText(text, platform);
  const normalizedInteraction = validateInteraction(interaction, platform);
  const context = await connectionContext({
    connection,
    env,
    fetchImpl,
    vault,
    prisma,
    operation: 'reply',
  });
  if (context.platform === 'facebook') {
    return sendFacebookReply(context, normalizedInteraction, normalizedText);
  }
  if (context.platform === 'linkedin') {
    return sendLinkedInReply(context, normalizedInteraction, normalizedText);
  }
  return sendXReply(context, normalizedInteraction, normalizedText);
}

module.exports = {
  listSocialInteractions,
  sendSocialReply,
  _internal: {
    isoTimestamp,
    linkedinActor,
    normalizedLimit,
    providerUrl,
    requiredScopes,
  },
};
