'use strict';

/**
 * usage-monitor.checkUsageAndAlert percentage correctness.
 *
 * `monthlyCallLimit` holds calls REMAINING (decrements from the cap). The
 * service used to divide remaining/cap, inverting the call-usage percentage
 * (a brand-new FREE user read as 100% used; a fully-spent one as 0%), and
 * divided apiUsage by a possibly-zero monthlyLimit (NaN for FREE users). These
 * tests pin the corrected, consumed-based math.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const DB_PATH = require.resolve('../src/config/database');

// Minimal prisma stub: a user row + an empty usageAlert table (so the
// always-called getLastAlertSent resolves to null and no alert fires).
let currentUser = null;
const prismaStub = {
  user: { findUnique: async () => currentUser },
  usageAlert: { findFirst: async () => null, create: async () => ({}) },
};
const origCache = require.cache[DB_PATH];
require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: prismaStub };
const usageMonitor = require('../src/services/usage-monitor');
if (origCache) require.cache[DB_PATH] = origCache; else delete require.cache[DB_PATH];

test('fresh FREE user reports 0% (not NaN api / not 100% calls)', async () => {
  currentUser = { id: 'u1', plan: 'FREE', apiUsage: 0, monthlyLimit: 0, monthlyCallLimit: 3 };
  const res = await usageMonitor.checkUsageAndAlert('u1');
  assert.equal(res.apiUsage.percentage, 0, 'api percentage is a defined 0, not NaN');
  assert.equal(res.callUsage.percentage, 0, 'no calls consumed → 0%, not the inverted 100%');
  assert.equal(res.callUsage.current, 0, 'current = consumed = 0');
});

test('FREE user who has spent 2 of 3 calls reports ~67%', async () => {
  currentUser = { id: 'u1', plan: 'FREE', apiUsage: 0, monthlyLimit: 0, monthlyCallLimit: 1 };
  const res = await usageMonitor.checkUsageAndAlert('u1');
  assert.ok(Math.abs(res.callUsage.percentage - 2 / 3) < 1e-9, '2 of 3 consumed → 2/3');
  assert.equal(res.callUsage.current, 2);
});

test('PRO user api percentage is consumed/limit', async () => {
  currentUser = { id: 'u2', plan: 'PRO', apiUsage: 50, monthlyLimit: 100, monthlyCallLimit: 1000 };
  const res = await usageMonitor.checkUsageAndAlert('u2');
  assert.equal(res.apiUsage.percentage, 0.5);
});
