'use strict';

const BRIEF_LOCK_CLASS = 0x0b12f;
const localLocks = new Map();

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * CodexProject.brief is Json, but older rows (and some create paths) stored a
 * plain string mission. Treat those as a companyProfile mission instead of
 * wiping them to {} and losing context on the next department mutation.
 */
function coerceBriefRecord(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value === 'string') {
    const textValue = value.trim().slice(0, 4_000);
    if (!textValue) return {};
    try {
      const parsed = JSON.parse(textValue);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...parsed };
      }
    } catch {
      // plain prose mission
    }
    return {
      // Keep parity with company-operating-profile asBriefRecord().
      objective: textValue,
      legacyBriefText: textValue,
      companyProfile: { mission: textValue },
    };
  }
  return {};
}

function hashInt32(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

async function withLocalLock(key, operation) {
  const previous = localLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  localLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localLocks.get(key) === queued) localLocks.delete(key);
  }
}

async function mutateProjectBrief({
  prisma,
  projectId,
  userId = null,
  mutate,
}) {
  if (!prisma?.codexProject || !projectId || typeof mutate !== 'function') return null;

  return withLocalLock(String(projectId), async () => {
    const apply = async (client) => {
      const where = userId ? { id: projectId, userId } : { id: projectId };
      const project = client.codexProject.findFirst
        ? await client.codexProject.findFirst({ where })
        : await client.codexProject.findUnique({ where: { id: projectId } });
      if (!project || (userId && project.userId !== userId)) return null;
      const current = coerceBriefRecord(project.brief);
      const next = coerceBriefRecord(await mutate({ ...current }, project));
      await client.codexProject.update({
        where: { id: projectId },
        data: { brief: next },
      });
      return { project, brief: next };
    };

    const canLock = typeof prisma.$transaction === 'function'
      && typeof prisma.$queryRawUnsafe === 'function';
    if (!canLock) return apply(prisma);
    return prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'WITH _lock AS (SELECT pg_advisory_xact_lock($1::int, $2::int)) SELECT 1::int AS locked FROM _lock',
        BRIEF_LOCK_CLASS,
        hashInt32(projectId),
      );
      return apply(tx);
    });
  });
}

module.exports = {
  BRIEF_LOCK_CLASS,
  asRecord,
  coerceBriefRecord,
  hashInt32,
  mutateProjectBrief,
};
