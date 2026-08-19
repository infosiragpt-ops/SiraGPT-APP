'use strict';

/**
 * Tests for sso-boot-validator.js — defense-in-depth boot check
 * that warns when prod has SSO-enabled orgs but the matching
 * upstream lib (`@node-saml/node-saml` / `openid-client`) is not
 * installed (ratchet 44).
 */

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  validateActiveSsoConfig,
  __resetLibCacheForTest,
} = require('../src/utils/sso-boot-validator');

function makeLogger() {
  const calls = [];
  return {
    calls,
    warn(meta, msg) { calls.push({ level: 'warn', meta, msg }); },
    info(meta, msg) { calls.push({ level: 'info', meta, msg }); },
    error(meta, msg) { calls.push({ level: 'error', meta, msg }); },
  };
}

function makePrisma(orgs, { throwOnFind = false } = {}) {
  return {
    organization: {
      findMany: async () => {
        if (throwOnFind) throw new Error('db boom');
        return orgs;
      },
    },
  };
}

describe('sso-boot-validator', () => {
  beforeEach(() => {
    __resetLibCacheForTest();
  });

  it('is a no-op when NODE_ENV is not production', async () => {
    const logger = makeLogger();
    const prisma = makePrisma([
      { id: 'o1', slug: 'acme', ssoConfig: { provider: 'saml' } },
    ]);
    const res = await validateActiveSsoConfig({
      prisma,
      logger,
      env: { NODE_ENV: 'development' },
      has: () => false,
    });
    assert.deepStrictEqual(res, { checked: false, warnings: [] });
    assert.strictEqual(logger.calls.length, 0);
  });

  it('returns no warnings when no orgs have SSO enabled', async () => {
    const logger = makeLogger();
    const prisma = makePrisma([]);
    const res = await validateActiveSsoConfig({
      prisma,
      logger,
      env: { NODE_ENV: 'production' },
      has: () => false,
    });
    assert.strictEqual(res.checked, true);
    assert.deepStrictEqual(res.warnings, []);
    assert.strictEqual(logger.calls.length, 0);
  });

  it('warns when prod has a SAML org but @node-saml/node-saml is missing', async () => {
    const logger = makeLogger();
    const prisma = makePrisma([
      { id: 'o1', slug: 'acme', ssoConfig: { provider: 'saml' } },
      { id: 'o2', slug: 'globex', ssoConfig: { provider: 'saml' } },
    ]);
    const has = (spec) => spec === 'openid-client';
    const res = await validateActiveSsoConfig({
      prisma,
      logger,
      env: { NODE_ENV: 'production' },
      has,
    });
    assert.strictEqual(res.checked, true);
    assert.deepStrictEqual(res.warnings, ['sso_boot_validator_saml_lib_missing']);
    const warn = logger.calls.find(c => c.msg === 'sso_boot_validator_saml_lib_missing');
    assert.ok(warn, 'expected saml lib-missing warn log');
    assert.strictEqual(warn.meta.orgs, 2);
  });

  it('warns when prod has an OIDC org but openid-client is missing', async () => {
    const logger = makeLogger();
    const prisma = makePrisma([
      { id: 'o1', slug: 'acme', ssoConfig: { provider: 'oidc' } },
    ]);
    const has = (spec) => spec === '@node-saml/node-saml';
    const res = await validateActiveSsoConfig({
      prisma,
      logger,
      env: { NODE_ENV: 'production' },
      has,
    });
    assert.strictEqual(res.checked, true);
    assert.deepStrictEqual(res.warnings, ['sso_boot_validator_oidc_lib_missing']);
    const warn = logger.calls.find(c => c.msg === 'sso_boot_validator_oidc_lib_missing');
    assert.ok(warn);
    assert.strictEqual(warn.meta.orgs, 1);
  });

  it('warns for both providers when both libs are missing', async () => {
    const logger = makeLogger();
    const prisma = makePrisma([
      { id: 'o1', slug: 'acme', ssoConfig: { provider: 'saml' } },
      { id: 'o2', slug: 'globex', ssoConfig: { provider: 'oidc' } },
    ]);
    const res = await validateActiveSsoConfig({
      prisma,
      logger,
      env: { NODE_ENV: 'production' },
      has: () => false,
    });
    assert.deepStrictEqual(
      res.warnings.sort(),
      ['sso_boot_validator_oidc_lib_missing', 'sso_boot_validator_saml_lib_missing'],
    );
  });

  it('does not warn when both libs are installed', async () => {
    const logger = makeLogger();
    const prisma = makePrisma([
      { id: 'o1', slug: 'acme', ssoConfig: { provider: 'saml' } },
      { id: 'o2', slug: 'globex', ssoConfig: { provider: 'oidc' } },
    ]);
    const res = await validateActiveSsoConfig({
      prisma,
      logger,
      env: { NODE_ENV: 'production' },
      has: () => true,
    });
    assert.strictEqual(res.checked, true);
    assert.deepStrictEqual(res.warnings, []);
    assert.strictEqual(logger.calls.length, 0);
  });

  it('ignores orgs with unknown / null provider', async () => {
    const logger = makeLogger();
    const prisma = makePrisma([
      { id: 'o1', slug: 'acme', ssoConfig: null },
      { id: 'o2', slug: 'globex', ssoConfig: { provider: 'unknown' } },
      { id: 'o3', slug: 'umbrella', ssoConfig: undefined },
    ]);
    const res = await validateActiveSsoConfig({
      prisma,
      logger,
      env: { NODE_ENV: 'production' },
      has: () => false,
    });
    assert.deepStrictEqual(res.warnings, []);
  });

  it('swallows DB errors and returns checked:false', async () => {
    const logger = makeLogger();
    const prisma = makePrisma(null, { throwOnFind: true });
    const res = await validateActiveSsoConfig({
      prisma,
      logger,
      env: { NODE_ENV: 'production' },
      has: () => false,
    });
    assert.strictEqual(res.checked, false);
    assert.deepStrictEqual(res.warnings, []);
    const errLog = logger.calls.find(c => c.msg === 'sso_boot_validator_db_lookup_failed');
    assert.ok(errLog, 'expected db lookup failure to be logged');
  });

  it('is a no-op when prisma is not provided', async () => {
    const logger = makeLogger();
    const res = await validateActiveSsoConfig({
      logger,
      env: { NODE_ENV: 'production' },
      has: () => false,
    });
    assert.deepStrictEqual(res, { checked: false, warnings: [] });
  });

  it('uses the default lib presence probe when `has` is omitted', async () => {
    // @node-saml/node-saml is NOT installed in this repo; the
    // default `require.resolve` probe should correctly report it
    // as missing and warn accordingly.
    const logger = makeLogger();
    const prisma = makePrisma([
      { id: 'o1', slug: 'acme', ssoConfig: { provider: 'saml' } },
    ]);
    const res = await validateActiveSsoConfig({
      prisma,
      logger,
      env: { NODE_ENV: 'production' },
    });
    assert.strictEqual(res.checked, true);
    assert.ok(res.warnings.includes('sso_boot_validator_saml_lib_missing'));
  });
});
