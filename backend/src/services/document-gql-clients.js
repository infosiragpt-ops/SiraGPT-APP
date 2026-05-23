'use strict';

/**
 * document-gql-clients.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects GraphQL client library usage:
 *
 *   - Apollo:    ApolloClient / ApolloProvider / useQuery / useMutation /
 *                useSubscription / useLazyQuery / InMemoryCache / HttpLink /
 *                createHttpLink / from / split / ApolloLink
 *   - urql:      createClient / useQuery / useMutation / useSubscription /
 *                cacheExchange / fetchExchange / subscriptionExchange
 *   - Relay:     RelayEnvironmentProvider / useFragment / usePreloadedQuery /
 *                useLazyLoadQuery / commitMutation
 *   - graphql-request: GraphQLClient / request / rawRequest
 *   - Codegen:   gql.tada / TypedDocumentNode / DocumentNode
 *   - Templates: gql\`...\` / graphql\`...\`
 *
 *  Document classifies tagged-template GraphQL operations by keyword
 *  (query / mutation / subscription / fragment).
 *
 * Public API:
 *   extractGqlClients(text)             → { entries, totals, total }
 *   buildGqlClientsForFiles(files)      → { perFile, aggregate, totals }
 *   renderGqlClientsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const APOLLO_RE = /\b(?:new\s+)?(ApolloClient|ApolloProvider|InMemoryCache|HttpLink|createHttpLink|ApolloLink|from(?=\s*\()|split(?=\s*\()|MockedProvider)\b/g;
const URQL_RE = /\b(createClient|cacheExchange|fetchExchange|subscriptionExchange|dedupExchange|errorExchange|UrqlProvider|Provider(?=\s+value)|ssrExchange)\b/g;
const RELAY_RE = /\b(RelayEnvironmentProvider|useFragment|usePreloadedQuery|useLazyLoadQuery|useQueryLoader|usePaginationFragment|commitMutation|requestSubscription|fetchQuery)\b/g;
const HOOK_RE = /\b(useQuery|useMutation|useSubscription|useLazyQuery|useApolloClient|useReactiveVar)\s*[<(]/g;
const REQUEST_RE = /\b(GraphQLClient|gqlRequest|request|rawRequest|batchRequests)\s*\(\s*["'][^"'\n]{1,80}["']/g;
const GQL_TAG_RE = /\bgql\s*`([\s\S]{1,400}?)`/g;
const GRAPHQL_TAG_RE = /\bgraphql\s*`([\s\S]{1,400}?)`/g;
const TYPED_DOC_RE = /\b(TypedDocumentNode|DocumentNode|FragmentType|ResultOf|VariablesOf|gql\.tada)\b/g;
const CACHE_POLICY_RE = /\bfetchPolicy\s*:\s*["']?(cache-first|cache-only|cache-and-network|network-only|no-cache|standby)["']?/g;
const ERROR_POLICY_RE = /\berrorPolicy\s*:\s*["']?(none|ignore|all)["']?/g;

function classifyOperation(opText) {
  if (/^\s*query\b/i.test(opText)) return 'query';
  if (/^\s*mutation\b/i.test(opText)) return 'mutation';
  if (/^\s*subscription\b/i.test(opText)) return 'subscription';
  if (/^\s*fragment\b/i.test(opText)) return 'fragment';
  return 'anon';
}

function isGqlClientLike(body) {
  return /@apollo\/client|graphql-request|\burql\b|react-relay|\bgql\s*`|\bgraphql\s*`|\bApolloClient\b|\buseQuery\s*[<(]|\buseMutation\s*[<(]/.test(body);
}

function extractGqlClients(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isGqlClientLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    apollo: 0, urql: 0, relay: 0, hook: 0, request: 0,
    gqlTag: 0, typed: 0, fetchPolicy: 0, errorPolicy: 0,
    query: 0, mutation: 0, subscription: 0, fragment: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  APOLLO_RE.lastIndex = 0;
  let m;
  while ((m = APOLLO_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('apollo', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    URQL_RE.lastIndex = 0;
    while ((m = URQL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('urql', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RELAY_RE.lastIndex = 0;
    while ((m = RELAY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('relay', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    HOOK_RE.lastIndex = 0;
    while ((m = HOOK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('hook', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    REQUEST_RE.lastIndex = 0;
    while ((m = REQUEST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('request', m[1], null);
    }
  }

  // Tagged templates → classify by operation keyword
  for (const re of [GQL_TAG_RE, GRAPHQL_TAG_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(body)) && entries.length < MAX_PER_FILE) {
      const opType = classifyOperation(m[1]);
      // Extract optional name
      const nameMatch = m[1].match(/^\s*(?:query|mutation|subscription|fragment)\s+([A-Z][A-Za-z0-9_]{0,60})/);
      const opName = nameMatch ? nameMatch[1] : 'anonymous';
      if (totals[opType] != null) totals[opType] += 1;
      totals.gqlTag += 1;
      if (entries.length < MAX_PER_FILE) {
        push('gqlTag', `${opType}:${opName}`, null);
      }
    }
  }

  if (entries.length < MAX_PER_FILE) {
    TYPED_DOC_RE.lastIndex = 0;
    while ((m = TYPED_DOC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('typed', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CACHE_POLICY_RE.lastIndex = 0;
    while ((m = CACHE_POLICY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('fetchPolicy', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ERROR_POLICY_RE.lastIndex = 0;
    while ((m = ERROR_POLICY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('errorPolicy', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildGqlClientsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    apollo: 0, urql: 0, relay: 0, hook: 0, request: 0,
    gqlTag: 0, typed: 0, fetchPolicy: 0, errorPolicy: 0,
    query: 0, mutation: 0, subscription: 0, fragment: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractGqlClients(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderGqlClientsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## GRAPHQL CLIENTS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      lines.push(`- [${e.kind}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractGqlClients,
  buildGqlClientsForFiles,
  renderGqlClientsBlock,
  _internal: { classifyOperation, isGqlClientLike },
};
