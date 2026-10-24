'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const messageAttachments = require('../src/services/message-attachments');

// Execute the route's actual loader without booting providers or an HTTP server.
const route = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
function actualFunction(name) {
  const expression = new RegExp(`(?:async )?function ${name}\\(`);
  const start = route.search(expression);
  assert.ok(start >= 0, `${name} exists in the route`);
  return route.slice(start, route.indexOf('\n}', start) + 2);
}

function loader(rows) {
  const lookups = [];
  const context = {
    messageAttachments,
    prisma: { file: { findFirst: async ({ where }) => {
      lookups.push(where);
      return rows.find(row => row.id === where.id && row.userId === where.userId) || null;
    } } },
  };
  vm.createContext(context);
  vm.runInContext(['resolveFileId', 'isImageMime', 'uploadPublicUrl', 'toProcessedFile', 'loadUserFile']
    .map(actualFunction).join('\n'), context);
  return { load: context.loadUserFile, lookups };
}

const image = {
  id: 'image-1', userId: 'owner', originalName: 'reference.png', filename: 'stored-reference.png',
  mimeType: 'image/png', path: '/uploads/owner/stored-reference.png', extractedText: null,
};

test('/generate keeps a validated folder path in the owner-loaded record persisted with the turn', async () => {
  const { load, lookups } = loader([image]);
  const processed = await load(image.id, 'owner', {
    id: image.id, relativePath: 'Referencias/Marca/reference.png',
    name: 'forged-name', mimeType: 'text/plain', path: '/etc/passwd',
  });
  assert.equal(processed.relativePath, 'Referencias/Marca/reference.png');
  assert.equal(processed.name, image.originalName);
  assert.equal(processed.mimeType, image.mimeType);
  assert.equal(processed.path, image.path);
  assert.equal(JSON.parse(JSON.stringify(processed)).relativePath, processed.relativePath);
  assert.equal(lookups[0].userId, 'owner');
  assert.equal(lookups[0].id, image.id);
});

test('/generate cannot attach metadata to another owner or a different file ID', async () => {
  const { load } = loader([image]);
  assert.equal(await load(image.id, 'other-owner', { id: image.id, relativePath: 'Root/reference.png' }), null);
  const mismatched = await load(image.id, 'owner', { id: 'other-file', relativePath: 'Root/reference.png' });
  assert.equal(mismatched.relativePath, undefined);
  const unsafe = await load(image.id, 'owner', { id: image.id, relativePath: '../private/reference.png' });
  assert.equal(unsafe.relativePath, undefined);
});
