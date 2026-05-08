'use strict';

// Declarative schema for the GraphQL spike. Types map to internal resources
// (User, Chat, File, AgentTask) and link to resolver functions in resolvers.js.
// We intentionally keep this as plain objects rather than SDL — no runtime
// dependency, easy to introspect, and small enough to read top-to-bottom.

const SCALARS = new Set(['ID', 'String', 'Int', 'Float', 'Boolean', 'JSON', 'DateTime']);

function field(type, opts = {}) {
  return { type, args: opts.args || {}, resolve: opts.resolve, description: opts.description };
}

function buildSchema(resolvers) {
  const r = resolvers;

  const types = {
    User: {
      fields: {
        id: field('ID!'),
        email: field('String!'),
        name: field('String'),
        createdAt: field('DateTime'),
        chats: field('[Chat!]!', {
          args: { limit: 'Int', search: 'String' },
          resolve: (parent, args, ctx) => r.user.chats(parent, args, ctx),
        }),
        files: field('[File!]!', {
          args: { limit: 'Int' },
          resolve: (parent, args, ctx) => r.user.files(parent, args, ctx),
        }),
      },
    },
    Chat: {
      fields: {
        id: field('ID!'),
        name: field('String'),
        description: field('String'),
        isStarred: field('Boolean'),
        createdAt: field('DateTime'),
        updatedAt: field('DateTime'),
        messageCount: field('Int', {
          resolve: (parent, _a, ctx) => r.chat.messageCount(parent, _a, ctx),
        }),
        owner: field('User', {
          resolve: (parent, _a, ctx) => r.chat.owner(parent, _a, ctx),
        }),
        files: field('[File!]!', {
          resolve: (parent, _a, ctx) => r.chat.files(parent, _a, ctx),
        }),
      },
    },
    File: {
      fields: {
        id: field('ID!'),
        originalName: field('String!'),
        mimeType: field('String'),
        size: field('Int'),
        createdAt: field('DateTime'),
      },
    },
    AgentTask: {
      fields: {
        id: field('ID!'),
        userId: field('ID!'),
        kind: field('String'),
        status: field('String!'),
        createdAt: field('DateTime'),
        updatedAt: field('DateTime'),
        progress: field('Float'),
        result: field('JSON'),
        error: field('String'),
      },
    },
  };

  const Query = {
    fields: {
      me: field('User', {
        resolve: (_p, _a, ctx) => r.query.me(_p, _a, ctx),
      }),
      user: field('User', {
        args: { id: 'ID!' },
        resolve: (_p, a, ctx) => r.query.user(_p, a, ctx),
      }),
      chat: field('Chat', {
        args: { id: 'ID!' },
        resolve: (_p, a, ctx) => r.query.chat(_p, a, ctx),
      }),
      chats: field('[Chat!]!', {
        args: { limit: 'Int', offset: 'Int', search: 'String' },
        resolve: (_p, a, ctx) => r.query.chats(_p, a, ctx),
      }),
      agentTask: field('AgentTask', {
        args: { id: 'ID!' },
        resolve: (_p, a, ctx) => r.query.agentTask(_p, a, ctx),
      }),
      agentTasks: field('[AgentTask!]!', {
        args: { status: 'String', limit: 'Int' },
        resolve: (_p, a, ctx) => r.query.agentTasks(_p, a, ctx),
      }),
    },
  };

  const Mutation = {
    fields: {
      createChat: field('Chat!', {
        args: { name: 'String!', description: 'String' },
        resolve: (_p, a, ctx) => r.mutation.createChat(_p, a, ctx),
      }),
      starChat: field('Chat!', {
        args: { id: 'ID!', starred: 'Boolean!' },
        resolve: (_p, a, ctx) => r.mutation.starChat(_p, a, ctx),
      }),
      enqueueAgentTask: field('AgentTask!', {
        args: { kind: 'String!', input: 'JSON' },
        resolve: (_p, a, ctx) => r.mutation.enqueueAgentTask(_p, a, ctx),
      }),
    },
  };

  return {
    types: { ...types, Query, Mutation },
    rootTypeFor(operation) {
      return operation === 'mutation' ? 'Mutation' : 'Query';
    },
  };
}

function unwrapType(typeStr) {
  let t = typeStr.trim();
  let nonNull = false;
  if (t.endsWith('!')) { nonNull = true; t = t.slice(0, -1).trim(); }
  let list = false;
  let inner = t;
  if (t.startsWith('[') && t.endsWith(']')) {
    list = true;
    inner = t.slice(1, -1).trim();
    if (inner.endsWith('!')) inner = inner.slice(0, -1).trim();
  }
  return { nonNull, list, named: inner, isScalar: SCALARS.has(inner) };
}

module.exports = { buildSchema, unwrapType, SCALARS };
