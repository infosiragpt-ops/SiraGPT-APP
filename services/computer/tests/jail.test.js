'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WORKSPACE = '/workspace';
function jail(userPath) {
  const raw = String(userPath || '');
  const rel = raw.replace(/^\/+/, '');
  const resolved = path.resolve(WORKSPACE, rel);
  const root = path.resolve(WORKSPACE);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) { const e = new Error('path_escape'); e.code = 'path_escape'; throw e; }
  return resolved;
}
test('jail allows relative', () => { assert.equal(jail('task1/out.txt'), '/workspace/task1/out.txt'); });
test('jail blocks escape', () => { assert.throws(() => jail('../etc/passwd'), /path_escape/); });
test('jail maps abs into workspace', () => { assert.equal(jail('/etc/passwd'), '/workspace/etc/passwd'); });
