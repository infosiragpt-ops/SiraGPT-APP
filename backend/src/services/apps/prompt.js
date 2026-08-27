'use strict';

const { listManifests, getManifest } = require('./registry');
const { listByUser, publicConnection } = require('./store');
const { modelSafeSummary } = require('./gateway');

function buildModelPrompt(connections = []) {
  const live = (connections || [])
    .map((row) => {
      const app = getManifest(row.appId || row.app);
      return app ? modelSafeSummary(app, row) : null;
    })
    .filter(Boolean);
  if (!live.length) return '';
  return [
    '## Apps conectadas',
    'El modelo solo recibe { app, connection_id, available_tools }. Nunca pidas ni inventes tokens.',
    ...live.map((entry) => `- ${entry.app} connection_id=${entry.connection_id} tools=${entry.available_tools.join(',')}`),
  ].join('\n');
}

async function buildUserAppsPrompt(prisma, userId) {
  if (!prisma || !userId) return '';
  try {
    const rows = await listByUser(prisma, userId);
    return buildModelPrompt(rows);
  } catch {
    return '';
  }
}

function catalogForUser(connections = []) {
  const byApp = new Map((connections || []).map((row) => [row.appId, row]));
  return listManifests().map((app) => ({
    ...require('./registry').publicManifest(app),
    connection: publicConnection(byApp.get(app.id)),
  }));
}

module.exports = {
  buildModelPrompt,
  buildUserAppsPrompt,
  catalogForUser,
};
