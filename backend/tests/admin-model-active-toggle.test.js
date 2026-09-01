'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  parseIsActive,
  countPublication,
  setAiModelActive,
  pickerIncludesActiveModel,
} = require('../src/services/ai-model-publication');
const { curateVisibleTextModels } = require('../src/services/visible-model-catalog');
const {
  matchAdminRoutePolicy,
  ADMIN_ROUTE_POLICIES,
  createAdminRoutePermissionMiddleware,
} = require('../src/services/admin-route-policy');
const { ROLE_PERMISSIONS } = require('../src/services/rbac-catalog');

const MIGRATIONS_DIR = path.resolve(__dirname, '../prisma/migrations');
const DISABLE_ALL_MIGRATION = '20260831235900_disable_all_ai_models_by_admin_request';

function stubCatalog(rows) {
  const store = { rows: rows.map((row) => ({ ...row })) };
  return {
    store,
    aiModel: {
      async update({ where, data }) {
        const index = store.rows.findIndex((row) => row.id === where.id);
        if (index < 0) {
          const error = new Error('Record to update not found.');
          error.code = 'P2025';
          throw error;
        }
        store.rows[index] = { ...store.rows[index], ...data };
        return { ...store.rows[index] };
      },
      async count({ where } = {}) {
        if (!where) return store.rows.length;
        if (where.isActive === true) {
          return store.rows.filter((row) => row.isActive === true).length;
        }
        return store.rows.length;
      },
      async findMany({ where } = {}) {
        return store.rows.filter((row) => {
          if (where?.isActive === true && row.isActive !== true) return false;
          return true;
        });
      },
    },
  };
}

describe('admin model publication helper', () => {
  test('parseIsActive accepts JSON booleans and common string forms', () => {
    assert.equal(parseIsActive(true), true);
    assert.equal(parseIsActive(false), false);
    assert.equal(parseIsActive('true'), true);
    assert.equal(parseIsActive('false'), false);
    assert.equal(parseIsActive(undefined), undefined);
    assert.equal(parseIsActive('maybe'), undefined);
  });

  test('setAiModelActive toggles one row and returns Activos/Inactivos counts', async () => {
    const prisma = stubCatalog([
      { id: 'm1', name: 'claude-fable-5.1', displayName: 'Claude Fable 5.1', type: 'TEXT', isActive: false },
      { id: 'm2', name: 'muse-spark-1.1', displayName: 'Muse Spark 1.1', type: 'TEXT', isActive: true },
    ]);

    let cacheBusted = 0;
    const activated = await setAiModelActive(prisma, {
      id: 'm1',
      isActive: true,
      invalidateCache: async () => { cacheBusted += 1; },
    });
    assert.equal(activated.model.isActive, true);
    assert.equal(activated.stats.total, 2);
    assert.equal(activated.stats.active, 2);
    assert.equal(activated.stats.inactive, 0);
    assert.equal(cacheBusted, 1);

    const deactivated = await setAiModelActive(prisma, { id: 'm2', isActive: false });
    assert.equal(deactivated.model.isActive, false);
    assert.equal(deactivated.stats.active, 1);
    assert.equal(deactivated.stats.inactive, 1);
    assert.equal(prisma.store.rows.filter((row) => row.isActive).length, 1);
    assert.equal(prisma.store.rows.find((row) => row.id === 'm1').isActive, true);
  });

  test('setAiModelActive never writes without a single id', async () => {
    const prisma = stubCatalog([
      { id: 'm1', name: 'keep-me', isActive: true },
    ]);
    prisma.aiModel.updateMany = async () => {
      throw new Error('updateMany must not run for a single-model toggle');
    };

    await assert.rejects(() => setAiModelActive(prisma, { id: '', isActive: false }), /Modelo no encontrado/);
    await assert.rejects(() => setAiModelActive(prisma, { id: 'm1', isActive: 'nope' }), /booleano/);
    assert.equal(prisma.store.rows[0].isActive, true);
  });

  test('missing row is 404', async () => {
    const prisma = stubCatalog([]);
    await assert.rejects(
      () => setAiModelActive(prisma, { id: 'missing', isActive: true }),
      (error) => error.status === 404 && error.message === 'Modelo no encontrado',
    );
  });
});

describe('picker catalog follows isActive', () => {
  test('active TEXT rows appear; inactive rows stay out of the picker', () => {
    const rows = [
      { id: 'off', name: 'anthropic/claude-fable-5.1', displayName: 'Claude Fable 5.1', type: 'TEXT', isActive: false },
      { id: 'on', name: 'meta/muse-spark-1.1', displayName: 'Muse Spark 1.1', type: 'TEXT', isActive: true },
    ];
    const catalog = curateVisibleTextModels(rows);
    assert.equal(pickerIncludesActiveModel(catalog, rows[1]), true);
    assert.equal(pickerIncludesActiveModel(catalog, rows[0]), false);
    assert.ok(catalog.some((model) => model.id === 'on'));
    assert.ok(!catalog.some((model) => model.id === 'off'));
  });

  test('countPublication matches Activos/Inactivos cards', async () => {
    const prisma = stubCatalog([
      { id: 'a', isActive: true },
      { id: 'b', isActive: true },
      { id: 'c', isActive: false },
    ]);
    assert.deepEqual(await countPublication(prisma), { total: 3, active: 2, inactive: 1 });
  });
});

describe('admin route policy for the Estado switch', () => {
  test('Administrador (PLATFORM_ADMIN) keeps models.manage with models.read', () => {
    assert.ok(ROLE_PERMISSIONS.PLATFORM_ADMIN.includes('admin.models.read'));
    assert.ok(ROLE_PERMISSIONS.PLATFORM_ADMIN.includes('admin.models.manage'));
  });

  test('PATCH and PUT share admin.models.manage', () => {
    assert.equal(
      matchAdminRoutePolicy('PATCH', '/api/admin/models/model-123')?.routeKey,
      'PATCH /api/admin/models/:id',
    );
    assert.equal(
      matchAdminRoutePolicy('PUT', '/api/admin/models/model-123')?.permission,
      'admin.models.manage',
    );
    assert.equal(ADMIN_ROUTE_POLICIES['PATCH /api/admin/models/:id'].permission, 'admin.models.manage');
  });

  test('unauthenticated callers are rejected by the permission middleware', async () => {
    const middleware = createAdminRoutePermissionMiddleware({
      requirePermissionImpl() {
        return (req, res) => {
          if (!req.user) return res.status(401).json({ error: 'auth required' });
          if (!req.user.isAdmin && !req.user.isSuperAdmin) {
            return res.status(403).json({ error: 'forbidden', missingPermission: 'admin.models.manage' });
          }
          return res.status(200).json({ ok: true });
        };
      },
      writeAuditLog: async () => {},
      prisma: {},
    });

    const unauth = await new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ statusCode: this.statusCode, body }); },
      };
      middleware({ method: 'PATCH', originalUrl: '/api/admin/models/m1', path: '/api/admin/models/m1' }, res, () => {
        resolve({ statusCode: 200, body: { leaked: true } });
      });
    });
    assert.equal(unauth.statusCode, 401);

    const user = await new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ statusCode: this.statusCode, body }); },
      };
      middleware({
        method: 'PATCH',
        originalUrl: '/api/admin/models/m1',
        path: '/api/admin/models/m1',
        user: { id: 'u-1', isAdmin: false },
      }, res, () => resolve({ statusCode: 200, body: { leaked: true } }));
    });
    assert.equal(user.statusCode, 403);
    assert.equal(user.body.error, 'forbidden');
  });
});

describe('no new disable-all catalog migration', () => {
  test('this change does not add another unpublished-all SQL migration', () => {
    const names = fs.readdirSync(MIGRATIONS_DIR).filter((name) => {
      return fs.statSync(path.join(MIGRATIONS_DIR, name)).isDirectory();
    });
    assert.ok(names.includes(DISABLE_ALL_MIGRATION), 'historical disable-all migration stays in the tree');
    const newer = names.filter((name) => name > DISABLE_ALL_MIGRATION);
    for (const name of newer) {
      const sqlPath = path.join(MIGRATIONS_DIR, name, 'migration.sql');
      if (!fs.existsSync(sqlPath)) continue;
      const sql = fs.readFileSync(sqlPath, 'utf8');
      assert.doesNotMatch(
        sql,
        /update\s+"?ai_models"?\s+set\s+"?isActive"?\s*=\s*false/i,
        `${name} must not unpublished the catalog`,
      );
    }
  });
});
