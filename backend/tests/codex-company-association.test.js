'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/codex/company-association-service');

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some((entry) => matchesWhere(row, entry));
    if (key === 'companyLink' || key === 'codexLink') return expected === null;
    if (expected && typeof expected === 'object' && Array.isArray(expected.in)) {
      return expected.in.includes(row[key]);
    }
    return row[key] === expected;
  });
}

function createMemoryDb(seed = {}) {
  const state = {
    projects: [...(seed.projects || [])],
    codexProjects: [...(seed.codexProjects || [])],
    connectors: [...(seed.connectors || [])],
    links: [...(seed.links || [])],
    assignments: [...(seed.assignments || [])],
    memberships: [...(seed.memberships || [])],
    organizations: [...(seed.organizations || [])],
  };
  let sequence = 0;
  const now = () => new Date(`2026-07-27T20:00:${String(sequence++).padStart(2, '0')}.000Z`);
  const db = {
    _state: state,
    $transaction: async (callback) => {
      const snapshot = structuredClone(state);
      try {
        return await callback(db);
      } catch (error) {
        for (const key of Object.keys(state)) state[key] = snapshot[key];
        throw error;
      }
    },
    project: {
      findUnique: async ({ where }) => state.projects.find((row) => row.id === where.id) || null,
      findMany: async ({ where }) => state.projects.filter((row) => {
        const scalarWhere = { ...where };
        delete scalarWhere.codexLink;
        if (!matchesWhere(row, scalarWhere)) return false;
        if (where.codexLink === null && state.links.some((link) => link.projectId === row.id)) return false;
        return true;
      }),
    },
    codexProject: {
      findUnique: async ({ where }) => state.codexProjects.find((row) => row.id === where.id) || null,
      findMany: async ({ where }) => state.codexProjects.filter((row) => {
        const scalarWhere = { ...where };
        delete scalarWhere.companyLink;
        if (!matchesWhere(row, scalarWhere)) return false;
        if (where.companyLink === null && state.links.some((link) => link.codexProjectId === row.id)) return false;
        return true;
      }),
      update: async ({ where, data }) => {
        const row = state.codexProjects.find((entry) => entry.id === where.id);
        Object.assign(row, data, { updatedAt: now() });
        return row;
      },
    },
    companyCodexProjectLink: {
      findUnique: async ({ where }) => {
        if (where.projectId) return state.links.find((row) => row.projectId === where.projectId) || null;
        return state.links.find((row) => row.codexProjectId === where.codexProjectId) || null;
      },
      create: async ({ data }) => {
        const row = {
          id: `link-${state.links.length + 1}`,
          ...data,
          createdAt: now(),
          updatedAt: now(),
        };
        state.links.push(row);
        return row;
      },
    },
    connectorAccount: {
      findMany: async ({ where }) => state.connectors.filter((row) => matchesWhere(row, where)),
    },
    projectConnectorAssignment: {
      findMany: async ({ where }) => state.assignments.filter((row) => matchesWhere(row, where)),
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of state.assignments) {
          if (!matchesWhere(row, where)) continue;
          Object.assign(row, data, { updatedAt: now() });
          count += 1;
        }
        return { count };
      },
      upsert: async ({ where, create, update }) => {
        const key = where.projectId_connectorAccountId;
        let row = state.assignments.find(
          (entry) => entry.projectId === key.projectId
            && entry.connectorAccountId === key.connectorAccountId,
        );
        if (row) Object.assign(row, update, { updatedAt: now() });
        else {
          row = {
            id: `assignment-${state.assignments.length + 1}`,
            ...create,
            createdAt: now(),
            updatedAt: now(),
          };
          state.assignments.push(row);
        }
        return row;
      },
    },
    orgMembership: {
      findUnique: async ({ where }) => state.memberships.find(
        (row) => row.orgId === where.orgId_userId.orgId
          && row.userId === where.orgId_userId.userId,
      ) || null,
    },
    organization: {
      findFirst: async ({ where }) => state.organizations.find(
        (row) => row.id === where.id && row.ownerId === where.ownerId,
      ) || null,
    },
  };
  return db;
}

function baseSeed() {
  const updatedAt = new Date('2026-07-27T19:00:00.000Z');
  return {
    projects: [
      {
        id: 'company-a',
        userId: 'user-a',
        organizationId: null,
        name: 'Empresa A',
        type: 'webapp',
        deletedAt: null,
        updatedAt,
      },
      {
        id: 'company-b',
        userId: 'user-b',
        organizationId: null,
        name: 'Empresa B',
        type: 'webapp',
        deletedAt: null,
        updatedAt,
      },
    ],
    codexProjects: [
      {
        id: 'codex-a',
        userId: 'user-a',
        organizationId: null,
        name: 'Runtime A',
        status: 'ready',
        deletedAt: null,
        brief: {},
        updatedAt,
      },
      {
        id: 'codex-b',
        userId: 'user-b',
        organizationId: null,
        name: 'Runtime B',
        status: 'ready',
        deletedAt: null,
        brief: {},
        updatedAt,
      },
    ],
    connectors: [
      {
        id: 'gmail-a',
        userId: 'user-a',
        organizationId: null,
        provider: 'gmail',
        accountLabel: 'ventas@empresa-a.test',
        scopes: ['read_email', 'draft_email'],
        status: 'connected',
        lastHealthAt: updatedAt,
        lastError: null,
        updatedAt,
      },
      {
        id: 'gmail-b',
        userId: 'user-b',
        organizationId: null,
        provider: 'gmail',
        accountLabel: 'ventas@empresa-b.test',
        scopes: ['read_email'],
        status: 'connected',
        lastHealthAt: updatedAt,
        lastError: null,
        updatedAt,
      },
    ],
  };
}

test('resolves a company workspace through the same organization boundary as association', async () => {
  const seed = baseSeed();
  seed.projects[0].description = 'Contexto durable';
  seed.projects[0].instructions = 'Opera con revisión';
  const db = createMemoryDb(seed);

  const resolved = await service.resolveWorkspace(db, {
    userId: 'user-a',
    folderId: 'project:company-a',
  });

  assert.equal(resolved.kind, 'project');
  assert.equal(resolved.workspaceId, 'project:company-a');
  assert.equal(resolved.project.description, 'Contexto durable');
  assert.equal(resolved.project.instructions, 'Opera con revisión');
  assert.equal(db._state.links.length, 0);
});

test('falls back to an owned CodexProject when a colliding company id is not accessible', async () => {
  const seed = baseSeed();
  seed.projects[0].id = 'shared-a';
  seed.projects[0].organizationId = 'org-without-membership';
  seed.codexProjects[0].id = 'shared-a';
  const db = createMemoryDb(seed);

  const resolved = await service.resolveWorkspace(db, {
    userId: 'user-a',
    folderId: 'shared-a',
  });

  assert.equal(resolved.kind, 'codex');
  assert.equal(resolved.workspaceId, 'codex:shared-a');
  assert.equal(resolved.project.name, 'Runtime A');
  assert.equal(db._state.links.length, 0);
});

test('an explicit Codex workspace never becomes a same-id company workspace', async () => {
  const seed = baseSeed();
  seed.projects[0].id = 'shared-a';
  seed.codexProjects[0].id = 'shared-a';
  const db = createMemoryDb(seed);

  const resolved = await service.resolveWorkspace(db, {
    userId: 'user-a',
    folderId: 'codex:shared-a',
  });

  assert.equal(resolved.kind, 'codex');
  assert.equal(resolved.project.name, 'Runtime A');
});

test('workspace resolution never exposes a foreign company or CodexProject', async () => {
  const seed = baseSeed();
  seed.projects[1].id = 'foreign-shared';
  seed.codexProjects[1].id = 'foreign-shared';
  const db = createMemoryDb(seed);

  await assert.rejects(
    service.resolveWorkspace(db, {
      userId: 'user-a',
      folderId: 'foreign-shared',
    }),
    (error) => error.code === 'codex_project_not_found' && error.status === 404,
  );
  assert.equal(db._state.links.length, 0);
});

test('keeps legacy projects orphaned until the owner explicitly associates them', async () => {
  const db = createMemoryDb(baseSeed());
  const before = await service.listOrphans(db, { userId: 'user-a' });
  assert.deepEqual(before.companies.map((row) => row.id), ['company-a']);
  assert.deepEqual(before.codexProjects.map((row) => row.id), ['codex-a']);
  assert.equal(before.backfillApplied, false);
  assert.equal(db._state.links.length, 0);
});

test('persists the company runtime and connector assignment across reloads or browser profiles', async () => {
  const db = createMemoryDb(baseSeed());
  await service.associateCompany(db, {
    userId: 'user-a',
    projectId: 'company-a',
    codexProjectId: 'codex-a',
    connectorAccountIds: ['gmail-a'],
    source: 'manual',
  });

  const reloaded = await service.associationForCompany(db, {
    userId: 'user-a',
    projectId: 'company-a',
  });
  assert.equal(reloaded.association.codexProject.id, 'codex-a');
  assert.deepEqual(reloaded.association.connectors.map((row) => row.id), ['gmail-a']);
  assert.equal(reloaded.requiresAssociation, false);
  assert.equal(reloaded.candidates.length, 0);
});

test('does not expose or link another tenant records by guessed ids', async () => {
  const db = createMemoryDb(baseSeed());
  await assert.rejects(
    service.associateCompany(db, {
      userId: 'user-a',
      projectId: 'company-a',
      codexProjectId: 'codex-b',
      connectorAccountIds: [],
    }),
    (error) => error.code === 'codex_project_not_found' && error.status === 404,
  );
  await assert.rejects(
    service.associationForCompany(db, {
      userId: 'user-b',
      projectId: 'company-a',
    }),
    (error) => error.code === 'company_project_not_found' && error.status === 404,
  );
  assert.equal(db._state.links.length, 0);
});

test('rejects connectors owned by another user even when the provider matches', async () => {
  const db = createMemoryDb(baseSeed());
  await assert.rejects(
    service.associateCompany(db, {
      userId: 'user-a',
      projectId: 'company-a',
      codexProjectId: 'codex-a',
      connectorAccountIds: ['gmail-b'],
    }),
    (error) => error.code === 'connector_assignment_forbidden' && error.status === 404,
  );
  assert.equal(db._state.assignments.length, 0);
});

test('rejects cross-organization association and allows an explicit same-org association', async () => {
  const seed = baseSeed();
  seed.projects[0].organizationId = 'org-a';
  seed.codexProjects[0].organizationId = 'org-b';
  seed.memberships = [
    { id: 'member-a', orgId: 'org-a', userId: 'user-a' },
    { id: 'member-b', orgId: 'org-b', userId: 'user-a' },
  ];
  const db = createMemoryDb(seed);
  await assert.rejects(
    service.associateCompany(db, {
      userId: 'user-a',
      projectId: 'company-a',
      codexProjectId: 'codex-a',
    }),
    (error) => error.code === 'company_tenant_mismatch' && error.status === 409,
  );

  db._state.codexProjects[0].organizationId = 'org-a';
  const linked = await service.associateCompany(db, {
    userId: 'user-a',
    projectId: 'company-a',
    codexProjectId: 'codex-a',
  });
  assert.equal(linked.association.organizationId, 'org-a');
});

test('connector replacement is idempotent and revokes removed company grants', async () => {
  const seed = baseSeed();
  seed.connectors.push({
    ...seed.connectors[0],
    id: 'drive-a',
    provider: 'google_drive',
    accountLabel: 'Drive Empresa A',
  });
  const db = createMemoryDb(seed);
  await service.associateCompany(db, {
    userId: 'user-a',
    projectId: 'company-a',
    codexProjectId: 'codex-a',
    connectorAccountIds: ['gmail-a', 'gmail-a'],
  });
  await service.assignCompanyConnectors(db, {
    userId: 'user-a',
    projectId: 'company-a',
    connectorAccountIds: ['drive-a'],
  });
  assert.equal(db._state.assignments.find((row) => row.connectorAccountId === 'gmail-a').status, 'revoked');
  assert.equal(db._state.assignments.find((row) => row.connectorAccountId === 'drive-a').status, 'active');
});

test('atomic connector add/remove never replaces unrelated company grants', async () => {
  const seed = baseSeed();
  seed.connectors.push({
    ...seed.connectors[0],
    id: 'drive-a',
    provider: 'google_drive',
    accountLabel: 'Drive Empresa A',
  });
  const db = createMemoryDb(seed);
  await service.associateCompany(db, {
    userId: 'user-a',
    projectId: 'company-a',
    codexProjectId: 'codex-a',
    connectorAccountIds: ['gmail-a'],
  });

  const added = await service.addCompanyConnector(db, {
    userId: 'user-a',
    projectId: 'company-a',
    connectorAccountId: 'drive-a',
  });
  assert.equal(added.changed, true);
  assert.equal(db._state.assignments.find((row) => row.connectorAccountId === 'gmail-a').status, 'active');
  assert.equal(db._state.assignments.find((row) => row.connectorAccountId === 'drive-a').status, 'active');

  const duplicate = await service.addCompanyConnector(db, {
    userId: 'user-a',
    projectId: 'company-a',
    connectorAccountId: 'drive-a',
  });
  assert.equal(duplicate.changed, false);

  const removed = await service.removeCompanyConnector(db, {
    userId: 'user-a',
    projectId: 'company-a',
    connectorAccountId: 'drive-a',
  });
  assert.equal(removed.changed, true);
  assert.equal(db._state.assignments.find((row) => row.connectorAccountId === 'gmail-a').status, 'active');
  assert.equal(db._state.assignments.find((row) => row.connectorAccountId === 'drive-a').status, 'revoked');
});
