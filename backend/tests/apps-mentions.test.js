'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMentionedNames,
  resolveMentionedApps,
  classifyMentions,
  buildMentionPrompt,
  mentionedToolNames,
  STATUSES,
} = require('../src/services/apps');

test('parses @mentions and attaches only healthy connected app tools', () => {
  const ids = resolveMentionedApps('Usa @GitHub y @LinkedIn', ['x']);
  assert.deepEqual(ids.sort(), ['github', 'linkedin', 'x']);
  const classified = classifyMentions(ids, [
    { id: 'c1', appId: 'github', status: STATUSES.CONNECTED },
    { id: 'c2', appId: 'x', status: STATUSES.EXPIRED },
  ]);
  assert.deepEqual(classified.attached.map((app) => app.id), ['github']);
  assert.ok(classified.attached[0].tools.includes('github_list_repos'));
  assert.deepEqual(classified.needsConnect.map((app) => app.id).sort(), ['linkedin', 'x']);
  assert.deepEqual(mentionedToolNames(classified.attached), [
    'github_list_repos',
    'github_create_issue',
  ]);
  const prompt = buildMentionPrompt(classified);
  assert.match(prompt, /@GitHub/);
  assert.match(prompt, /github_list_repos/);
  assert.match(prompt, /LinkedIn no está conectada/);
  assert.doesNotMatch(prompt, /gho_|Bearer |accessToken/i);
});

test('catalog-only mentions stay unavailable and never look connected', () => {
  const ids = resolveMentionedApps('Busca en @Indeed y @Etsy');
  const classified = classifyMentions(ids, []);
  assert.equal(classified.attached.length, 0);
  assert.ok(classified.unavailable.some((app) => app.id === 'indeed'));
  const prompt = buildMentionPrompt(classified);
  assert.match(prompt, /todavía no está disponible para conectar/);
  assert.doesNotMatch(prompt, /connection_id=/);
});

test('parseMentionedNames ignores emails', () => {
  assert.deepEqual(parseMentionedNames('escribe a luis@siragpt.com y luego @GitHub'), ['GitHub']);
});
