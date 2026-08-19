'use strict';

/**
 * Characterization tests for backend/src/services/builder/blueprint.js
 *
 * Pins the behavior of the deterministic build-plan generator:
 *  - inferFieldType field-name → type rules (first match wins)
 *  - estimate low/medium/high complexity thresholds
 *  - planFromBrief end-to-end (stack by platform, CRUD pages, dataModel
 *    auto id+createdAt, invalid-brief error)
 *  - STACK_BY_PLATFORM table shape
 *
 * Pure, synchronous, no I/O. All inputs are literal fixtures derived from
 * contracts.js ProjectBriefSchema.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  BlueprintSchema,
  planFromBrief,
  inferFieldType,
  STACK_BY_PLATFORM,
} = require('../src/services/builder/blueprint');

// ---------------------------------------------------------------------------
// Fixture builder — a fully valid ProjectBrief per contracts.js.
// ---------------------------------------------------------------------------
function makeBrief(overrides = {}) {
  return {
    purpose: 'Gestionar inventario',
    platform: 'web',
    audience: 'pymes',
    coreFeatures: [],
    dataEntities: [],
    style: { theme: 'minimalista', refs: [] },
    integrations: [],
    constraints: '',
    openQuestions: [],
    ...overrides,
  };
}

describe('exports', () => {
  test('exposes the documented public surface', () => {
    assert.equal(typeof inferFieldType, 'function');
    assert.equal(typeof planFromBrief, 'function');
    assert.equal(typeof STACK_BY_PLATFORM, 'object');
    assert.ok(STACK_BY_PLATFORM !== null);
    assert.ok(BlueprintSchema && typeof BlueprintSchema.safeParse === 'function');
  });
});

describe('inferFieldType', () => {
  test('priceUSD → decimal (price rule beats default)', () => {
    assert.equal(inferFieldType('priceUSD'), 'decimal');
  });

  test('created_at → datetime', () => {
    assert.equal(inferFieldType('created_at'), 'datetime');
  });

  test('email → email', () => {
    assert.equal(inferFieldType('email'), 'email');
  });

  test('isActive → boolean', () => {
    assert.equal(inferFieldType('isActive'), 'boolean');
  });

  test('name → string (no rule matches → default)', () => {
    assert.equal(inferFieldType('name'), 'string');
  });

  test('id rule matches first (^|_)id$', () => {
    assert.equal(inferFieldType('id'), 'id');
    assert.equal(inferFieldType('user_id'), 'id');
  });

  test('url-ish names → url', () => {
    assert.equal(inferFieldType('url'), 'url');
    assert.equal(inferFieldType('enlace'), 'url');
  });

  test('integer-ish names → integer', () => {
    assert.equal(inferFieldType('cantidad'), 'integer');
    assert.equal(inferFieldType('stock'), 'integer');
  });

  test('text-ish names → text', () => {
    assert.equal(inferFieldType('descripcion'), 'text');
    assert.equal(inferFieldType('notes'), 'text');
  });

  test('phone-ish names → phone', () => {
    assert.equal(inferFieldType('telefono'), 'phone');
    assert.equal(inferFieldType('phone'), 'phone');
  });

  test('first match wins: a name matching an earlier rule takes that type', () => {
    // "email" also is plain text but the email rule precedes the text rule.
    assert.equal(inferFieldType('email'), 'email');
  });
});

describe('STACK_BY_PLATFORM', () => {
  test('has all four platforms with the four stack fields', () => {
    for (const platform of ['web', 'mobile', 'landing', 'desktop']) {
      const s = STACK_BY_PLATFORM[platform];
      assert.ok(s, `missing platform ${platform}`);
      assert.equal(typeof s.frontend, 'string');
      assert.equal(typeof s.backend, 'string');
      assert.equal(typeof s.database, 'string');
      assert.equal(typeof s.hosting, 'string');
    }
  });

  test('web maps to Next.js / Route Handlers / PostgreSQL', () => {
    assert.deepEqual(STACK_BY_PLATFORM.web, {
      frontend: 'Next.js (React)',
      backend: 'Next.js Route Handlers',
      database: 'PostgreSQL',
      hosting: 'Docker / Vercel',
    });
  });

  test('landing has placeholder backend/database', () => {
    assert.equal(STACK_BY_PLATFORM.landing.backend, '—');
    assert.equal(STACK_BY_PLATFORM.landing.database, '—');
  });
});

describe('estimate (via planFromBrief.estimate)', () => {
  // weight = screens + entities * 1.5; low<=4, medium<=9, else high.

  test('low: bare landing (1 screen, 0 entities → weight 1)', () => {
    const plan = planFromBrief(makeBrief({ platform: 'landing' }));
    assert.equal(plan.estimate.screens, 1);
    assert.equal(plan.estimate.entities, 0);
    assert.equal(plan.estimate.complexity, 'low');
  });

  test('medium: web with 1 entity → 1 Home + 2 CRUD = 3 screens + 1.5 = weight 4.5', () => {
    const plan = planFromBrief(makeBrief({
      platform: 'web',
      dataEntities: [{ name: 'Producto', fields: ['nombre'] }],
    }));
    assert.equal(plan.estimate.screens, 3); // Home + Lista + Detalle
    assert.equal(plan.estimate.entities, 1);
    assert.equal(plan.estimate.complexity, 'medium'); // 3 + 1.5 = 4.5 (>4, <=9)
  });

  test('high: web with 3 entities → weight 7 + 4.5 = 11.5', () => {
    const plan = planFromBrief(makeBrief({
      platform: 'web',
      dataEntities: [
        { name: 'A', fields: [] },
        { name: 'B', fields: [] },
        { name: 'C', fields: [] },
      ],
    }));
    // 1 Home + 3*2 CRUD = 7 screens; 7 + 3*1.5 = 11.5 → high
    assert.equal(plan.estimate.screens, 7);
    assert.equal(plan.estimate.entities, 3);
    assert.equal(plan.estimate.complexity, 'high');
  });

  test('boundary: weight exactly 4 is low (landing with auth feature → 3 screens, 0 entities)', () => {
    // landing keeps pages single-purpose but feature pages still added; auth adds 2.
    const plan = planFromBrief(makeBrief({
      platform: 'landing',
      coreFeatures: ['login de usuarios'],
    }));
    // Landing + Login + Registro = 3 screens, 0 entities → weight 3 → low
    assert.equal(plan.estimate.screens, 3);
    assert.equal(plan.estimate.entities, 0);
    assert.equal(plan.estimate.complexity, 'low');
  });
});

describe('planFromBrief — stack selection', () => {
  test('web brief gets the web stack', () => {
    const plan = planFromBrief(makeBrief({ platform: 'web' }));
    assert.deepEqual(plan.stack, STACK_BY_PLATFORM.web);
  });

  test('mobile brief gets the mobile stack', () => {
    const plan = planFromBrief(makeBrief({ platform: 'mobile' }));
    assert.deepEqual(plan.stack, STACK_BY_PLATFORM.mobile);
  });

  test('desktop brief gets the desktop stack', () => {
    const plan = planFromBrief(makeBrief({ platform: 'desktop' }));
    assert.deepEqual(plan.stack, STACK_BY_PLATFORM.desktop);
  });
});

describe('planFromBrief — pages / CRUD surface', () => {
  test('landing brief: first page is named "Landing", NO per-entity CRUD pages', () => {
    const plan = planFromBrief(makeBrief({
      platform: 'landing',
      dataEntities: [{ name: 'Producto', fields: ['nombre'] }],
    }));
    assert.equal(plan.pages[0].name, 'Landing');
    // No CRUD pages despite the entity.
    const crud = plan.pages.filter((p) => /· (Lista|Detalle)$/.test(p.name));
    assert.equal(crud.length, 0);
    assert.equal(plan.pages.length, 1);
  });

  test('web brief: first page is "Home" and entity yields Lista + Detalle pages', () => {
    const plan = planFromBrief(makeBrief({
      platform: 'web',
      dataEntities: [{ name: 'Producto', fields: ['nombre'] }],
    }));
    assert.equal(plan.pages[0].name, 'Home');
    const names = plan.pages.map((p) => p.name);
    assert.ok(names.includes('Producto · Lista'));
    assert.ok(names.includes('Producto · Detalle'));
  });

  test('feature keyword adds matching pages and dedupes by name', () => {
    const plan = planFromBrief(makeBrief({
      platform: 'web',
      coreFeatures: ['dashboard de control', 'panel admin'], // both match dashboard rule
    }));
    const dashboards = plan.pages.filter((p) => p.name === 'Dashboard');
    assert.equal(dashboards.length, 1); // deduped
  });
});

describe('planFromBrief — dataModel', () => {
  test('auto-adds id + createdAt when not declared', () => {
    const plan = planFromBrief(makeBrief({
      platform: 'web',
      dataEntities: [{ name: 'Producto', fields: ['nombre'] }],
    }));
    const model = plan.dataModel.find((m) => m.entity === 'Producto');
    const fieldNames = model.fields.map((f) => f.name);
    assert.deepEqual(fieldNames, ['id', 'nombre', 'createdAt']);
    assert.equal(model.fields.find((f) => f.name === 'id').type, 'id');
    assert.equal(model.fields.find((f) => f.name === 'nombre').type, 'string');
    assert.equal(model.fields.find((f) => f.name === 'createdAt').type, 'datetime');
  });

  test('does NOT duplicate id when an id field is already declared', () => {
    const plan = planFromBrief(makeBrief({
      platform: 'web',
      dataEntities: [{ name: 'Producto', fields: ['user_id', 'nombre'] }],
    }));
    const model = plan.dataModel.find((m) => m.entity === 'Producto');
    const ids = model.fields.filter((f) => /(^|_)id$/i.test(f.name));
    assert.equal(ids.length, 1);
    // declared user_id preserved, no synthetic 'id' prepended
    assert.ok(!model.fields.some((f) => f.name === 'id'));
  });

  test('does NOT duplicate createdAt when a created-ish field is declared', () => {
    const plan = planFromBrief(makeBrief({
      platform: 'web',
      dataEntities: [{ name: 'Producto', fields: ['createdOn'] }],
    }));
    const model = plan.dataModel.find((m) => m.entity === 'Producto');
    const createds = model.fields.filter((f) => /created/i.test(f.name));
    assert.equal(createds.length, 1);
    assert.ok(!model.fields.some((f) => f.name === 'createdAt'));
  });

  test('empty dataEntities → empty dataModel', () => {
    const plan = planFromBrief(makeBrief({ platform: 'web', dataEntities: [] }));
    assert.deepEqual(plan.dataModel, []);
  });
});

describe('planFromBrief — integrations & milestones', () => {
  test('integrations passed through (copied array)', () => {
    const ints = ['Stripe', 'SendGrid'];
    const plan = planFromBrief(makeBrief({ platform: 'web', integrations: ints }));
    assert.deepEqual(plan.integrations, ints);
    assert.notEqual(plan.integrations, ints); // spread copy, not same ref
  });

  test('always has Setup and QA milestones', () => {
    const plan = planFromBrief(makeBrief({ platform: 'web' }));
    const titles = plan.milestones.map((m) => m.title);
    assert.ok(titles.includes('Setup & scaffolding'));
    assert.ok(titles.includes('QA & despliegue'));
  });

  test('data-model milestone appears only when entities exist', () => {
    const without = planFromBrief(makeBrief({ platform: 'web', dataEntities: [] }));
    assert.ok(!without.milestones.some((m) => m.title === 'Modelo de datos & migraciones'));

    const withEntities = planFromBrief(makeBrief({
      platform: 'web',
      dataEntities: [{ name: 'X', fields: [] }],
    }));
    assert.ok(withEntities.milestones.some((m) => m.title === 'Modelo de datos & migraciones'));
  });

  test('integrations milestone appears only when integrations exist', () => {
    const without = planFromBrief(makeBrief({ platform: 'web', integrations: [] }));
    assert.ok(!without.milestones.some((m) => m.title === 'Integraciones'));

    const withInt = planFromBrief(makeBrief({ platform: 'web', integrations: ['Stripe'] }));
    assert.ok(withInt.milestones.some((m) => m.title === 'Integraciones'));
  });
});

describe('planFromBrief — validation errors', () => {
  test('invalid brief throws "invalid ProjectBrief"', () => {
    assert.throws(
      () => planFromBrief({ platform: 'web' }), // missing required fields
      /blueprint: invalid ProjectBrief/,
    );
  });

  test('unknown platform value throws', () => {
    assert.throws(
      () => planFromBrief(makeBrief({ platform: 'console' })),
      /blueprint: invalid ProjectBrief/,
    );
  });

  test('null input throws invalid ProjectBrief', () => {
    assert.throws(() => planFromBrief(null), /blueprint: invalid ProjectBrief/);
  });

  test('produced plan satisfies BlueprintSchema', () => {
    const plan = planFromBrief(makeBrief({
      platform: 'web',
      coreFeatures: ['login'],
      dataEntities: [{ name: 'Producto', fields: ['nombre', 'precio'] }],
      integrations: ['Stripe'],
    }));
    assert.ok(BlueprintSchema.safeParse(plan).success);
  });
});
