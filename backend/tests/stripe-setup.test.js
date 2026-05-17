/**
 * Tests for stripe-setup.js — Stripe product/price bootstrap helpers.
 *
 * The module depends on:
 *   - ../services/stripe  (createOrUpdateProducts, isConfigured)
 *   - ../config/database  (prisma.systemSettings.{findUnique,upsert})
 *
 * Both are heavy and depend on real network / DB. We inject mocks
 * directly into Node's require cache BEFORE requiring stripe-setup,
 * so the module picks up our stubs at module-resolution time.
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const { describe, it, before, after, beforeEach } = require('node:test');

const STRIPE_PATH = require.resolve('../src/services/stripe');
const DB_PATH = require.resolve('../src/config/database');
const SETUP_PATH = require.resolve('../src/utils/stripe-setup');

// ── Mock factory + cache injection ─────────────────────────────────

const stripeMock = {
  isConfigured: true,
  createOrUpdateProducts: async () => ({}),
};

const dbMock = {
  systemSettings: {
    findUnique: async () => null,
    upsert: async () => null,
  },
};

// Save originals so we can restore other tests' world.
let origStripe;
let origDb;
let origSetupCache;

function installMocks() {
  origStripe = require.cache[STRIPE_PATH];
  origDb = require.cache[DB_PATH];
  origSetupCache = require.cache[SETUP_PATH];

  // Build minimal Module objects so the require cache sees a real
  // entry rather than a synthetic shape.
  function makeCacheEntry(id, exports_) {
    const m = new Module(id);
    m.filename = id;
    m.loaded = true;
    m.exports = exports_;
    m.paths = Module._nodeModulePaths(path.dirname(id));
    return m;
  }
  require.cache[STRIPE_PATH] = makeCacheEntry(STRIPE_PATH, stripeMock);
  require.cache[DB_PATH] = makeCacheEntry(DB_PATH, dbMock);
  // Clear stripe-setup so it re-requires our mocks.
  delete require.cache[SETUP_PATH];
}

function restoreMocks() {
  if (origStripe) require.cache[STRIPE_PATH] = origStripe;
  else delete require.cache[STRIPE_PATH];
  if (origDb) require.cache[DB_PATH] = origDb;
  else delete require.cache[DB_PATH];
  if (origSetupCache) require.cache[SETUP_PATH] = origSetupCache;
  else delete require.cache[SETUP_PATH];
}

// Mute the module's console output during tests.
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
function muteConsole() {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}
function restoreConsole() {
  console.log = _origLog;
  console.warn = _origWarn;
  console.error = _origError;
}

let setup;

before(() => {
  installMocks();
  muteConsole();
  setup = require('../src/utils/stripe-setup');
  restoreConsole();
});

after(() => {
  restoreMocks();
});

beforeEach(() => {
  // Reset mock state between cases.
  stripeMock.isConfigured = true;
  stripeMock.createOrUpdateProducts = async () => ({});
  dbMock.systemSettings.findUnique = async () => null;
  dbMock.systemSettings.upsert = async () => null;
});

// ── getPriceIdForPlan ─────────────────────────────────────────────

describe('getPriceIdForPlan', () => {
  it('returns the value from systemSettings when present', async () => {
    dbMock.systemSettings.findUnique = async ({ where }) => {
      assert.equal(where.key, 'STRIPE_PRICE_PRO');
      return { value: 'price_db_pro_xyz' };
    };
    const out = await setup.getPriceIdForPlan('PRO');
    assert.equal(out, 'price_db_pro_xyz');
  });

  it('falls back to process.env[STRIPE_PRICE_<plan>] when DB has no entry', async () => {
    const prev = process.env.STRIPE_PRICE_PRO_MAX;
    process.env.STRIPE_PRICE_PRO_MAX = 'price_env_pro_max';
    try {
      const out = await setup.getPriceIdForPlan('PRO_MAX');
      assert.equal(out, 'price_env_pro_max');
    } finally {
      if (prev === undefined) delete process.env.STRIPE_PRICE_PRO_MAX;
      else process.env.STRIPE_PRICE_PRO_MAX = prev;
    }
  });

  it('returns the dummy demo ID when Stripe is not configured (PRO)', async () => {
    stripeMock.isConfigured = false;
    muteConsole();
    try {
      const out = await setup.getPriceIdForPlan('PRO');
      assert.equal(out, 'price_demo_pro');
    } finally {
      restoreConsole();
    }
  });

  it('returns the dummy demo ID when Stripe is not configured (PRO_MAX)', async () => {
    stripeMock.isConfigured = false;
    muteConsole();
    try {
      const out = await setup.getPriceIdForPlan('PRO_MAX');
      assert.equal(out, 'price_demo_pro_max');
    } finally {
      restoreConsole();
    }
  });

  it('returns the dummy demo ID when Stripe is not configured (ENTERPRISE)', async () => {
    stripeMock.isConfigured = false;
    muteConsole();
    try {
      const out = await setup.getPriceIdForPlan('ENTERPRISE');
      assert.equal(out, 'price_demo_enterprise');
    } finally {
      restoreConsole();
    }
  });

  it('returns the fallback demo ID for an unknown plan when unconfigured', async () => {
    stripeMock.isConfigured = false;
    muteConsole();
    try {
      const out = await setup.getPriceIdForPlan('UNKNOWN');
      assert.equal(out, 'price_demo_fallback');
    } finally {
      restoreConsole();
    }
  });

  it('throws when Stripe IS configured but no price id is known', async () => {
    stripeMock.isConfigured = true;
    const prev = process.env.STRIPE_PRICE_UNKNOWN_PLAN;
    delete process.env.STRIPE_PRICE_UNKNOWN_PLAN;
    try {
      await assert.rejects(
        () => setup.getPriceIdForPlan('UNKNOWN_PLAN'),
        /not configured for plan: UNKNOWN_PLAN/,
      );
    } finally {
      if (prev !== undefined) process.env.STRIPE_PRICE_UNKNOWN_PLAN = prev;
    }
  });

  it('DB value takes precedence over env var', async () => {
    dbMock.systemSettings.findUnique = async () => ({ value: 'price_db_wins' });
    process.env.STRIPE_PRICE_PRO = 'price_env_loses';
    try {
      const out = await setup.getPriceIdForPlan('PRO');
      assert.equal(out, 'price_db_wins');
    } finally {
      delete process.env.STRIPE_PRICE_PRO;
    }
  });

  it('treats DB setting.value falsy/empty as "not present" and continues', async () => {
    dbMock.systemSettings.findUnique = async () => ({ value: '' });
    process.env.STRIPE_PRICE_PRO = 'price_env_when_db_empty';
    try {
      const out = await setup.getPriceIdForPlan('PRO');
      assert.equal(out, 'price_env_when_db_empty');
    } finally {
      delete process.env.STRIPE_PRICE_PRO;
    }
  });
});

// ── initializeStripeProducts ──────────────────────────────────────

describe('initializeStripeProducts', () => {
  it('calls stripe.createOrUpdateProducts and persists each price into systemSettings', async () => {
    const upsertCalls = [];
    stripeMock.createOrUpdateProducts = async () => ({
      PRO: {
        product: { id: 'prod_pro' },
        price: { id: 'price_pro', unit_amount: 1500 },
        planData: { credits: 1000 },
      },
      PRO_MAX: {
        product: { id: 'prod_promax' },
        price: { id: 'price_promax', unit_amount: 3000 },
        planData: { credits: 5000 },
      },
    });
    dbMock.systemSettings.upsert = async (args) => {
      upsertCalls.push(args);
      return null;
    };

    muteConsole();
    let result;
    try {
      result = await setup.initializeStripeProducts();
    } finally {
      restoreConsole();
    }

    assert.equal(Object.keys(result).length, 2);
    assert.equal(upsertCalls.length, 2);
    const keys = upsertCalls.map(c => c.where.key).sort();
    assert.deepEqual(keys, ['STRIPE_PRICE_PRO', 'STRIPE_PRICE_PRO_MAX']);
    const values = upsertCalls.map(c => c.update.value).sort();
    assert.deepEqual(values, ['price_pro', 'price_promax']);
  });

  it('propagates errors from stripe.createOrUpdateProducts', async () => {
    stripeMock.createOrUpdateProducts = async () => {
      throw new Error('stripe API down');
    };
    muteConsole();
    try {
      await assert.rejects(
        () => setup.initializeStripeProducts(),
        /stripe API down/,
      );
    } finally {
      restoreConsole();
    }
  });

  it('propagates errors from prisma.systemSettings.upsert', async () => {
    stripeMock.createOrUpdateProducts = async () => ({
      PRO: {
        product: { id: 'p' },
        price: { id: 'pr', unit_amount: 100 },
        planData: { credits: 10 },
      },
    });
    dbMock.systemSettings.upsert = async () => {
      throw new Error('db locked');
    };
    muteConsole();
    try {
      await assert.rejects(
        () => setup.initializeStripeProducts(),
        /db locked/,
      );
    } finally {
      restoreConsole();
    }
  });
});

// ── module surface ───────────────────────────────────────────────

describe('module surface', () => {
  it('exports exactly { initializeStripeProducts, getPriceIdForPlan }', () => {
    const keys = Object.keys(setup).sort();
    assert.deepEqual(keys, ['getPriceIdForPlan', 'initializeStripeProducts']);
  });
});
