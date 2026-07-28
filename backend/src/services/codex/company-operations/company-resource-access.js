'use strict';

const {
  loadActiveOwnedCompanyProject,
  parseSocialResourceKey,
  readCompanyResources,
  socialResourceKeyForConnection,
} = require('../company-resources');

const CUSTOMER_SUCCESS_DEPARTMENT_ID = 'customer-success';
const SALES_DEPARTMENT_ID = 'sales';
const GMAIL_RESOURCE_KEY = 'connector:gmail';
const SOCIAL_RESOURCE_PREFIX = 'social:';

class CompanyResourceAccessError extends Error {
  constructor(code, message, status = 403, details = null) {
    super(message);
    this.name = 'CompanyResourceAccessError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function deny(code, message, status = 403, details = null) {
  throw new CompanyResourceAccessError(code, message, status, details);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resourceRequirementForAction(kind, payload = {}) {
  if (kind === 'email_reply') {
    return {
      departmentId: CUSTOMER_SUCCESS_DEPARTMENT_ID,
      resourceKey: GMAIL_RESOURCE_KEY,
      provider: 'gmail',
      type: 'connector',
    };
  }
  if (kind === 'lead_outreach') {
    return {
      departmentId: SALES_DEPARTMENT_ID,
      resourceKey: GMAIL_RESOURCE_KEY,
      provider: 'gmail',
      type: 'connector',
    };
  }
  if (kind === 'social_reply') {
    const platform = clean(payload?.platform).toLowerCase();
    return {
      departmentId: CUSTOMER_SUCCESS_DEPARTMENT_ID,
      resourceKey: null,
      provider: platform,
      type: 'social',
      connectionId: clean(payload?.connectionId) || null,
    };
  }
  return null;
}

async function loadCompanyAccessContext({ prisma, project }) {
  const projectId = clean(project?.id);
  const userId = clean(project?.userId);
  if (!projectId || !userId) {
    deny(
      'company_project_not_found',
      'The active company project was not found.',
      404,
    );
  }
  const freshProject = await loadActiveOwnedCompanyProject({
    prisma,
    projectId,
    userId,
  });
  if (!freshProject) {
    deny(
      'company_project_not_active',
      'The company is not active or no longer belongs to this user.',
      403,
    );
  }
  return {
    project: freshProject,
    companyProjectId: freshProject.companyLink.project.id,
    userId,
    resources: readCompanyResources(freshProject),
  };
}

function assertAssigned({ context, departmentId, resourceKey }) {
  const assignedDepartmentId = context.resources.assignments[resourceKey];
  if (assignedDepartmentId !== departmentId) {
    deny(
      'company_resource_not_assigned',
      'The required resource is not assigned to this department.',
      403,
      {
        resourceKey,
        departmentId,
        assignedDepartmentId: assignedDepartmentId || null,
      },
    );
  }
}

async function requireConnectorAccess({
  prisma,
  context,
  departmentId,
  resourceKey,
  provider,
}) {
  assertAssigned({ context, departmentId, resourceKey });
  if (
    !prisma?.connectorAccount?.findFirst
    || !prisma?.projectConnectorAssignment?.findFirst
  ) {
    deny(
      'company_connector_access_unavailable',
      'Company connector authorization is unavailable.',
      503,
    );
  }
  const connectorAccount = await prisma.connectorAccount.findFirst({
    where: {
      userId: context.userId,
      provider,
      status: 'connected',
    },
  }).catch(() => null);
  if (!connectorAccount) {
    deny(
      'company_connector_not_connected',
      'The required connector is not connected.',
      409,
      { resourceKey, provider },
    );
  }
  const assignment = await prisma.projectConnectorAssignment.findFirst({
    where: {
      projectId: context.companyProjectId,
      connectorAccountId: connectorAccount.id,
      status: 'active',
    },
  }).catch(() => null);
  if (!assignment) {
    deny(
      'company_connector_not_authorized',
      'The connector account is not authorized for this company.',
      403,
      { resourceKey, provider },
    );
  }

  let user = null;
  if (provider === 'gmail') {
    if (!prisma?.user?.findUnique) {
      deny(
        'company_connector_access_unavailable',
        'Gmail authorization is unavailable.',
        503,
      );
    }
    user = await prisma.user.findUnique({
      where: { id: context.userId },
      select: { gmailTokens: true },
    }).catch(() => null);
    if (!user?.gmailTokens) {
      deny(
        'gmail_connection_required',
        'The Gmail account is no longer connected.',
        409,
        { resourceKey },
      );
    }
  }

  return {
    ...context,
    departmentId,
    resourceKey,
    connectorAccount,
    connectorAssignment: assignment,
    user,
  };
}

async function requireSocialAccess({
  prisma,
  context,
  departmentId,
  resourceKey = null,
  platform,
  connectionId = null,
  accountId = null,
}) {
  const parsed = resourceKey ? parseSocialResourceKey(resourceKey) : null;
  const expectedPlatform = clean(parsed?.platform || platform).toLowerCase();
  const expectedConnectionId = clean(parsed?.connectionId || connectionId);
  const expectedAccountId = clean(parsed?.accountId || accountId);
  if (
    !expectedPlatform
    || !expectedConnectionId
    || !prisma?.socialConnection?.findFirst
  ) {
    deny(
      'social_connection_required',
      'The required social account is not connected.',
      409,
      { resourceKey, platform: expectedPlatform || null },
    );
  }
  const connection = await prisma.socialConnection.findFirst({
    where: {
      id: expectedConnectionId,
      userId: context.userId,
      platform: expectedPlatform,
    },
  }).catch(() => null);
  const currentResourceKey = socialResourceKeyForConnection(connection);
  if (
    !connection?.accessToken
    || !currentResourceKey
    || (expectedAccountId && connection.accountId !== expectedAccountId)
    || (resourceKey && currentResourceKey !== resourceKey)
  ) {
    deny(
      'social_connection_required',
      'The required social account is no longer connected.',
      409,
      { resourceKey, platform: expectedPlatform },
    );
  }
  assertAssigned({
    context,
    departmentId,
    resourceKey: currentResourceKey,
  });
  return {
    ...context,
    departmentId,
    resourceKey: currentResourceKey,
    socialConnection: connection,
  };
}

async function requireCompanyResourceAccess({
  prisma,
  project,
  departmentId,
  resourceKey,
  connectionId = null,
}) {
  const cleanResourceKey = clean(resourceKey);
  const cleanDepartmentId = clean(departmentId);
  if (!cleanResourceKey || !cleanDepartmentId) {
    deny(
      'company_resource_requirement_invalid',
      'A valid company resource and department are required.',
      400,
    );
  }
  const context = await loadCompanyAccessContext({ prisma, project });
  if (cleanResourceKey.startsWith('connector:')) {
    return requireConnectorAccess({
      prisma,
      context,
      departmentId: cleanDepartmentId,
      resourceKey: cleanResourceKey,
      provider: cleanResourceKey.slice('connector:'.length),
    });
  }
  if (cleanResourceKey.startsWith(SOCIAL_RESOURCE_PREFIX)) {
    const parsed = parseSocialResourceKey(cleanResourceKey);
    if (!parsed) {
      deny(
        'company_resource_not_executable',
        'The social resource identity is invalid or obsolete.',
        403,
        { resourceKey: cleanResourceKey },
      );
    }
    return requireSocialAccess({
      prisma,
      context,
      departmentId: cleanDepartmentId,
      resourceKey: cleanResourceKey,
      platform: parsed.platform,
      connectionId: clean(connectionId) || parsed.connectionId,
      accountId: parsed.accountId,
    });
  }
  deny(
    'company_resource_not_executable',
    'This resource cannot authorize an external company operation.',
    403,
    { resourceKey: cleanResourceKey },
  );
}

async function requireExternalActionResourceAccess({
  prisma,
  project,
  kind,
  payload,
}) {
  const requirement = resourceRequirementForAction(kind, payload);
  if (!requirement) {
    deny(
      'external_action_resource_unsupported',
      'This external action has no authorized company resource.',
      403,
      { kind },
    );
  }
  if (requirement.type === 'social') {
    const context = await loadCompanyAccessContext({ prisma, project });
    return requireSocialAccess({
      prisma,
      context,
      departmentId: requirement.departmentId,
      platform: requirement.provider,
      connectionId: requirement.connectionId,
    });
  }
  return requireCompanyResourceAccess({
    prisma,
    project,
    departmentId: requirement.departmentId,
    resourceKey: requirement.resourceKey,
    connectionId: requirement.connectionId,
  });
}

async function authorizedSocialConnectionsForDepartment({
  prisma,
  project,
  departmentId = CUSTOMER_SUCCESS_DEPARTMENT_ID,
}) {
  const context = await loadCompanyAccessContext({ prisma, project });
  const resources = Object.entries(context.resources.assignments)
    .filter(([resourceKey, assignedDepartmentId]) => (
      assignedDepartmentId === departmentId
      && Boolean(parseSocialResourceKey(resourceKey))
    ))
    .map(([resourceKey]) => ({
      resourceKey,
      identity: parseSocialResourceKey(resourceKey),
    }))
    .filter(Boolean);
  if (!resources.length) {
    deny(
      'company_social_resource_not_assigned',
      'No social resource is assigned to this department.',
      403,
      { departmentId },
    );
  }
  const connections = [];
  for (const resource of resources) {
    try {
      const access = await requireSocialAccess({
        prisma,
        context,
        departmentId,
        resourceKey: resource.resourceKey,
        platform: resource.identity.platform,
        connectionId: resource.identity.connectionId,
        accountId: resource.identity.accountId,
      });
      connections.push(access.socialConnection);
    } catch (error) {
      if (!(error instanceof CompanyResourceAccessError)) throw error;
    }
  }
  if (!connections.length) {
    deny(
      'social_connection_required',
      'No assigned social resource has a current connection.',
      409,
      {
        departmentId,
        platforms: resources.map((resource) => resource.identity.platform),
      },
    );
  }
  return { ...context, connections };
}

module.exports = {
  CUSTOMER_SUCCESS_DEPARTMENT_ID,
  CompanyResourceAccessError,
  GMAIL_RESOURCE_KEY,
  SALES_DEPARTMENT_ID,
  SOCIAL_RESOURCE_PREFIX,
  authorizedSocialConnectionsForDepartment,
  requireCompanyResourceAccess,
  requireExternalActionResourceAccess,
  resourceRequirementForAction,
};
