'use strict';

const POLICY_PREFIX = 'social_company_policy:';
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

function policyKey(userId) {
  return `${POLICY_PREFIX}${String(userId)}`;
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
    workspaceId: typeof source.workspaceId === 'string'
      ? source.workspaceId.trim().slice(0, 180) || null
      : null,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

async function readPolicy(prisma, userId) {
  const row = await prisma.systemSettings.findUnique({ where: { key: policyKey(userId) } });
  if (!row) return { ...DEFAULT_POLICY, platforms: { ...DEFAULT_POLICY.platforms } };
  try {
    return normalizePolicy(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_POLICY, platforms: { ...DEFAULT_POLICY.platforms } };
  }
}

async function writePolicy(prisma, userId, next) {
  const policy = normalizePolicy({ ...next, updatedAt: new Date().toISOString() });
  await prisma.systemSettings.upsert({
    where: { key: policyKey(userId) },
    create: { key: policyKey(userId), value: JSON.stringify(policy) },
    update: { value: JSON.stringify(policy) },
  });
  return policy;
}

function parsePolicyRow(row) {
  if (!row || typeof row.key !== 'string' || !row.key.startsWith(POLICY_PREFIX)) return null;
  try {
    return {
      userId: row.key.slice(POLICY_PREFIX.length),
      policy: normalizePolicy(JSON.parse(row.value)),
    };
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_POLICY,
  POLICY_PREFIX,
  normalizePolicy,
  parsePolicyRow,
  policyKey,
  readPolicy,
  writePolicy,
};
