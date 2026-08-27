'use strict';

const { listManifests, getManifest } = require('./registry');
const { listByUser, publicConnection } = require('./store');
const { modelSafeSummary } = require('./gateway');
const { resolveMentionedApps, classifyMentions, buildMentionPrompt } = require('./mentions');

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

async function buildUserAppsPrompt(prisma, userId, opts = {}) {
  if (!prisma || !userId) return '';
  try {
    const rows = await listByUser(prisma, userId);
    const mentionedIds = resolveMentionedApps(opts.prompt, opts.mentionedApps);
    const classified = classifyMentions(mentionedIds, rows);
    const live = mentionedIds.length
      ? rows.filter((row) => mentionedIds.includes(row.appId) && row.status === 'connected')
      : rows;
    const connectedBlock = buildModelPrompt(live);
    const mentionBlock = buildMentionPrompt(classified);
    return [connectedBlock, mentionBlock].filter(Boolean).join('\n\n');
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
