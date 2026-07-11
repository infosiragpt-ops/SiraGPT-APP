'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadOptional(specifier) {
  try {
    return require(specifier);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const policyModule = loadOptional('../src/services/admin-route-policy');
const catalog = loadOptional('../src/services/rbac-catalog');
const ADMIN_SOURCE_PATH = path.resolve(__dirname, '../src/routes/admin.js');
const INDEX_SOURCE_PATH = path.resolve(__dirname, '../index.js');

const EXPECTED_ADMIN_MOUNTS = Object.freeze([
  { id: 'queues', mountPath: '/api/admin/queues', binding: 'adminQueuesRoutes', source: 'src/routes/admin-queues.js', routerName: 'router', usePrefixes: ['/board'] },
  { id: 'connections', mountPath: '/api/admin/connections', binding: 'adminConnectionsRoutes', source: 'src/routes/admin-connections.js', routerName: 'router' },
  { id: 'user-context', mountPath: '/api/admin/user-context', binding: 'adminUserContextRoutes.router', source: 'src/routes/admin-user-context.js', routerName: 'router' },
  { id: 'plans', mountPath: '/api/admin/plans', binding: 'plansRoutes.adminRouter', source: 'src/routes/plans.js', routerName: 'adminRouter' },
  { id: 'credits', mountPath: '/api/admin/credits', binding: 'creditsRoutes.adminRouter', source: 'src/routes/credits.js', routerName: 'adminRouter' },
  { id: 'goals', mountPath: '/api/admin/goals', binding: 'goalsRoutes.adminRouter', source: 'src/routes/goals.js', routerName: 'adminRouter' },
  { id: 'rbac', mountPath: '/api/admin/rbac', binding: 'rbacRoutes.adminRouter', source: 'src/routes/rbac.js', routerName: 'adminRouter' },
  { id: 'security', mountPath: '/api/admin/security', binding: 'adminSecurityRoutes', source: 'src/routes/admin/security.js', routerName: 'router' },
  { id: 'settings', mountPath: '/api/admin/settings', binding: 'adminSettingsRoutes', source: 'src/routes/admin/settings.js', routerName: 'router' },
  { id: 'reports', mountPath: '/api/admin/reports', binding: 'adminReportsRoutes', source: 'src/routes/admin/reports.js', routerName: 'router' },
  { id: 'root', mountPath: '/api/admin', binding: 'adminRoutes', source: 'src/routes/admin.js', routerName: 'router' },
]);

function requireFeature(value, label) {
  assert.ok(value, `${label} has not been implemented`);
  return value;
}

function joinMountedPath(mountPath, routePath) {
  if (routePath === '/') return mountPath;
  return `${mountPath}${routePath}`.replace(/\/+$/, '');
}

function registeredAdminRoutes({ source, routerName, mountPath, usePrefixes = [] }) {
  const routes = new Set();
  const routePattern = new RegExp(
    `${routerName}\\.(get|post|put|patch|delete|head)\\(\\s*['"]([^'"]+)['"]`,
    'g',
  );
  let match;
  while ((match = routePattern.exec(source)) !== null) {
    routes.add(`${match[1].toUpperCase()} ${joinMountedPath(mountPath, match[2])}`);
  }
  for (const prefix of usePrefixes) {
    routes.add(`ALL ${joinMountedPath(mountPath, prefix)}/*`);
  }
  return routes;
}

function mountedRouteInventory() {
  const routes = new Set();
  for (const mount of EXPECTED_ADMIN_MOUNTS) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', mount.source), 'utf8');
    for (const route of registeredAdminRoutes({ ...mount, source })) routes.add(route);
  }
  return routes;
}

function concretePath(routePattern) {
  return routePattern
    .replace(/:([A-Za-z0-9_]+)/g, 'sample-$1')
    .replace(/\*$/, 'sample');
}

function invoke(middleware, req) {
  let statusCode = 200;
  let body;
  let nextCalls = 0;
  return new Promise((resolve, reject) => {
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        body = payload;
        resolve({ statusCode, body, nextCalls });
        return this;
      },
    };
    const next = (error) => {
      if (error) return reject(error);
      nextCalls += 1;
      resolve({ statusCode, body, nextCalls });
    };
    Promise.resolve(middleware(req, res, next)).catch(reject);
  });
}

test('mount-aware inventory includes every separately mounted admin router from index.js', () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  const indexSource = fs.readFileSync(INDEX_SOURCE_PATH, 'utf8');
  assert.deepEqual(feature.ADMIN_ROUTER_MOUNTS, EXPECTED_ADMIN_MOUNTS);
  for (const mount of EXPECTED_ADMIN_MOUNTS) {
    const escapedPath = mount.mountPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedBinding = mount.binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      indexSource,
      new RegExp(`app\\.use\\(\\s*['"]${escapedPath}['"]\\s*,\\s*${escapedBinding}\\s*\\)`),
      `${mount.mountPath} must stay mounted to ${mount.binding}`,
    );
  }
});

test('every mounted admin method+route pattern has exactly one declarative policy', () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  const sourceRoutes = mountedRouteInventory();
  const mappedRoutes = new Set(Object.keys(feature.ADMIN_ROUTE_POLICIES));
  assert.deepEqual(mappedRoutes, sourceRoutes);
});

test('every admin policy references a canonical permission', () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  const source = requireFeature(catalog, 'RBAC catalog');
  const permissionCodes = new Set(source.PERMISSIONS.map((permission) => permission.code));
  for (const [routeKey, policy] of Object.entries(feature.ADMIN_ROUTE_POLICIES)) {
    assert.ok(permissionCodes.has(policy.permission), `${routeKey} uses unknown ${policy.permission}`);
  }
});

test('route matcher handles static-over-parameter precedence', () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  assert.equal(
    feature.matchAdminRoutePolicy('GET', '/api/admin/users/search').routeKey,
    'GET /api/admin/users/search',
  );
  assert.equal(
    feature.matchAdminRoutePolicy('GET', '/api/admin/users/user-123').routeKey,
    'GET /api/admin/users/:id',
  );
});

test('route normalization accepts both /admin and /api/admin harness mounts', () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  for (const pathname of ['/admin/users', '/api/admin/users']) {
    const matched = feature.matchAdminRoutePolicy('GET', pathname);
    assert.equal(matched?.routeKey, 'GET /api/admin/users', pathname);
    assert.equal(matched?.permission, 'admin.users.read', pathname);
  }
});

test('HEAD requests inherit the matching GET admin policy', () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  const matched = feature.matchAdminRoutePolicy('HEAD', '/api/admin/security');
  assert.equal(matched.routeKey, 'GET /api/admin/security');
  assert.equal(matched.permission, 'admin.system.read');
});

test('mounted wildcard policy covers both its root and descendants', () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  for (const pathname of [
    '/api/admin/queues/board',
    '/api/admin/queues/board/',
    '/api/admin/queues/board/queues/agent-tasks',
  ]) {
    const matched = feature.matchAdminRoutePolicy('GET', pathname);
    assert.equal(matched?.routeKey, 'ALL /api/admin/queues/board/*', pathname);
    assert.equal(matched?.permission, 'admin.queues.manage', pathname);
  }
});

test('every mounted admin policy executes through global permission boundaries', async () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  for (const [routeKey, expectedPolicy] of Object.entries(feature.ADMIN_ROUTE_POLICIES)) {
    const separator = routeKey.indexOf(' ');
    const method = routeKey.slice(0, separator);
    const pathname = concretePath(routeKey.slice(separator + 1));
    const calls = [];
    const middleware = feature.createAdminRoutePermissionMiddleware({
      requirePermissionImpl(permission, options) {
        calls.push({ permission, options });
        return (_req, _res, next) => next();
      },
      writeAuditLog: async () => {},
      prisma: {},
    });
    const req = {
      method: method === 'ALL' ? 'GET' : method,
      path: pathname,
      originalUrl: pathname,
      user: { id: 'admin-1', isAdmin: true },
    };
    const result = await invoke(middleware, req);
    assert.equal(result.nextCalls, 1, `${routeKey} did not pass its policy middleware`);
    assert.equal(calls[0].permission, expectedPolicy.permission);
    assert.equal(calls[0].options.globalOnly, true);
    assert.equal(calls[0].options.allowOrgApiKey, false);
    assert.equal(req._adminRoutePolicy.routeKey, routeKey);
  }
});

test('unmapped admin routes fail closed without invoking permission lookup', async () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  let permissionCalls = 0;
  const middleware = feature.createAdminRoutePermissionMiddleware({
    requirePermissionImpl() {
      permissionCalls += 1;
      return (_req, _res, next) => next();
    },
    writeAuditLog: async () => {},
    prisma: {},
  });
  const result = await invoke(middleware, {
    method: 'GET',
    path: '/api/admin/not-in-the-policy-map',
    originalUrl: '/api/admin/not-in-the-policy-map',
    user: { id: 'admin-1', isAdmin: true },
  });

  assert.equal(result.statusCode, 403);
  assert.equal(result.body.code, 'admin_route_policy_unmapped');
  assert.equal(permissionCalls, 0);
});

test('mapped admin routes delegate global-only permission enforcement with legacy shadow compatibility', async () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  const calls = [];
  const middleware = feature.createAdminRoutePermissionMiddleware({
    requirePermissionImpl(permission, options) {
      calls.push({ permission, options });
      return (_req, _res, next) => next();
    },
    writeAuditLog: async () => {},
    prisma: {},
  });
  const req = {
    method: 'GET',
    baseUrl: '/api/admin',
    path: '/users',
    originalUrl: '/api/admin/users',
    user: { id: 'admin-1', isAdmin: true },
  };
  const result = await invoke(middleware, req);

  assert.equal(result.nextCalls, 1);
  assert.equal(calls[0].permission, 'admin.users.read');
  assert.equal(calls[0].options.globalOnly, true);
  assert.equal(calls[0].options.allowOrgApiKey, false);
  assert.equal(calls[0].options.legacyPredicate(req.user, req), true);
});

test('/admin-mounted harness requests resolve the same declarative policy', async () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  const calls = [];
  const middleware = feature.createAdminRoutePermissionMiddleware({
    requirePermissionImpl(permission, options) {
      calls.push({ permission, options });
      return (_req, _res, next) => next();
    },
    writeAuditLog: async () => {},
    prisma: {},
  });
  const req = {
    method: 'GET',
    baseUrl: '/admin',
    path: '/users',
    originalUrl: '/admin/users',
    user: { id: 'legacy-admin', isAdmin: true },
  };

  const result = await invoke(middleware, req);

  assert.equal(result.nextCalls, 1);
  assert.equal(calls[0].permission, 'admin.users.read');
  assert.equal(calls[0].options.legacyPredicate(req.user, req), true);
});

test('legacy-admin user CRUD remains a non-superadmin declarative surface', () => {
  const feature = requireFeature(policyModule, 'admin route policy');
  for (const routeKey of [
    'POST /api/admin/users',
    'PUT /api/admin/users/:id',
    'DELETE /api/admin/users/:id',
  ]) {
    assert.equal(feature.ADMIN_ROUTE_POLICIES[routeKey]?.superAdmin, false, routeKey);
  }

  const source = fs.readFileSync(ADMIN_SOURCE_PATH, 'utf8');
  assert.doesNotMatch(
    source,
    /router\.put\(\s*['"]\/users\/:id['"]\s*,\s*requireSuperAdmin/,
  );
  assert.doesNotMatch(
    source,
    /router\.delete\(\s*['"]\/users\/:id['"]\s*,\s*requireSuperAdmin/,
  );
  assert.doesNotMatch(
    source,
    /router\.post\(\s*['"]\/users['"]\s*,\s*requireSuperAdmin/,
  );
});

test('all separately mounted admin routers replace boolean gates with route policy middleware', () => {
  for (const mount of EXPECTED_ADMIN_MOUNTS) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', mount.source), 'utf8');
    assert.doesNotMatch(
      source,
      new RegExp(`${mount.routerName}\\.use\\(\\s*authenticateToken\\s*,\\s*requireAdmin\\s*\\)`),
      `${mount.source} still has a router-level boolean admin gate`,
    );
    assert.match(
      source,
      /requireAdminRoutePermission/,
      `${mount.source} must use the declarative admin route policy`,
    );
  }
});

test('admin.js retains explicit super-admin gates on sensitive routes', () => {
  const source = fs.readFileSync(ADMIN_SOURCE_PATH, 'utf8');
  assert.doesNotMatch(source, /router\.use\(\s*authenticateToken\s*,\s*requireAdmin\s*\)/);
  const authIndex = source.indexOf('router.use(authenticateToken);');
  const principalGuardIndex = source.indexOf("router.use('/users/:id'");
  const policyIndex = source.indexOf('router.use(requireAdminRoutePermission);');
  assert.ok(authIndex >= 0);
  assert.ok(principalGuardIndex > authIndex);
  assert.ok(policyIndex > principalGuardIndex);

  for (const [method, route] of [
    ['post', '/maintenance/clear-cache'],
    ['post', '/users/:id/reset-password'],
    ['post', '/users/:id/grant-credits'],
    ['delete', '/queues/:name/job/:id'],
    ['post', '/api-keys/purge'],
    ['post', '/maintenance/rotate-secret'],
  ]) {
    const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      source,
      new RegExp(`router\\.${method}\\(\\s*['"]${escapedRoute}['"][\\s\\S]{0,180}?requireSuperAdmin`),
      `${method.toUpperCase()} ${route} must retain requireSuperAdmin`,
    );
  }
});
