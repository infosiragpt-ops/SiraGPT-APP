'use strict';

/**
 * Durable tenant-aware association between an Empresas Project and the
 * CodexProject that executes its work. Legacy localStorage links are treated
 * only as UI hints; this service never infers or backfills a relationship.
 */

class CompanyAssociationError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'CompanyAssociationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const PROJECT_SELECT = Object.freeze({
  id: true,
  userId: true,
  organizationId: true,
  name: true,
  type: true,
  deletedAt: true,
  updatedAt: true,
});

const CODEX_PROJECT_SELECT = Object.freeze({
  id: true,
  userId: true,
  organizationId: true,
  name: true,
  status: true,
  brief: true,
  deletedAt: true,
  updatedAt: true,
});

const CONNECTOR_SELECT = Object.freeze({
  id: true,
  userId: true,
  organizationId: true,
  provider: true,
  accountLabel: true,
  scopes: true,
  status: true,
  lastHealthAt: true,
  lastError: true,
  updatedAt: true,
});

function requireDb(prisma) {
  if (
    !prisma?.project
    || !prisma?.codexProject
    || !prisma?.companyCodexProjectLink
    || !prisma?.projectConnectorAssignment
    || !prisma?.connectorAccount
  ) {
    throw new CompanyAssociationError(
      'company_association_unavailable',
      'Company association storage is unavailable.',
      503,
    );
  }
  return prisma;
}

function cleanId(value, label) {
  const id = String(value || '').trim();
  if (!id || id.length > 160) {
    throw new CompanyAssociationError(
      'company_association_invalid',
      `${label} is required.`,
      400,
    );
  }
  return id;
}

function uniqueIds(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).slice(0, 100);
}

async function hasOrganizationAccess(prisma, { userId, organizationId }) {
  if (!organizationId) return true;
  const [membership, organization] = await Promise.all([
    prisma.orgMembership?.findUnique
      ? prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId: organizationId, userId } },
        select: { id: true },
      })
      : null,
    prisma.organization?.findFirst
      ? prisma.organization.findFirst({
        where: { id: organizationId, ownerId: userId },
        select: { id: true },
      })
      : null,
  ]);
  return Boolean(membership || organization);
}

async function loadOwnedCompany(prisma, { userId, projectId }) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: PROJECT_SELECT,
  });
  if (!project || project.deletedAt || project.userId !== userId) {
    throw new CompanyAssociationError(
      'company_project_not_found',
      'Company project was not found.',
      404,
    );
  }
  if (!(await hasOrganizationAccess(prisma, {
    userId,
    organizationId: project.organizationId,
  }))) {
    throw new CompanyAssociationError(
      'company_project_not_found',
      'Company project was not found.',
      404,
    );
  }
  return project;
}

async function loadOwnedCodexProject(prisma, { userId, codexProjectId }) {
  const project = await prisma.codexProject.findUnique({
    where: { id: codexProjectId },
    select: CODEX_PROJECT_SELECT,
  });
  if (!project || project.deletedAt || project.userId !== userId) {
    throw new CompanyAssociationError(
      'codex_project_not_found',
      'Codex project was not found.',
      404,
    );
  }
  if (!(await hasOrganizationAccess(prisma, {
    userId,
    organizationId: project.organizationId,
  }))) {
    throw new CompanyAssociationError(
      'codex_project_not_found',
      'Codex project was not found.',
      404,
    );
  }
  return project;
}

function assertCompatibleTenant(company, codexProject) {
  if (
    company.organizationId
    && codexProject.organizationId
    && company.organizationId !== codexProject.organizationId
  ) {
    throw new CompanyAssociationError(
      'company_tenant_mismatch',
      'Company and Codex project belong to different organizations.',
      409,
    );
  }
  if (!company.organizationId && codexProject.organizationId) {
    throw new CompanyAssociationError(
      'company_tenant_mismatch',
      'An organization Codex project cannot be attached to a personal company.',
      409,
    );
  }
  return company.organizationId || null;
}

async function validateConnectors(prisma, {
  userId,
  organizationId,
  connectorAccountIds,
}) {
  const ids = uniqueIds(connectorAccountIds);
  if (!ids.length) return [];
  const connectors = await prisma.connectorAccount.findMany({
    where: {
      id: { in: ids },
      userId,
    },
    select: CONNECTOR_SELECT,
  });
  if (connectors.length !== ids.length) {
    throw new CompanyAssociationError(
      'connector_assignment_forbidden',
      'One or more connector accounts are unavailable for this company.',
      404,
    );
  }
  const wrongTenant = connectors.find(
    (connector) => connector.organizationId && connector.organizationId !== organizationId,
  );
  if (wrongTenant) {
    throw new CompanyAssociationError(
      'connector_tenant_mismatch',
      'A connector account belongs to a different organization.',
      409,
    );
  }
  return connectors;
}

async function replaceConnectorAssignments(prisma, {
  projectId,
  userId,
  organizationId,
  connectorAccountIds,
}) {
  const connectors = await validateConnectors(prisma, {
    userId,
    organizationId,
    connectorAccountIds,
  });
  await prisma.projectConnectorAssignment.updateMany({
    where: { projectId, status: 'active' },
    data: { status: 'revoked' },
  });
  for (const connector of connectors) {
    await prisma.projectConnectorAssignment.upsert({
      where: {
        projectId_connectorAccountId: {
          projectId,
          connectorAccountId: connector.id,
        },
      },
      create: {
        projectId,
        connectorAccountId: connector.id,
        organizationId,
        assignedByUserId: userId,
        status: 'active',
        capabilities: Array.isArray(connector.scopes) ? connector.scopes : [],
      },
      update: {
        organizationId,
        assignedByUserId: userId,
        status: 'active',
        capabilities: Array.isArray(connector.scopes) ? connector.scopes : [],
      },
    });
  }
  return connectors;
}

function publicConnector(connector) {
  return {
    id: connector.id,
    provider: connector.provider,
    accountLabel: connector.accountLabel || null,
    organizationId: connector.organizationId || null,
    scopes: Array.isArray(connector.scopes) ? connector.scopes : [],
    status: connector.status,
    lastHealthAt: connector.lastHealthAt || null,
    lastError: connector.lastError || null,
    updatedAt: connector.updatedAt || null,
  };
}

function publicProject(project) {
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    organizationId: project.organizationId || null,
    ...(project.type ? { type: project.type } : {}),
    ...(project.status ? { status: project.status } : {}),
    updatedAt: project.updatedAt || null,
  };
}

async function associationForCompany(prisma, { userId, projectId }) {
  const db = requireDb(prisma);
  const companyId = cleanId(projectId, 'projectId');
  const company = await loadOwnedCompany(db, { userId: String(userId), projectId: companyId });
  const link = await db.companyCodexProjectLink.findUnique({
    where: { projectId: company.id },
  });
  let codexProject = null;
  if (link) {
    codexProject = await db.codexProject.findUnique({
      where: { id: link.codexProjectId },
      select: CODEX_PROJECT_SELECT,
    });
  }
  const assignments = await db.projectConnectorAssignment.findMany({
    where: { projectId: company.id, status: 'active' },
    select: { connectorAccountId: true },
  });
  const assignedIds = assignments.map((row) => row.connectorAccountId);
  const assignedConnectors = assignedIds.length
    ? await db.connectorAccount.findMany({
      where: { id: { in: assignedIds }, userId: String(userId) },
      select: CONNECTOR_SELECT,
    })
    : [];
  const candidates = await db.codexProject.findMany({
    where: {
      userId: String(userId),
      deletedAt: null,
      companyLink: null,
      ...(company.organizationId
        ? { OR: [{ organizationId: company.organizationId }, { organizationId: null }] }
        : { organizationId: null }),
    },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: CODEX_PROJECT_SELECT,
  });
  const availableConnectors = await db.connectorAccount.findMany({
    where: {
      userId: String(userId),
      status: 'connected',
      ...(company.organizationId
        ? { OR: [{ organizationId: company.organizationId }, { organizationId: null }] }
        : { organizationId: null }),
    },
    orderBy: { updatedAt: 'desc' },
    select: CONNECTOR_SELECT,
  });
  return {
    company: publicProject(company),
    association: link && codexProject
      ? {
        id: link.id,
        source: link.source,
        organizationId: link.organizationId || null,
        linkedAt: link.createdAt,
        updatedAt: link.updatedAt,
        codexProject: publicProject(codexProject),
        connectors: assignedConnectors.map(publicConnector),
      }
      : null,
    candidates: candidates.map(publicProject),
    connectors: availableConnectors.map(publicConnector),
    requiresAssociation: !link,
  };
}

async function associateCompany(prisma, {
  userId,
  projectId,
  codexProjectId,
  connectorAccountIds = [],
  source = 'manual',
}) {
  const db = requireDb(prisma);
  const ownerId = cleanId(userId, 'userId');
  const companyId = cleanId(projectId, 'projectId');
  const runtimeId = cleanId(codexProjectId, 'codexProjectId');
  const associationSource = source === 'created_for_company' ? source : 'manual';

  return db.$transaction(async (tx) => {
    const company = await loadOwnedCompany(tx, { userId: ownerId, projectId: companyId });
    const codexProject = await loadOwnedCodexProject(tx, {
      userId: ownerId,
      codexProjectId: runtimeId,
    });
    const organizationId = assertCompatibleTenant(company, codexProject);
    const [companyLink, runtimeLink] = await Promise.all([
      tx.companyCodexProjectLink.findUnique({ where: { projectId: companyId } }),
      tx.companyCodexProjectLink.findUnique({ where: { codexProjectId: runtimeId } }),
    ]);
    if (companyLink && companyLink.codexProjectId !== runtimeId) {
      throw new CompanyAssociationError(
        'company_already_linked',
        'This company already has a different Codex project.',
        409,
      );
    }
    if (runtimeLink && runtimeLink.projectId !== companyId) {
      throw new CompanyAssociationError(
        'codex_project_already_linked',
        'This Codex project already belongs to another company.',
        409,
      );
    }
    if (organizationId && !codexProject.organizationId) {
      await tx.codexProject.update({
        where: { id: runtimeId },
        data: { organizationId },
      });
    }
    let link = companyLink || await tx.companyCodexProjectLink.create({
      data: {
        projectId: companyId,
        codexProjectId: runtimeId,
        organizationId,
        linkedByUserId: ownerId,
        source: associationSource,
      },
    });
    if (tx.company?.upsert && tx.companyCodexProjectLink?.update) {
      const companyModel = await require('./company-operating-profile')
        .ensureCompanyForAssociation({
          prisma: tx,
          companyProject: company,
          codexProject,
          link,
        });
      if (companyModel && link.companyId !== companyModel.id) {
        link = { ...link, companyId: companyModel.id };
      }
    }
    const connectors = await replaceConnectorAssignments(tx, {
      projectId: companyId,
      userId: ownerId,
      organizationId,
      connectorAccountIds,
    });
    return {
      association: {
        id: link.id,
        companyId: link.companyId || null,
        source: link.source,
        organizationId,
        linkedAt: link.createdAt,
        updatedAt: link.updatedAt,
        codexProject: publicProject({
          ...codexProject,
          organizationId: organizationId || codexProject.organizationId,
        }),
        connectors: connectors.map(publicConnector),
      },
    };
  });
}

async function assignCompanyConnectors(prisma, {
  userId,
  projectId,
  connectorAccountIds = [],
}) {
  const db = requireDb(prisma);
  const ownerId = cleanId(userId, 'userId');
  const companyId = cleanId(projectId, 'projectId');
  return db.$transaction(async (tx) => {
    const company = await loadOwnedCompany(tx, { userId: ownerId, projectId: companyId });
    const link = await tx.companyCodexProjectLink.findUnique({ where: { projectId: companyId } });
    if (!link) {
      throw new CompanyAssociationError(
        'company_association_required',
        'Associate a Codex project before assigning connectors.',
        409,
      );
    }
    const connectors = await replaceConnectorAssignments(tx, {
      projectId: companyId,
      userId: ownerId,
      organizationId: company.organizationId || null,
      connectorAccountIds,
    });
    return { connectors: connectors.map(publicConnector) };
  });
}

async function mutateCompanyConnector(prisma, {
  userId,
  projectId,
  connectorAccountId,
  action,
}) {
  const db = requireDb(prisma);
  const ownerId = cleanId(userId, 'userId');
  const companyId = cleanId(projectId, 'projectId');
  const accountId = cleanId(connectorAccountId, 'connectorAccountId');
  return db.$transaction(async (tx) => {
    const company = await loadOwnedCompany(tx, { userId: ownerId, projectId: companyId });
    const link = await tx.companyCodexProjectLink.findUnique({ where: { projectId: companyId } });
    if (!link) {
      throw new CompanyAssociationError(
        'company_association_required',
        'Associate a Codex project before assigning connectors.',
        409,
      );
    }
    const [connector] = await validateConnectors(tx, {
      userId: ownerId,
      organizationId: company.organizationId || null,
      connectorAccountIds: [accountId],
    });
    const existing = await tx.projectConnectorAssignment.findMany({
      where: {
        projectId: companyId,
        connectorAccountId: accountId,
      },
      take: 1,
    });
    const wasActive = existing[0]?.status === 'active';

    if (action === 'add') {
      await tx.projectConnectorAssignment.upsert({
        where: {
          projectId_connectorAccountId: {
            projectId: companyId,
            connectorAccountId: accountId,
          },
        },
        create: {
          projectId: companyId,
          connectorAccountId: accountId,
          organizationId: company.organizationId || null,
          assignedByUserId: ownerId,
          status: 'active',
          capabilities: Array.isArray(connector.scopes) ? connector.scopes : [],
        },
        update: {
          organizationId: company.organizationId || null,
          assignedByUserId: ownerId,
          status: 'active',
          capabilities: Array.isArray(connector.scopes) ? connector.scopes : [],
        },
      });
      return {
        connector: publicConnector(connector),
        changed: !wasActive,
      };
    }

    const result = await tx.projectConnectorAssignment.updateMany({
      where: {
        projectId: companyId,
        connectorAccountId: accountId,
        status: 'active',
      },
      data: { status: 'revoked' },
    });
    return {
      connector: publicConnector(connector),
      changed: Number(result?.count || 0) > 0,
    };
  });
}

async function addCompanyConnector(prisma, input) {
  return mutateCompanyConnector(prisma, { ...input, action: 'add' });
}

async function removeCompanyConnector(prisma, input) {
  return mutateCompanyConnector(prisma, { ...input, action: 'remove' });
}

async function listOrphans(prisma, { userId }) {
  const db = requireDb(prisma);
  const ownerId = cleanId(userId, 'userId');
  const [companies, codexProjects] = await Promise.all([
    db.project.findMany({
      where: {
        userId: ownerId,
        deletedAt: null,
        codexLink: null,
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: PROJECT_SELECT,
    }),
    db.codexProject.findMany({
      where: {
        userId: ownerId,
        deletedAt: null,
        companyLink: null,
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: CODEX_PROJECT_SELECT,
    }),
  ]);
  return {
    companies: companies.map(publicProject),
    codexProjects: codexProjects.map(publicProject),
    backfillApplied: false,
  };
}

module.exports = {
  CompanyAssociationError,
  PROJECT_SELECT,
  CODEX_PROJECT_SELECT,
  CONNECTOR_SELECT,
  associationForCompany,
  addCompanyConnector,
  associateCompany,
  assignCompanyConnectors,
  listOrphans,
  hasOrganizationAccess,
  removeCompanyConnector,
};
