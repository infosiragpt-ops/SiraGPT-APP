'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/deployments/deployment-service');

// ---- Minimal in-memory Prisma fake (only the ops the service calls) ----
function makeFakeDb() {
  let seq = 0;
  const id = (prefix) => `${prefix}_${(seq += 1)}`;
  const deployments = [];
  const versions = [];
  const domains = [];

  const matchWhere = (row, where) => Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] === null || row[k] === undefined;
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
    return row[k] === v;
  });

  const table = (store, prefix, defaults) => ({
    create: async ({ data }) => {
      const row = { id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...data };
      store.push(row);
      return { ...row };
    },
    findFirst: async ({ where, orderBy }) => {
      let rows = store.filter((r) => matchWhere(r, where));
      if (orderBy) rows = sortBy(rows, orderBy);
      return rows[0] ? { ...rows[0] } : null;
    },
    findUnique: async ({ where }) => {
      const r = store.find((x) => x.id === where.id);
      return r ? { ...r } : null;
    },
    findMany: async ({ where = {}, orderBy, take }) => {
      let rows = store.filter((r) => matchWhere(r, where));
      if (orderBy) rows = sortBy(rows, orderBy);
      if (take) rows = rows.slice(0, take);
      return rows.map((r) => ({ ...r }));
    },
    count: async ({ where = {} }) => store.filter((r) => matchWhere(r, where)).length,
    update: async ({ where, data }) => {
      const r = store.find((x) => x.id === where.id);
      if (!r) throw new Error('not found');
      Object.assign(r, data, { updatedAt: new Date() });
      return { ...r };
    },
    updateMany: async ({ where, data }) => {
      const rows = store.filter((r) => matchWhere(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    delete: async ({ where }) => {
      const idx = store.findIndex((x) => x.id === where.id);
      if (idx === -1) throw new Error('not found');
      return store.splice(idx, 1)[0];
    },
  });

  function sortBy(rows, orderBy) {
    const [key, dir] = Object.entries(orderBy)[0];
    return [...rows].sort((a, b) => {
      const av = a[key]; const bv = b[key];
      const cmp = av > bv ? 1 : av < bv ? -1 : 0;
      return dir === 'desc' ? -cmp : cmp;
    });
  }

  const db = {
    deployment: table(deployments, 'depl', () => ({ deletedAt: null, currentVersionId: null, subdomain: null, suspendedReason: null, databaseConnected: false, databaseProvider: null })),
    deploymentVersion: table(versions, 'ver', () => ({ isLive: false, isRollback: false, rolledBackFromId: null })),
    deploymentDomain: table(domains, 'dom', () => ({})),
    _stores: { deployments, versions, domains },
  };
  // Interactive-transaction shim so the service's create+demote unit runs through
  // the same $transaction path it uses against real Postgres.
  db.$transaction = async (fn) => fn(db);
  return db;
}

const USER = 'user_1';

test('createDeployment stamps a subdomain + machine spec', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'Mi App', deploymentType: 'reserved_vm', machineTier: '2vcpu_8gb', db });
  assert.equal(d.status, 'building');
  assert.equal(d.deploymentType, 'reserved_vm');
  assert.equal(d.machineLabel, 'Reserved VM (Dedicated 2 vCPU / 8 GiB RAM)');
  assert.ok(d.subdomain && d.defaultDomain.includes(d.subdomain));
  assert.equal(d.cpu, 2);
});

test('createDeployment rejects invalid enums', async () => {
  const db = makeFakeDb();
  await assert.rejects(() => service.createDeployment({ userId: USER, name: 'x', deploymentType: 'bogus', db }), (e) => e.code === 'invalid_type');
  await assert.rejects(() => service.createDeployment({ userId: USER, name: 'x', visibility: 'bogus', db }), (e) => e.code === 'invalid_visibility');
});

test('publishDeployment promotes a live version and flips status to running', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  const { deployment, version, phases } = await service.publishDeployment({ userId: USER, id: d.id, db });
  assert.equal(deployment.status, 'running');
  assert.equal(deployment.currentVersionId, version.id);
  assert.equal(deployment.databaseConnected, true);
  assert.equal(version.isLive, true);
  assert.equal(version.status, 'promoted');
  assert.equal(phases.length, 5);
});

test('a second publish demotes the previous live version', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  const first = await service.publishDeployment({ userId: USER, id: d.id, db });
  const second = await service.publishDeployment({ userId: USER, id: d.id, db });
  assert.notEqual(first.version.shortHash, second.version.shortHash);
  const detail = await service.getDeployment({ userId: USER, id: d.id, db });
  const live = detail.versions.filter((v) => v.isLive);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, second.version.id);
});

test('publish with hasFiles:false fails the deployment', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  const { deployment, version } = await service.publishDeployment({ userId: USER, id: d.id, hasFiles: false, db });
  assert.equal(deployment.status, 'failed');
  assert.equal(version.status, 'failed');
  assert.equal(version.isLive, false);
});

test('rollback re-promotes a prior version as a new rollback build', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  const first = await service.publishDeployment({ userId: USER, id: d.id, db });
  await service.publishDeployment({ userId: USER, id: d.id, db });
  const { deployment, version } = await service.rollbackDeployment({ userId: USER, id: d.id, versionId: first.version.id, db });
  assert.equal(deployment.status, 'running');
  assert.equal(version.isRollback, true);
  assert.equal(version.rolledBackFromId, first.version.id);
  assert.equal(deployment.currentVersionId, version.id);
  // The create+demote unit must leave exactly one live version after rollback.
  const detail = await service.getDeployment({ userId: USER, id: d.id, db });
  assert.equal(detail.versions.filter((v) => v.isLive).length, 1);
});

test('ownership: another user cannot see or mutate a deployment', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  assert.equal(await service.getDeployment({ userId: 'intruder', id: d.id, db }), null);
  await assert.rejects(() => service.publishDeployment({ userId: 'intruder', id: d.id, db }), (e) => e.code === 'deployment_not_found');
});

test('pause/resume/shutdown transitions + shutdown soft-deletes', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  assert.equal((await service.setStatus({ userId: USER, id: d.id, status: 'paused', db })).status, 'paused');
  assert.equal((await service.setStatus({ userId: USER, id: d.id, status: 'running', db })).status, 'running');
  await service.setStatus({ userId: USER, id: d.id, status: 'shut_down', db });
  // soft-deleted ⇒ no longer listed / fetchable
  assert.equal(await service.getDeployment({ userId: USER, id: d.id, db }), null);
  assert.equal((await service.listDeployments({ userId: USER, db })).length, 0);
});

test('addDomain validates hostname and returns A+TXT records', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  await assert.rejects(() => service.addDomain({ userId: USER, id: d.id, hostname: 'not a domain', db }), (e) => e.code === 'invalid_hostname');
  const dom = await service.addDomain({ userId: USER, id: d.id, hostname: 'https://App.Example.com/x', db });
  assert.equal(dom.hostname, 'app.example.com');
  assert.equal(dom.verificationStatus, 'pending');
  assert.equal(dom.dnsRecords.length, 2);
  await service.removeDomain({ userId: USER, id: d.id, domainId: dom.id, db });
  const detail = await service.getDeployment({ userId: USER, id: d.id, db });
  assert.equal(detail.domains.length, 0);
});

test('updateDeployment changes commands but ignores geography (immutable)', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', geography: 'na', db });
  const up = await service.updateDeployment({ userId: USER, id: d.id, patch: { buildCommand: 'pnpm build', visibility: 'private', geography: 'eu' }, db });
  assert.equal(up.buildCommand, 'pnpm build');
  assert.equal(up.visibility, 'private');
  assert.equal(up.geography, 'na'); // unchanged
});

test('updateDeployment normalizes reserved VM machine tier when changing type', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', deploymentType: 'autoscale', db });
  const up = await service.updateDeployment({ userId: USER, id: d.id, patch: { deploymentType: 'reserved_vm' }, db });
  assert.equal(up.deploymentType, 'reserved_vm');
  assert.equal(up.machineTier, '1vcpu_4gb');
  assert.equal(up.machineLabel, 'Reserved VM (Dedicated 1 vCPU / 4 GiB RAM)');
});

test('connectProvider rejects missing provider configuration', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  await assert.rejects(
    () => service.connectProvider({ userId: USER, id: d.id, providerId: 'hostinger_vps', db, env: {} }),
    (e) => e.code === 'provider_not_configured' && e.message.includes('HOSTINGER_VPS_HOST'),
  );
});

test('connectProvider switches a deployment to Hostinger VPS when configured', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  const result = await service.connectProvider({
    userId: USER,
    id: d.id,
    providerId: 'hostinger_vps',
    db,
    env: {
      HOSTINGER_VPS_HOST: '62.72.11.231',
      HOSTINGER_VPS_USER: 'root',
      HOSTINGER_VPS_SSH_PRIVATE_KEY: 'PRIVATE_KEY',
    },
  });
  assert.equal(result.deployment.deploymentType, 'hostinger_vps');
  assert.equal(result.deployment.machineLabel, 'Hostinger VPS');
  assert.equal(result.deployment.externalPort, 3000);
  assert.equal(result.plan.ready, true);
});

test('getLogs returns the live version log lines', async () => {
  const db = makeFakeDb();
  const d = await service.createDeployment({ userId: USER, name: 'App', db });
  await service.publishDeployment({ userId: USER, id: d.id, db });
  const { lines, entries, versionHash } = await service.getLogs({ userId: USER, id: d.id, db });
  assert.ok(lines.length > 0);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => ["User", "System"].includes(e.source) && ["info", "error"].includes(e.level) && typeof e.message === "string"));
  assert.equal(entries[0].deployment, versionHash);
  assert.match(versionHash, /^[0-9a-f]{8}$/);
});
