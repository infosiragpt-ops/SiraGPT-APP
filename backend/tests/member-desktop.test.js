'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  buildDockerRunArgs,
  containerName,
  safeUserKey,
  signDesktopToken,
  verifyDesktopToken,
  volumeName,
} = require('../src/services/member-desktop');

test('member desktop names are stable and docker-safe', () => {
  assert.equal(containerName('User_ABC-123'), 'siragpt-desktop-user_abc-123');
  assert.match(containerName('!!'), /^siragpt-desktop-[a-f0-9]{24}$/);
  assert.equal(volumeName('member-1', 'home'), 'siragpt-desktop-home-member-1');
  assert.equal(safeUserKey('Valeria Castro'), safeUserKey('Valeria Castro'));
});

test('member desktop docker run args isolate the VNC port on loopback', () => {
  const args = buildDockerRunArgs({ userId: 'member-1', hostPort: 16081, image: 'siragpt-member-desktop:latest' });
  assert.ok(args.includes('run'));
  assert.ok(args.includes('--name'));
  assert.ok(args.includes('siragpt-desktop-member-1'));
  assert.ok(args.includes('127.0.0.1:16081:6080'));
  assert.ok(args.includes('--cap-drop'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.includes('--security-opt'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('siragpt-desktop-home-member-1:/home/agent'));
  assert.ok(args.includes('siragpt-desktop-ws-member-1:/workspace'));
});

test('member desktop tokens round-trip and expire', () => {
  const env = { NODE_ENV: 'test', JWT_SECRET: 'unit-test-secret-unit-test-secret' };
  const token = signDesktopToken('user-42', env);
  const claims = verifyDesktopToken(token, env);
  assert.equal(claims.sub, 'user-42');
  assert.ok(claims.exp > Date.now());
  assert.equal(verifyDesktopToken('nope', env), null);
  assert.equal(verifyDesktopToken(token, { ...env, JWT_SECRET: 'other-secret-other-secret-other' }), null);
});
