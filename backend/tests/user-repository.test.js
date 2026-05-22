'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UserRepository } = require('../src/repositories/UserRepository');

const passthroughRetry = (fn) => fn();

function makePrismaSpy(returnValue = { id: 'u1' }) {
  const calls = { findUnique: [], update: [], create: [] };
  return {
    user: {
      findUnique: (arg) => { calls.findUnique.push(arg); return Promise.resolve(returnValue); },
      update: (arg) => { calls.update.push(arg); return Promise.resolve({ ...returnValue, ...arg.data }); },
      create: (arg) => { calls.create.push(arg); return Promise.resolve({ ...returnValue, ...arg.data }); },
    },
    _calls: calls,
  };
}

test('UserRepository: constructor validates deps', () => {
  assert.throws(() => new UserRepository({ withRetry: passthroughRetry }), /prisma is required/);
  assert.throws(() => new UserRepository({ prisma: {} }), /withRetry must be a function/);
});

test('UserRepository.findByEmail: forwards to prisma with where:{email}', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  await repo.findByEmail('a@b.com');
  assert.deepEqual(prisma._calls.findUnique[0], { where: { email: 'a@b.com' } });
});

test('UserRepository.findByEmail: forwards select projection when provided', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  await repo.findByEmail('a@b.com', { select: { id: true, gmailTokens: true } });
  assert.deepEqual(prisma._calls.findUnique[0], {
    where: { email: 'a@b.com' },
    select: { id: true, gmailTokens: true },
  });
});

test('UserRepository.findById: forwards to prisma with where:{id}', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  await repo.findById('u1');
  assert.deepEqual(prisma._calls.findUnique[0], { where: { id: 'u1' } });
});

test('UserRepository.updateGoogleIdentity: sends id + tokens', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  await repo.updateGoogleIdentity('u1', {
    googleId: 'g1',
    gmailTokens: 'enc-g',
    googleServicesTokens: 'enc-s',
  });
  assert.deepEqual(prisma._calls.update[0], {
    where: { id: 'u1' },
    data: { googleId: 'g1', gmailTokens: 'enc-g', googleServicesTokens: 'enc-s' },
  });
});

test('UserRepository.clearGmailTokens: nulls gmailTokens', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  await repo.clearGmailTokens('u1');
  assert.deepEqual(prisma._calls.update[0], { where: { id: 'u1' }, data: { gmailTokens: null } });
});

test('UserRepository.createOAuthUser: applies sensible defaults', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  await repo.createOAuthUser({
    googleId: 'g1',
    name: 'Sira',
    email: 'a@b.com',
    avatar: 'http://img',
    passwordHash: 'hash',
    gmailTokens: 'enc-g',
    googleServicesTokens: 'enc-s',
  });
  const arg = prisma._calls.create[0];
  assert.equal(arg.data.plan, 'FREE');
  assert.equal(arg.data.isAdmin, false);
  assert.equal(arg.data.monthlyCallLimit, 3);
  assert.equal(arg.data.monthlyLimit, 10000);
  assert.equal(arg.data.password, 'hash');
});

test('UserRepository: routes calls through withRetry wrapper', async () => {
  const prisma = makePrismaSpy();
  let calls = 0;
  const labels = [];
  const repo = new UserRepository({
    prisma,
    withRetry: (fn, opts) => { calls += 1; labels.push(opts?.label); return fn(); },
  });
  await repo.findByEmail('a@b.com');
  await repo.findById('u1');
  await repo.clearGmailTokens('u1');
  assert.equal(calls, 3);
  assert.deepEqual(labels, [
    'user-repo.findByEmail',
    'user-repo.findById',
    'user-repo.clearGmailTokens',
  ]);
});

test('UserRepository.createPasswordUser: defaults + omits google fields', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  await repo.createPasswordUser({ name: 'Sira', email: 'a@b.com', passwordHash: 'hash' });
  const arg = prisma._calls.create[0];
  assert.equal(arg.data.plan, 'FREE');
  assert.equal(arg.data.isAdmin, false);
  assert.equal(arg.data.apiUsage, 0);
  assert.equal(arg.data.monthlyCallLimit, 3);
  assert.equal(arg.data.monthlyLimit, 10000);
  assert.equal(arg.data.password, 'hash');
  assert.equal('googleId' in arg.data, false);
  assert.equal('gmailTokens' in arg.data, false);
  assert.equal('googleServicesTokens' in arg.data, false);
});

test('UserRepository.createPasswordUser: caller overrides take precedence', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  await repo.createPasswordUser({
    name: 'Sira',
    email: 'a@b.com',
    passwordHash: 'hash',
    plan: 'PRO',
    isAdmin: true,
    monthlyCallLimit: 999,
  });
  const arg = prisma._calls.create[0];
  assert.equal(arg.data.plan, 'PRO');
  assert.equal(arg.data.isAdmin, true);
  assert.equal(arg.data.monthlyCallLimit, 999);
});

test('UserRepository.updateRecoveryCodes: writes column with id projection', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  const codes = [{ hash: 'h1', usedAt: null }];
  await repo.updateRecoveryCodes('u1', codes);
  assert.deepEqual(prisma._calls.update[0], {
    where: { id: 'u1' },
    data: { totpRecoveryCodes: codes },
    select: { id: true },
  });
});

test('UserRepository.updateWebauthnCredentials: writes column with id projection', async () => {
  const prisma = makePrismaSpy();
  const repo = new UserRepository({ prisma, withRetry: passthroughRetry });
  const creds = [{ credentialId: 'c1', signCount: 42 }];
  await repo.updateWebauthnCredentials('u1', creds);
  assert.deepEqual(prisma._calls.update[0], {
    where: { id: 'u1' },
    data: { webauthnCredentials: creds },
    select: { id: true },
  });
});

test('UserRepository: new methods route through withRetry with stable labels', async () => {
  const prisma = makePrismaSpy();
  const labels = [];
  const repo = new UserRepository({
    prisma,
    withRetry: (fn, opts) => { labels.push(opts?.label); return fn(); },
  });
  await repo.createPasswordUser({ name: 'x', email: 'x@y', passwordHash: 'h' });
  await repo.updateRecoveryCodes('u1', []);
  await repo.updateWebauthnCredentials('u1', []);
  assert.deepEqual(labels, [
    'user-repo.createPasswordUser',
    'user-repo.updateRecoveryCodes',
    'user-repo.updateWebauthnCredentials',
  ]);
});
