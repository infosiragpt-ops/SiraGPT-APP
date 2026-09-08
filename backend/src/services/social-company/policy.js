'use strict';

const POLICY_PREFIX = 'social_company_policy:';
const SCOPED_POLICY_PREFIX = `${POLICY_PREFIX}v2:`;
const MODES = new Set(['review', 'auto']);

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  mode: 'review',
  autopilot: false,
  objective: '',
  dailyLimit: 3,
  platforms: {
    facebook: true,
    linkedin: true,
    x: true,
  },
  workspaceId: null,
  updatedAt: null,
});

function resolvePolicyScopeId(scope) {
  const values = scope && typeof scope === 'object' && !Array.isArray(scope)
    ? [scope.workspaceId, scope.projectId]
    : [scope];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 180) continue;
    if (normalized) return normalized;
  }
  return null;
}

function legacyPolicyKey(userId) {
  return `${POLICY_PREFIX}${String(userId)}`;
}

function policyKey(userId, scope) {
  const normalizedUserId = String(userId || '').trim();
  const scopeId = resolvePolicyScopeId(scope);
  if (!normalizedUserId || !scopeId) {
    const error = new Error('A user and workspace/project scope are required for social policy storage');
    error.code = 'SOCIAL_POLICY_SCOPE_REQUIRED';
    error.status = 400;
    throw error;
  }
  return `${SCOPED_POLICY_PREFIX}${encodeURIComponent(normalizedUserId)}:${encodeURIComponent(scopeId)}`;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function normalizePolicy(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawPlatforms = source.platforms && typeof source.platforms === 'object'
    ? source.platforms
    : {};
  const workspaceId = resolvePolicyScopeId(source);
  return {
    enabled: source.enabled === true,
    mode: MODES.has(source.mode) ? source.mode : DEFAULT_POLICY.mode,
    autopilot: source.autopilot === true,
    objective: typeof source.objective === 'string' ? source.objective.trim().slice(0, 2_000) : '',
    dailyLimit: boundedInteger(source.dailyLimit, DEFAULT_POLICY.dailyLimit, 1, 20),
    platforms: {
      facebook: rawPlatforms.facebook !== false,
      linkedin: rawPlatforms.linkedin !== false,
      x: rawPlatforms.x !== false,
    },
    workspaceId,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

function defaultPolicy(scope = null) {
  return {
    ...DEFAULT_POLICY,
    platforms: { ...DEFAULT_POLICY.platforms },
    workspaceId: resolvePolicyScopeId(scope),
  };
}

function policyFromRow(row, scope = null) {
  if (!row) return null;
  try {
    const policy = normalizePolicy(JSON.parse(row.value));
    const scopeId = resolvePolicyScopeId(scope);
    return scopeId ? normalizePolicy({ ...policy, workspaceId: scopeId }) : policy;
  } catch {
    return null;
  }
}

async function readPolicy(prisma, userId, scope = null) {
  const scopeId = resolvePolicyScopeId(scope);
  if (scope !== null && scope !== undefined && !scopeId) {
    return defaultPolicy();
  }
  if (!scopeId) {
    const legacy = await prisma.systemSettings.findUnique({
      where: { key: legacyPolicyKey(userId) },
    });
    return policyFromRow(legacy) || defaultPolicy();
  }

  const key = policyKey(userId, scopeId);
  const row = await prisma.systemSettings.findUnique({ where: { key } });
  const scopedPolicy = policyFromRow(row, scopeId);
  if (scopedPolicy) return scopedPolicy;

  // Legacy rows were keyed only by user. They are safe to inherit only when
  // their payload identifies this exact company. Copying that value forward
  // makes the next read independent without exposing it to sibling projects.
  const legacy = await prisma.systemSettings.findUnique({
    where: { key: legacyPolicyKey(userId) },
  });
  const legacyPolicy = policyFromRow(legacy);
  if (!legacyPolicy || legacyPolicy.workspaceId !== scopeId) return defaultPolicy(scopeId);
  const migrated = normalizePolicy({ ...legacyPolicy, workspaceId: scopeId });
  await prisma.systemSettings.upsert({
    where: { key },
    create: { key, value: JSON.stringify(migrated) },
    update: { value: JSON.stringify(migrated) },
  });
  return migrated;
}

async function writePolicy(prisma, userId, next, scope = null) {
  const scopeId = resolvePolicyScopeId(scope) || resolvePolicyScopeId(next);
  if (!scopeId) {
    const error = new Error('workspaceId or projectId is required to save a social policy');
    error.code = 'SOCIAL_POLICY_SCOPE_REQUIRED';
    error.status = 400;
    throw error;
  }
  const policy = normalizePolicy({
    ...next,
    workspaceId: scopeId,
    updatedAt: new Date().toISOString(),
  });
  const key = policyKey(userId, scopeId);
  await prisma.systemSettings.upsert({
    where: { key },
    create: { key, value: JSON.stringify(policy) },
    update: { value: JSON.stringify(policy) },
  });
  return policy;
}

function parsePolicyRow(row) {
  if (!row || typeof row.key !== 'string' || !row.key.startsWith(POLICY_PREFIX)) return null;
  try {
    let userId = row.key.slice(POLICY_PREFIX.length);
    let workspaceId = null;
    let storageVersion = 1;
    if (row.key.startsWith(SCOPED_POLICY_PREFIX)) {
      storageVersion = 2;
      const encoded = row.key.slice(SCOPED_POLICY_PREFIX.length);
      const separator = encoded.indexOf(':');
      if (separator <= 0 || separator === encoded.length - 1) return null;
      userId = decodeURIComponent(encoded.slice(0, separator));
      workspaceId = decodeURIComponent(encoded.slice(separator + 1));
      if (!userId || !workspaceId) return null;
    }
    const parsed = JSON.parse(row.value);
    const policy = normalizePolicy(workspaceId ? { ...parsed, workspaceId } : parsed);
    return {
      userId,
      workspaceId: policy.workspaceId,
      storageVersion,
      policy,
    };
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_POLICY,
  POLICY_PREFIX,
  SCOPED_POLICY_PREFIX,
  defaultPolicy,
  legacyPolicyKey,
  normalizePolicy,
  parsePolicyRow,
  policyKey,
  readPolicy,
  resolvePolicyScopeId,
  writePolicy,
};
