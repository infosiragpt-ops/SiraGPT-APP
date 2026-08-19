'use strict';

/**
 * document-redis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Redis client method calls and key patterns:
 *
 *   - String:     SET / GET / GETSET / INCR / DECR / APPEND / STRLEN / MGET / MSET
 *   - Hash:       HSET / HGET / HGETALL / HMSET / HDEL / HKEYS / HEXISTS
 *   - List:       LPUSH / RPUSH / LPOP / RPOP / LRANGE / LLEN / BLPOP / BRPOP
 *   - Set:        SADD / SREM / SMEMBERS / SISMEMBER / SUNION / SINTER
 *   - Sorted set: ZADD / ZRANGE / ZRANGEBYSCORE / ZINCRBY / ZSCORE / ZREVRANGE
 *   - Expiry:     EXPIRE / EXPIREAT / TTL / PERSIST / PTTL
 *   - Pub/Sub:    PUBLISH / SUBSCRIBE / PSUBSCRIBE / UNSUBSCRIBE
 *   - Script:     EVAL / EVALSHA / SCRIPT_LOAD
 *   - Server:     KEYS / SCAN / DEL / EXISTS / FLUSHDB / FLUSHALL / DBSIZE
 *   - Stream:     XADD / XREAD / XRANGE / XLEN / XGROUP
 *   - Pipeline:   pipeline() / multi() / exec()
 *
 * Public API:
 *   extractRedis(text)             → { entries, totals, total }
 *   buildRedisForFiles(files)      → { perFile, aggregate, totals }
 *   renderRedisBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const STRING_OPS = new Set(['set', 'get', 'getset', 'incr', 'decr', 'incrby', 'decrby', 'append', 'strlen', 'mget', 'mset', 'setnx', 'setex', 'psetex', 'getex', 'getdel']);
const HASH_OPS = new Set(['hset', 'hget', 'hgetall', 'hmset', 'hmget', 'hdel', 'hkeys', 'hvals', 'hexists', 'hincrby', 'hlen', 'hscan']);
const LIST_OPS = new Set(['lpush', 'rpush', 'lpop', 'rpop', 'lrange', 'llen', 'lindex', 'lset', 'lrem', 'ltrim', 'blpop', 'brpop', 'lmove', 'rpoplpush']);
const SET_OPS = new Set(['sadd', 'srem', 'smembers', 'sismember', 'scard', 'sunion', 'sinter', 'sdiff', 'spop', 'srandmember', 'sscan']);
const ZSET_OPS = new Set(['zadd', 'zrem', 'zrange', 'zrevrange', 'zrangebyscore', 'zrevrangebyscore', 'zrank', 'zrevrank', 'zincrby', 'zscore', 'zcard', 'zcount', 'zscan', 'zpopmin', 'zpopmax']);
const EXPIRY_OPS = new Set(['expire', 'expireat', 'pexpire', 'pexpireat', 'ttl', 'pttl', 'persist']);
const PUBSUB_OPS = new Set(['publish', 'subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe', 'pubsub']);
const SCRIPT_OPS = new Set(['eval', 'evalsha', 'scriptload', 'script_load', 'scriptexists']);
const SERVER_OPS = new Set(['keys', 'scan', 'del', 'unlink', 'exists', 'flushdb', 'flushall', 'dbsize', 'type', 'rename', 'renamenx', 'dump', 'restore', 'select', 'info', 'ping', 'auth']);
const STREAM_OPS = new Set(['xadd', 'xread', 'xrange', 'xrevrange', 'xlen', 'xdel', 'xtrim', 'xgroup', 'xreadgroup', 'xack', 'xclaim', 'xinfo']);
const PIPELINE_OPS = new Set(['pipeline', 'multi', 'exec', 'discard', 'watch', 'unwatch']);

const METHOD_RE = /\b(?:redis|client|cache|store|r|conn|sub|pub|pipeline|multi|tx|ioredis)\.([a-z][a-z_A-Z0-9]{1,30})\s*\(/g;
const KEY_PATTERN_RE = /["']((?:[a-z][a-z0-9._-]{1,40}:){1,5}(?:[a-z0-9*?_-]{1,40}|\{[a-z0-9_-]+\}))["']/gi;
const CHANNEL_RE = /\b(?:publish|subscribe|psubscribe)\s*\(\s*["']([a-zA-Z][a-zA-Z0-9._:*-]{1,80})["']/g;

function classifyOp(op) {
  const lc = op.toLowerCase();
  if (STRING_OPS.has(lc)) return 'string';
  if (HASH_OPS.has(lc)) return 'hash';
  if (LIST_OPS.has(lc)) return 'list';
  if (SET_OPS.has(lc)) return 'set';
  if (ZSET_OPS.has(lc)) return 'zset';
  if (EXPIRY_OPS.has(lc)) return 'expiry';
  if (PUBSUB_OPS.has(lc)) return 'pubsub';
  if (SCRIPT_OPS.has(lc)) return 'script';
  if (SERVER_OPS.has(lc)) return 'server';
  if (STREAM_OPS.has(lc)) return 'stream';
  if (PIPELINE_OPS.has(lc)) return 'pipeline';
  return null;
}

function isRedisLike(body) {
  return /\b(?:redis|client|cache|r|conn)\.(?:set|get|hset|hget|lpush|sadd|zadd|expire|publish|subscribe|eval|keys|scan|xadd|pipeline|multi)\s*\(|require\(['"]ioredis['"]\)|from\s+['"]ioredis['"]|new\s+Redis\b/.test(body);
}

function extractRedis(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isRedisLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    string: 0, hash: 0, list: 0, set: 0, zset: 0,
    expiry: 0, pubsub: 0, script: 0, server: 0, stream: 0, pipeline: 0,
    keyPattern: 0, channel: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  METHOD_RE.lastIndex = 0;
  let m;
  while ((m = METHOD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const cat = classifyOp(m[1]);
    if (!cat) continue;
    push(cat, m[1].toUpperCase(), null);
  }
  if (entries.length < MAX_PER_FILE) {
    CHANNEL_RE.lastIndex = 0;
    while ((m = CHANNEL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('channel', m[1].slice(0, 60), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    KEY_PATTERN_RE.lastIndex = 0;
    while ((m = KEY_PATTERN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const k = m[1];
      // skip file paths / URLs
      if (/^https?:\/\//.test(k)) continue;
      if (/\.(js|ts|json|yaml|html|css|md|png|jpg|svg)$/i.test(k)) continue;
      push('keyPattern', k.slice(0, 60), null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildRedisForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    string: 0, hash: 0, list: 0, set: 0, zset: 0,
    expiry: 0, pubsub: 0, script: 0, server: 0, stream: 0, pipeline: 0,
    keyPattern: 0, channel: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractRedis(txt);
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

function renderRedisBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## REDIS COMMANDS'];
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
  extractRedis,
  buildRedisForFiles,
  renderRedisBlock,
  _internal: { classifyOp, isRedisLike },
};
