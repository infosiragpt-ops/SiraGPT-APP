'use strict';

const requirePermission = require('../middleware/require-permission');
const prisma = require('../config/database');
const { writeAuditLog } = require('../utils/audit-log');

function policy(permission, superAdmin = false) {
  return Object.freeze({ permission, superAdmin });
}

const ADMIN_ROUTER_MOUNTS = Object.freeze([
  Object.freeze({
    id: 'queues',
    mountPath: '/api/admin/queues',
    binding: 'adminQueuesRoutes',
    source: 'src/routes/admin-queues.js',
    routerName: 'router',
    usePrefixes: Object.freeze(['/board']),
  }),
  Object.freeze({
    id: 'connections',
    mountPath: '/api/admin/connections',
    binding: 'adminConnectionsRoutes',
    source: 'src/routes/admin-connections.js',
    routerName: 'router',
  }),
  Object.freeze({
    id: 'user-context',
    mountPath: '/api/admin/user-context',
    binding: 'adminUserContextRoutes.router',
    source: 'src/routes/admin-user-context.js',
    routerName: 'router',
  }),
  Object.freeze({
    id: 'plans',
    mountPath: '/api/admin/plans',
    binding: 'plansRoutes.adminRouter',
    source: 'src/routes/plans.js',
    routerName: 'adminRouter',
  }),
  Object.freeze({
    id: 'credits',
    mountPath: '/api/admin/credits',
    binding: 'creditsRoutes.adminRouter',
    source: 'src/routes/credits.js',
    routerName: 'adminRouter',
  }),
  Object.freeze({
    id: 'goals',
    mountPath: '/api/admin/goals',
    binding: 'goalsRoutes.adminRouter',
    source: 'src/routes/goals.js',
    routerName: 'adminRouter',
  }),
  Object.freeze({
    id: 'rbac',
    mountPath: '/api/admin/rbac',
    binding: 'rbacRoutes.adminRouter',
    source: 'src/routes/rbac.js',
    routerName: 'adminRouter',
  }),
  Object.freeze({
    id: 'security',
    mountPath: '/api/admin/security',
    binding: 'adminSecurityRoutes',
    source: 'src/routes/admin/security.js',
    routerName: 'router',
  }),
  Object.freeze({
    id: 'settings',
    mountPath: '/api/admin/settings',
    binding: 'adminSettingsRoutes',
    source: 'src/routes/admin/settings.js',
    routerName: 'router',
  }),
  Object.freeze({
    id: 'reports',
    mountPath: '/api/admin/reports',
    binding: 'adminReportsRoutes',
    source: 'src/routes/admin/reports.js',
    routerName: 'router',
  }),
  Object.freeze({
    id: 'root',
    mountPath: '/api/admin',
    binding: 'adminRoutes',
    source: 'src/routes/admin.js',
    routerName: 'router',
  }),
]);

const ADMIN_ROUTE_POLICIES = Object.freeze({
  'GET /api/admin/queues/status': policy('admin.queues.read'),
  'GET /api/admin/queues/health': policy('admin.queues.read', true),
  'ALL /api/admin/queues/board/*': policy('admin.queues.manage', true),

  'GET /api/admin/connections': policy('admin.connections.manage'),
  'POST /api/admin/connections': policy('admin.connections.manage'),
  'PATCH /api/admin/connections/:id': policy('admin.connections.manage'),
  'DELETE /api/admin/connections/:id': policy('admin.connections.manage'),
  'POST /api/admin/connections/health-check': policy('admin.connections.manage'),
  'POST /api/admin/connections/:id/test': policy('admin.connections.manage'),

  'GET /api/admin/user-context/:userId/audit': policy('admin.users.read'),

  'POST /api/admin/plans': policy('plans.manage', true),
  'PATCH /api/admin/plans/:id': policy('plans.manage', true),

  'POST /api/admin/credits/grant': policy('credits.adjust', true),
  'POST /api/admin/credits/refund': policy('credits.refund', true),
  'GET /api/admin/credits/users/:userId': policy('credits.read', true),

  'GET /api/admin/goals/health': policy('admin.system.read'),

  'GET /api/admin/rbac/roles': policy('rbac.manage', true),
  'GET /api/admin/rbac/users/:userId/roles': policy('rbac.manage', true),
  'POST /api/admin/rbac/users/:userId/roles': policy('rbac.manage', true),
  'DELETE /api/admin/rbac/users/:userId/roles/:assignmentId': policy('rbac.manage', true),

  'GET /api/admin/security': policy('admin.system.read'),
  'PUT /api/admin/security/settings': policy('admin.maintenance.manage'),

  'GET /api/admin/settings': policy('admin.system.read'),
  'PUT /api/admin/settings': policy('admin.maintenance.manage'),

  'GET /api/admin/reports': policy('admin.metrics.read'),
  'GET /api/admin/reports/:type': policy('admin.metrics.read'),

  'GET /api/admin/providers': policy('admin.models.read'),
  'GET /api/admin/models': policy('admin.models.read'),
  'POST /api/admin/models': policy('admin.models.manage'),
  'PUT /api/admin/models/:id': policy('admin.models.manage'),
  'DELETE /api/admin/models/:id': policy('admin.models.manage'),
  'GET /api/admin/models/fetch': policy('admin.models.read'),
  'GET /api/admin/models/catalog': policy('admin.models.read'),
  'POST /api/admin/models/sync': policy('admin.models.manage'),
  'GET /api/admin/models/stats': policy('admin.metrics.read'),
  'POST /api/admin/models/clear-cache': policy('admin.models.manage'),
  'PUT /api/admin/models/bulk': policy('admin.models.manage'),
  'GET /api/admin/models/sync/status': policy('admin.models.read'),
  'POST /api/admin/models/sync/scheduler': policy('admin.models.manage'),
  'POST /api/admin/models/sync/run': policy('admin.models.manage'),
  'GET /api/admin/users': policy('admin.users.read'),
  'GET /api/admin/analytics': policy('admin.metrics.read'),
  'GET /api/admin/payments': policy('admin.billing.read'),
  'PUT /api/admin/users/:id': policy('users.update'),
  'DELETE /api/admin/users/:id': policy('users.delete'),
  'POST /api/admin/users': policy('users.create'),
  'GET /api/admin/stats': policy('admin.metrics.read'),
  'GET /api/admin/analyzer/health': policy('admin.metrics.read'),
  'POST /api/admin/maintenance/clear-cache': policy('admin.maintenance.manage', true),
  'GET /api/admin/maintenance/mode': policy('admin.system.read', true),
  'POST /api/admin/maintenance/mode': policy('admin.maintenance.manage', true),
  'POST /api/admin/analyzer/cache/clear': policy('admin.maintenance.manage'),
  'GET /api/admin/cost-report': policy('admin.billing.read', true),
  'GET /api/admin/cost-forecast': policy('admin.billing.read', true),
  'GET /api/admin/stats/ai-models': policy('admin.metrics.read', true),
  'GET /api/admin/system-summary': policy('admin.system.read', true),
  'GET /api/admin/system-snapshot': policy('admin.system.read', true),
  'GET /api/admin/health/services': policy('admin.system.read'),
  'GET /api/admin/backups': policy('admin.system.read'),
  'GET /api/admin/orgs/idle': policy('admin.users.read', true),
  'GET /api/admin/users/idle': policy('admin.users.read', true),
  'GET /api/admin/stats/users': policy('admin.metrics.read'),
  'GET /api/admin/stats/usage': policy('admin.metrics.read'),
  'GET /api/admin/stats/files': policy('admin.metrics.read', true),
  'GET /api/admin/stats/agents': policy('admin.metrics.read', true),
  'GET /api/admin/queues': policy('admin.queues.read', true),
  'POST /api/admin/queues/:name/retry-failed': policy('admin.queues.manage', true),
  'DELETE /api/admin/queues/:name/job/:id': policy('admin.queues.manage', true),
  'GET /api/admin/users/search': policy('admin.users.read', true),
  'GET /api/admin/users/:id': policy('admin.users.read', true),
  'POST /api/admin/users/:id/reset-password': policy('users.password.reset', true),
  'POST /api/admin/users/:id/grant-credits': policy('credits.adjust', true),
  'GET /api/admin/webhooks/deliveries': policy('admin.webhooks.read', true),
  'POST /api/admin/webhooks/deliveries/:id/retry': policy('webhooks.manage', true),
  'GET /api/admin/webhooks/health': policy('admin.webhooks.read', true),
  'GET /api/admin/webhooks/dlq': policy('admin.webhooks.read', true),
  'POST /api/admin/webhooks/dlq/:id/retry': policy('webhooks.manage', true),
  'POST /api/admin/webhooks/retry-failed': policy('webhooks.manage', true),
  'GET /api/admin/audit-logs': policy('audit.read'),
  'GET /api/admin/audit-logs/search': policy('audit.read'),
  'GET /api/admin/audit-logs.csv': policy('audit.export'),
  'POST /api/admin/api-keys/purge': policy('admin.api_keys.manage', true),
  'GET /api/admin/api-keys/tombstoned': policy('admin.api_keys.read', true),
  'GET /api/admin/system-cron/jobs': policy('admin.system.read', true),
  'GET /api/admin/iag-metrics': policy('admin.metrics.read', true),
  'GET /api/admin/stripe/invoices': policy('admin.billing.read'),
  'GET /api/admin/stripe/invoice/:invoiceId': policy('admin.billing.read'),
  'GET /api/admin/users/export/csv': policy('admin.users.export'),
  'POST /api/admin/maintenance/rotate-secret': policy('admin.maintenance.manage', true),
});

function normalizePath(pathname) {
  const raw = String(pathname || '/').split('?')[0];
  const withoutTrailingSlash = raw.length > 1 && raw.endsWith('/')
    ? raw.slice(0, -1)
    : (raw || '/');
  if (withoutTrailingSlash === '/admin' || withoutTrailingSlash.startsWith('/admin/')) {
    return `/api${withoutTrailingSlash}`;
  }
  return withoutTrailingSlash;
}

function compileRoute(routeKey, routePolicy) {
  const separator = routeKey.indexOf(' ');
  const method = routeKey.slice(0, separator);
  const routePattern = routeKey.slice(separator + 1);
  const segments = routePattern.split('/').filter(Boolean);
  const trailingWildcard = segments[segments.length - 1] === '*';
  const matchSegments = trailingWildcard ? segments.slice(0, -1) : segments;
  const expression = matchSegments.map((segment) => {
    if (segment.startsWith(':')) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const wildcardSuffix = trailingWildcard ? '(?:/.*)?' : '';
  const staticSegments = segments.filter((segment) => !segment.startsWith(':')).length;
  return Object.freeze({
    routeKey,
    method,
    routePattern,
    policy: routePolicy,
    specificity: (staticSegments * 100) + routePattern.length,
    regexp: new RegExp(`^/${expression}${wildcardSuffix}/?$`),
  });
}

const COMPILED_POLICIES = Object.freeze(
  Object.entries(ADMIN_ROUTE_POLICIES)
    .map(([routeKey, routePolicy]) => compileRoute(routeKey, routePolicy))
    .sort((a, b) => b.specificity - a.specificity),
);

function matchAdminRoutePolicy(method, pathname) {
  const requestMethod = String(method || '').toUpperCase();
  const normalizedMethod = requestMethod === 'HEAD' ? 'GET' : requestMethod;
  const normalizedPath = normalizePath(pathname);
  const match = COMPILED_POLICIES.find(
    (candidate) =>
      (candidate.method === normalizedMethod || candidate.method === 'ALL')
      && candidate.regexp.test(normalizedPath),
  );
  if (!match) return null;
  return Object.freeze({
    routeKey: match.routeKey,
    routePattern: match.routePattern,
    permission: match.policy.permission,
    superAdmin: match.policy.superAdmin,
  });
}

function requestPath(req) {
  const originalUrl = normalizePath(req?.originalUrl);
  if (originalUrl.startsWith('/api/admin')) return originalUrl;
  const directPath = normalizePath(req?.path);
  if (directPath.startsWith('/api/admin')) return directPath;
  const baseUrl = normalizePath(req?.baseUrl);
  return normalizePath(`${baseUrl === '/' ? '' : baseUrl}${directPath}`);
}

function createAdminRoutePermissionMiddleware({
  requirePermissionImpl = requirePermission,
  writeAuditLog: auditWriter = writeAuditLog,
  prisma: prismaClient = prisma,
} = {}) {
  const middlewareByPermission = new Map();
  return function requireAdminRoutePermission(req, res, next) {
    const matched = matchAdminRoutePolicy(req.method, requestPath(req));
    if (!matched) {
      void Promise.resolve(auditWriter(prismaClient, {
        req,
        action: 'admin_route_policy_denied',
        resource: 'admin_route',
        metadata: {
          method: String(req.method || '').toUpperCase(),
          reason: 'unmapped',
        },
        tags: ['security', 'rbac', 'denied'],
      })).catch(() => {});
      return res.status(403).json({
        error: 'forbidden',
        code: 'admin_route_policy_unmapped',
      });
    }

    let middleware = middlewareByPermission.get(matched.permission);
    if (!middleware) {
      middleware = requirePermissionImpl(matched.permission, {
        globalOnly: true,
        allowOrgApiKey: false,
        legacyPredicate: (user) => Boolean(user?.isAdmin || user?.isSuperAdmin),
      });
      middlewareByPermission.set(matched.permission, middleware);
    }
    req._adminRoutePolicy = matched;
    return middleware(req, res, next);
  };
}

const requireAdminRoutePermission = createAdminRoutePermissionMiddleware();

module.exports = requireAdminRoutePermission;
module.exports.ADMIN_ROUTER_MOUNTS = ADMIN_ROUTER_MOUNTS;
module.exports.ADMIN_ROUTE_POLICIES = ADMIN_ROUTE_POLICIES;
module.exports.matchAdminRoutePolicy = matchAdminRoutePolicy;
module.exports.createAdminRoutePermissionMiddleware = createAdminRoutePermissionMiddleware;
