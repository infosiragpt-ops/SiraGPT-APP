'use strict';

const registry = require('./registry');
const store = require('./store');
const vault = require('./vault');
const health = require('./health');
const sync = require('./sync');
const revoke = require('./revoke');
const gateway = require('./gateway');
const prompt = require('./prompt');
const mentions = require('./mentions');
const redact = require('./redact');
const audit = require('./audit');

const STALE_HEALTH_MS = 15 * 60 * 1000;

function isStale(row, nowMs) {
  if (!row?.lastHealthAt) return true;
  const at = new Date(row.lastHealthAt).getTime();
  return !Number.isFinite(at) || nowMs - at > STALE_HEALTH_MS;
}

async function listUserApps(prisma, userId, opts = {}) {
  await sync.syncFromExisting(prisma, userId);
  const rows = await store.listByUser(prisma, userId);
  const nowMs = Date.now();
  const shouldProbe = opts.probe === true || opts.probe === false
    ? opts.probe === true
    : true;
  if (!shouldProbe) return rows.map((row) => store.publicConnection(row));
  const probed = [];
  for (const row of rows) {
    if (opts.force !== true && !isStale(row, nowMs) && row.status) {
      probed.push(row);
      continue;
    }
    probed.push(await health.probeHealth(prisma, {
      userId,
      appId: row.appId,
      vault: opts.vault,
      fetchImpl: opts.fetchImpl,
    }));
  }
  return probed.map((row) => store.publicConnection(row));
}

module.exports = {
  ...registry,
  ...store,
  ...vault,
  ...health,
  ...sync,
  ...revoke,
  ...gateway,
  ...prompt,
  ...mentions,
  ...redact,
  ...audit,
  listUserApps,
};
