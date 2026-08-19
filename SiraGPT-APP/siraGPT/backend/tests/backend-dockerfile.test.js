'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('backend Dockerfile creates uploads instead of copying an optional directory', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'backend/Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /COPY --from=build[^\n]+\/app\/uploads/);
  assert.match(dockerfile, /mkdir -p \/app\/uploads/);
});
