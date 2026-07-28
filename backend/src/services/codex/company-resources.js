'use strict';

/**
 * Durable resource ownership for a Codex company.
 *
 * The resource catalog can grow without requiring a database migration, so
 * resource identities are stored as namespaced keys:
 *
 *   social:v2:<provider>:<encoded-connection-id>:<encoded-account-id>
 *   connector:<connector-id>
 *   catalog:<catalog-id>
 *
 * Department ownership is validated against the company's current department
 * structure. Assignments to deleted/hidden departments are omitted when an
 * older persisted state is read.
 */

const { readDepartments } = require('./company-departments');
const { asRecord, mutateProjectBrief } = require('./project-brief-store');

const MAX_RESOURCE_KEYS = 256;
const MAX_RESOURCE_KEY_LENGTH = 512;
const RESOURCE_KEY_PATTERN = /^(?:connector|catalog):[a-z0-9][a-z0-9_-]{0,95}$/;
const MARKETING_DEPARTMENT_ID = 'marketing';
const SOCIAL_RESOURCE_PREFIX = 'social:';
const SOCIAL_RESOURCE_VERSION = 'v2';
const SOCIAL_PLATFORMS = new Set(['facebook', 'linkedin', 'x']);

class CompanyResourcesError extends Error {
  constructor(code, message, details = null, status = 400) {
    super(message);
    this.name = 'CompanyResourcesError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function cleanIdentityValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function socialResourceKeyForConnection(connection) {
  const platform = cleanIdentityValue(connection?.platform).toLowerCase();
  const connectionId = cleanIdentityValue(connection?.id);
  const accountId = cleanIdentityValue(connection?.accountId);
  const profile = connection?.profile && typeof connection.profile === 'object'
    ? connection.profile
    : {};
  if (connection?.connected === false) return null;
  if (
    Object.prototype.hasOwnProperty.call(connection || {}, 'accessToken')
    && !cleanIdentityValue(connection.accessToken)
  ) {
    return null;
  }
  if (profile.status && profile.status !== 'connected') return null;
  if (!SOCIAL_PLATFORMS.has(platform) || !connectionId || !accountId) return null;
  try {
    const key = [
      'social',
      SOCIAL_RESOURCE_VERSION,
      platform,
      encodeURIComponent(connectionId),
      encodeURIComponent(accountId),
    ].join(':');
    return key.length <= MAX_RESOURCE_KEY_LENGTH ? key : null;
  } catch {
    return null;
  }
}

function parseSocialResourceKey(value) {
  if (typeof value !== 'string' || value.length > MAX_RESOURCE_KEY_LENGTH) return null;
  const parts = value.split(':');
  if (
    parts.length !== 5
    || parts[0] !== 'social'
    || parts[1] !== SOCIAL_RESOURCE_VERSION
    || !SOCIAL_PLATFORMS.has(parts[2])
  ) {
    return null;
  }
  try {
    const connectionId = decodeURIComponent(parts[3]);
    const accountId = decodeURIComponent(parts[4]);
    if (!connectionId || !accountId) return null;
    if (
      encodeURIComponent(connectionId) !== parts[3]
      || encodeURIComponent(accountId) !== parts[4]
    ) {
      return null;
    }
    return {
      platform: parts[2],
      connectionId,
      accountId,
    };
  } catch {
    return null;
  }
}

function isValidResourceKey(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith(SOCIAL_RESOURCE_PREFIX)) {
    return Boolean(parseSocialResourceKey(value));
  }
  return RESOURCE_KEY_PATTERN.test(value);
}

function departmentIdsFor(project) {
  return new Set(readDepartments(project).map((department) => department.id));
}

function emptyCompanyResources() {
  return { assignments: {}, pinned: [], revision: 0 };
}

function normalizeStoredCompanyResources(project) {
  const source = asRecord(asRecord(project?.brief).companyResources);
  const assignmentsSource = asRecord(source.assignments);
  const validDepartmentIds = departmentIdsFor(project);
  const assignments = {};

  for (const [resourceKey, departmentId] of Object.entries(assignmentsSource)) {
    if (Object.keys(assignments).length >= MAX_RESOURCE_KEYS) break;
    if (!isValidResourceKey(resourceKey)) continue;
    if (typeof departmentId !== 'string' || !validDepartmentIds.has(departmentId)) continue;
    assignments[resourceKey] = departmentId;
  }

  const pinned = [];
  const seen = new Set();
  if (Array.isArray(source.pinned)) {
    for (const resourceKey of source.pinned) {
      if (pinned.length >= MAX_RESOURCE_KEYS) break;
      if (!isValidResourceKey(resourceKey) || seen.has(resourceKey)) continue;
      seen.add(resourceKey);
      pinned.push(resourceKey);
    }
  }

  const revision = Number.isSafeInteger(source.revision) && source.revision >= 0
    ? source.revision
    : 0;
  return { assignments, pinned, revision };
}

function validateResourceKeys(keys) {
  if (keys.length > MAX_RESOURCE_KEYS) {
    throw new CompanyResourcesError(
      'company_resources_limit_exceeded',
      `No more than ${MAX_RESOURCE_KEYS} resources can be assigned or pinned.`,
    );
  }
  for (const resourceKey of keys) {
    if (!isValidResourceKey(resourceKey)) {
      throw new CompanyResourcesError(
        'company_resource_key_invalid',
        `Invalid company resource key: ${String(resourceKey)}`,
        { resourceKey },
      );
    }
  }
}

function validateCompanyResources(project, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanyResourcesError(
      'company_resources_invalid',
      'Company resources must be an object.',
    );
  }

  const assignmentsSource = value.assignments;
  const pinnedSource = value.pinned;
  if (!assignmentsSource || typeof assignmentsSource !== 'object' || Array.isArray(assignmentsSource)) {
    throw new CompanyResourcesError(
      'company_resource_assignments_invalid',
      'assignments must be an object.',
    );
  }
  if (!Array.isArray(pinnedSource)) {
    throw new CompanyResourcesError(
      'company_resource_pins_invalid',
      'pinned must be an array.',
    );
  }

  const assignmentEntries = Object.entries(assignmentsSource);
  validateResourceKeys(assignmentEntries.map(([resourceKey]) => resourceKey));
  validateResourceKeys(pinnedSource);

  const validDepartmentIds = departmentIdsFor(project);
  const assignments = {};
  for (const [resourceKey, departmentId] of assignmentEntries) {
    if (typeof departmentId !== 'string' || !validDepartmentIds.has(departmentId)) {
      throw new CompanyResourcesError(
        'company_resource_department_not_found',
        `Department does not exist for resource ${resourceKey}.`,
        { resourceKey, departmentId },
      );
    }
    assignments[resourceKey] = departmentId;
  }

  return {
    assignments,
    pinned: [...new Set(pinnedSource)],
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0
      ? value.revision
      : 0,
  };
}

function readCompanyResources(project) {
  if (!project) return emptyCompanyResources();
  return normalizeStoredCompanyResources(project);
}

function marketingSocialPlatforms(project, connections = []) {
  const { assignments } = readCompanyResources(project);
  const currentKeys = new Map();
  for (const connection of Array.isArray(connections) ? connections : []) {
    const key = socialResourceKeyForConnection(connection);
    if (key) currentKeys.set(key, String(connection.platform).toLowerCase());
  }
  return new Set(
    Object.entries(assignments)
      .filter(([resourceKey, departmentId]) => (
        departmentId === MARKETING_DEPARTMENT_ID
        && currentKeys.has(resourceKey)
      ))
      .map(([resourceKey]) => currentKeys.get(resourceKey))
      .filter(Boolean),
  );
}

function marketingHasSocialConnection(project, connection) {
  const key = socialResourceKeyForConnection(connection);
  if (!key) return false;
  return readCompanyResources(project).assignments[key] === MARKETING_DEPARTMENT_ID;
}

function linkedCompanyIsActive(project, userId) {
  const link = project?.companyLink;
  const company = link?.project;
  return Boolean(
    link
    && company
    && company.userId === userId
    && company.deletedAt == null,
  );
}

/**
 * External company effects require both sides of the durable association:
 * an active owned CodexProject and its active owned Company Project. This is
 * intentionally stricter than read-only Codex features. Moving the Company
 * Project to trash therefore revokes every queued or autonomous social effect
 * without deleting OAuth credentials.
 */
async function loadActiveOwnedCompanyProject({ prisma, projectId, userId }) {
  const cleanProjectId = typeof projectId === 'string' ? projectId.trim() : '';
  const cleanUserId = typeof userId === 'string' ? userId.trim() : '';
  if (!prisma?.codexProject || !cleanProjectId || !cleanUserId) return null;

  const project = await prisma.codexProject.findFirst({
    where: {
      id: cleanProjectId,
      userId: cleanUserId,
      deletedAt: null,
    },
    include: {
      companyLink: {
        include: {
          project: {
            select: {
              id: true,
              userId: true,
              deletedAt: true,
            },
          },
        },
      },
    },
  }).catch(() => null);

  return linkedCompanyIsActive(project, cleanUserId) ? project : null;
}

async function writeCompanyResources({
  prisma,
  project,
  resources,
  expectedRevision,
}) {
  if (!prisma?.codexProject || !project?.id) {
    throw new CompanyResourcesError(
      'company_resources_persistence_unavailable',
      'Company resources cannot be persisted.',
    );
  }

  let saved = null;
  const result = await mutateProjectBrief({
    prisma,
    projectId: project.id,
    userId: project.userId,
    mutate: (brief, fresh) => {
      const current = normalizeStoredCompanyResources({ ...fresh, brief });
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new CompanyResourcesError(
          'company_resources_revision_required',
          'expectedRevision must be a non-negative integer.',
        );
      }
      if (current.revision !== expectedRevision) {
        throw new CompanyResourcesError(
          'company_resources_revision_conflict',
          'Company resources changed in another session.',
          {
            expectedRevision,
            currentRevision: current.revision,
            resources: current,
          },
          409,
        );
      }
      const validated = validateCompanyResources({ ...fresh, brief }, resources);
      saved = {
        ...validated,
        revision: current.revision + 1,
      };
      return {
        ...brief,
        companyResources: saved,
      };
    },
  });

  if (!result || !saved) {
    throw new CompanyResourcesError(
      'company_resources_project_not_found',
      'The company project is no longer available.',
    );
  }
  return saved;
}

module.exports = {
  CompanyResourcesError,
  MARKETING_DEPARTMENT_ID,
  MAX_RESOURCE_KEYS,
  MAX_RESOURCE_KEY_LENGTH,
  RESOURCE_KEY_PATTERN,
  SOCIAL_RESOURCE_PREFIX,
  SOCIAL_RESOURCE_VERSION,
  emptyCompanyResources,
  isValidResourceKey,
  linkedCompanyIsActive,
  loadActiveOwnedCompanyProject,
  marketingHasSocialConnection,
  marketingSocialPlatforms,
  parseSocialResourceKey,
  readCompanyResources,
  socialResourceKeyForConnection,
  validateCompanyResources,
  writeCompanyResources,
};
