'use strict';

const { APP_IDS, getManifest, normalizeAppId, STATUSES } = require('./registry');

const CONNECTOR_IDS = Object.freeze(['github', 'linkedin', 'x', 'facebook']);

const ALIASES = Object.freeze({
  github: 'github',
  gh: 'github',
  git: 'github',
  linkedin: 'linkedin',
  'linked-in': 'linkedin',
  li: 'linkedin',
  x: 'x',
  twitter: 'x',
  tweet: 'x',
  facebook: 'facebook',
  fb: 'facebook',
  meta: 'facebook',
});

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function canonicalAppId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (ALIASES[raw]) return ALIASES[raw];
  const compact = normalizeKey(raw);
  if (ALIASES[compact]) return ALIASES[compact];
  const fromRegistry = normalizeAppId(raw) || normalizeAppId(compact);
  if (fromRegistry) return fromRegistry;
  if (CONNECTOR_IDS.includes(compact)) return compact;
  return compact || null;
}

function parseMentionedNames(prompt) {
  const names = [];
  const re = /(^|[\s\u00A0])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  const text = String(prompt || '');
  let match = re.exec(text);
  while (match) {
    names.push(match[2]);
    match = re.exec(text);
  }
  return names;
}

function uniqueIds(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const id = canonicalAppId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isConnector(id) {
  return CONNECTOR_IDS.includes(id) || APP_IDS.includes(id);
}

function resolveMentionedApps(prompt, extraIds = []) {
  const fromText = parseMentionedNames(prompt).map(canonicalAppId);
  return uniqueIds([...(Array.isArray(extraIds) ? extraIds : []), ...fromText]);
}

function classifyMentions(mentionedIds, connections = []) {
  const byApp = new Map((connections || []).map((row) => [row.appId || row.app, row]));
  const attached = [];
  const needsConnect = [];
  const unavailable = [];

  for (const id of mentionedIds) {
    const manifest = getManifest(id);
    const row = byApp.get(id);
    const connected = row && row.status === STATUSES.CONNECTED;
    if (connected && manifest) {
      attached.push({
        id,
        name: manifest.name,
        tools: manifest.tools.map((tool) => tool.name),
        connection_id: row.id,
      });
      continue;
    }
    if (isConnector(id)) {
      needsConnect.push({
        id,
        name: manifest?.name || (id === 'facebook' ? 'Facebook' : id),
      });
      continue;
    }
    unavailable.push({ id, name: id });
  }

  return { attached, needsConnect, unavailable };
}

function buildMentionPrompt({ attached = [], needsConnect = [], unavailable = [] } = {}) {
  if (!attached.length && !needsConnect.length && !unavailable.length) return '';
  const lines = ['## Apps mencionadas'];
  if (attached.length) {
    lines.push('El usuario mencionó estas apps conectadas. Úsalas en este turno con sus herramientas. Nunca pidas ni inventes tokens.');
    for (const app of attached) {
      lines.push(`- @${app.name} connection_id=${app.connection_id} tools=${app.tools.join(',')}`);
    }
  }
  if (needsConnect.length) {
    lines.push('Estas apps se mencionaron pero NO están conectadas. No inventes datos ni simules la conexión. Pide al usuario que las conecte en Apps con la autorización oficial.');
    for (const app of needsConnect) {
      lines.push(`- @${app.name} no está conectada. Pide que la conecte antes de usarla.`);
    }
  }
  if (unavailable.length) {
    lines.push('Estas menciones son del catálogo y todavía no se pueden conectar. Dilo con claridad. No abras un navegador ni marques la app como conectada.');
    for (const app of unavailable) {
      lines.push(`- @${app.name} todavía no está disponible para conectar.`);
    }
  }
  return lines.join('\n');
}

function mentionedToolNames(attached = []) {
  const names = [];
  for (const app of attached) {
    for (const tool of app.tools || []) names.push(tool);
  }
  return names;
}

module.exports = {
  CONNECTOR_IDS,
  canonicalAppId,
  parseMentionedNames,
  resolveMentionedApps,
  classifyMentions,
  buildMentionPrompt,
  mentionedToolNames,
};
