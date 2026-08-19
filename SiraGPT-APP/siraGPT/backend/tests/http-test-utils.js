const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const prisma = require('../src/config/database');
const { buildJsonSchemaRegistry } = require('../src/services/contracts/schema-registry');

const TEST_JWT_SECRET = 'phase-8d-http-contract-secret';

function buildRouteTestApp(mountPath, router) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(mountPath, router);
  app.use((err, _req, res, _next) => {
    const message = err?.message || 'Request failed';
    const status = err?.status || err?.statusCode || (/^Tipo no permitido:/i.test(message) ? 400 : 500);
    res.status(status).json({
      error: message,
      code: err?.code || (status === 400 ? 'validation_failed' : 'request_failed'),
    });
  });
  return app;
}

function installAuthSessionMock(userOverrides = {}) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || TEST_JWT_SECRET;
  const user = {
    id: 'http-user-1',
    email: 'http-user@example.com',
    name: 'HTTP Test User',
    isAdmin: false,
    isSuperAdmin: false,
    plan: 'ENTERPRISE',
    ...userOverrides,
  };
  const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const originalFindUnique = prisma.session.findUnique;
  prisma.session.findUnique = async ({ where } = {}) => {
    if (where?.token === token) return {
      id: 'http-session-1',
      token,
      userId: user.id,
      user,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
    if (typeof originalFindUnique === 'function') {
      return originalFindUnique.call(prisma.session, { where });
    }
    return null;
  };
  return {
    user,
    token,
    authHeader: `Bearer ${token}`,
    restore() {
      prisma.session.findUnique = originalFindUnique;
    },
  };
}

function mockResolvedModule(resolvedPath, exports) {
  const original = require.cache[resolvedPath];
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
  return () => {
    if (original) {
      require.cache[resolvedPath] = original;
    } else {
      delete require.cache[resolvedPath];
    }
  };
}

function reloadModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

function createContractValidator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const registry = buildJsonSchemaRegistry();
  return function assertContractResponse(routeId, status, body) {
    const route = registry.routes[routeId];
    assert.ok(route, `missing route contract ${routeId}`);
    const schema = route.schemas.responses[String(status)];
    assert.ok(schema, `missing ${status} response contract for ${routeId}`);
    const validate = ajv.compile(schema);
    if (!validate(body)) {
      assert.fail(`${routeId} ${status} response failed contract validation: ${ajv.errorsText(validate.errors)}`);
    }
  };
}

module.exports = {
  buildRouteTestApp,
  createContractValidator,
  installAuthSessionMock,
  mockResolvedModule,
  reloadModule,
};
