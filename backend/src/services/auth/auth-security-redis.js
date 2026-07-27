'use strict';

const READINESS_LUA = [
  '-- auth-security-readiness-v1',
  "local present = redis.call('EXISTS', KEYS[1])",
  'if present >= 0 then return 1 end',
  'return 0',
].join('\n');

const DEFAULT_MAX_MEMORY_RATIO = 0.9;

function clampRatio(value, fallback = DEFAULT_MAX_MEMORY_RATIO) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0.5, Math.min(0.99, parsed));
}

function resolveMaxMemoryRatio(env = process.env) {
  return clampRatio(env.AUTH_SECURITY_REDIS_MAX_MEMORY_RATIO);
}

function sanitizeRedisPrefix(value) {
  const raw = String(value || '').replace(/[{}]/g, '_');
  return raw.endsWith(':') ? raw : `${raw}:`;
}

function clusterSafePrefix(prefix, hashTag) {
  const safeTag = String(hashTag || '')
    .replace(/[{}]/g, '_')
    .slice(0, 160);
  if (!safeTag) throw new TypeError('Redis Cluster hash tag is required');
  return `${sanitizeRedisPrefix(prefix)}{${safeTag}}:`;
}

function parseInfo(raw) {
  const fields = Object.create(null);
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return fields;
}

function redisHealthError(code, redisHealth) {
  const error = new Error(code);
  error.code = code;
  error.redisHealth = redisHealth;
  return error;
}

async function probeAuthSecurityRedis({
  redis,
  run,
  env = process.env,
  production = false,
  probeKey,
}) {
  if (!redis || typeof redis.eval !== 'function') {
    throw redisHealthError('AUTH_SECURITY_REDIS_LUA_UNSUPPORTED', {
      luaSupported: false,
      redisPolicy: null,
      capacityKnown: false,
      capacityOk: false,
      memoryUtilization: null,
    });
  }

  const evalResult = await run(() => redis.eval(
    READINESS_LUA,
    1,
    String(probeKey),
  ));
  if (Number(evalResult) !== 1) {
    throw redisHealthError('AUTH_SECURITY_REDIS_LUA_UNSUPPORTED', {
      luaSupported: false,
      redisPolicy: null,
      capacityKnown: false,
      capacityOk: false,
      memoryUtilization: null,
    });
  }

  if (typeof redis.info !== 'function') {
    const unknown = {
      luaSupported: true,
      redisPolicy: null,
      capacityKnown: false,
      capacityOk: !production,
      memoryUtilization: null,
      usedMemoryBytes: null,
      maxMemoryBytes: null,
    };
    if (production) {
      throw redisHealthError('AUTH_SECURITY_REDIS_MEMORY_INFO_UNSUPPORTED', unknown);
    }
    return unknown;
  }

  const fields = parseInfo(await run(() => redis.info('memory')));
  const redisPolicy = fields.maxmemory_policy || null;
  const usedMemoryBytes = Number(fields.used_memory);
  const maxMemoryBytes = Number(fields.maxmemory);
  const hasBoundedMemory = Number.isFinite(maxMemoryBytes) && maxMemoryBytes > 0;
  const capacityKnown = (
    hasBoundedMemory
    && Number.isFinite(usedMemoryBytes)
    && usedMemoryBytes >= 0
  );
  const memoryUtilization = capacityKnown ? usedMemoryBytes / maxMemoryBytes : null;
  const maxMemoryRatio = resolveMaxMemoryRatio(env);
  const capacityOk = capacityKnown
    ? memoryUtilization < maxMemoryRatio
    : !production;
  const redisHealth = {
    luaSupported: true,
    redisPolicy,
    capacityKnown,
    capacityOk,
    memoryUtilization,
    usedMemoryBytes: Number.isFinite(usedMemoryBytes) ? usedMemoryBytes : null,
    maxMemoryBytes: Number.isFinite(maxMemoryBytes) ? maxMemoryBytes : null,
    maxMemoryRatio,
  };

  if (production && redisPolicy !== 'noeviction') {
    throw redisHealthError('AUTH_SECURITY_REDIS_EVICTION_POLICY_UNSAFE', redisHealth);
  }
  if (production && !capacityKnown) {
    throw redisHealthError('AUTH_SECURITY_REDIS_CAPACITY_UNKNOWN', redisHealth);
  }
  if (production && !capacityOk) {
    throw redisHealthError('AUTH_SECURITY_REDIS_CAPACITY_LOW', redisHealth);
  }
  return redisHealth;
}

module.exports = {
  DEFAULT_MAX_MEMORY_RATIO,
  READINESS_LUA,
  clusterSafePrefix,
  parseInfo,
  probeAuthSecurityRedis,
  resolveMaxMemoryRatio,
};
