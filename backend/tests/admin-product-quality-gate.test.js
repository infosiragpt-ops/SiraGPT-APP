'use strict';

/**
 * Item 6 (prod 2026-09-28): `GET /api/admin/stats/product-quality → 403` for
 * an admin session. The route is super-admin only by policy (aggregated
 * product-quality cohorts), so the admin analytics page must not request it
 * for plain admins: it gates the call on `user.isSuperAdmin` and keeps its
 * «no disponible para esta cuenta administrativa» state.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('route stays super-admin only and the policy table agrees', () => {
  const routes = read('backend/src/routes/admin.js');
  assert.match(routes, /router\.get\('\/stats\/product-quality', requireSuperAdmin, STATS_CACHE/);
  const { ADMIN_ROUTE_POLICIES } = require('../src/services/admin-route-policy');
  assert.equal(ADMIN_ROUTE_POLICIES['GET /api/admin/stats/product-quality'].superAdmin, true);
  assert.equal(ADMIN_ROUTE_POLICIES['GET /api/admin/stats/product-quality'].permission, 'admin.metrics.read');
});

test('admin analytics page only calls product-quality for super-admins', () => {
  const page = read('app/admin/analytics/page.tsx');
  assert.match(page, /import \{ useAuth \} from "@\/lib\/auth-context-integrated"/);
  assert.match(page, /const canReadProductQuality = Boolean\(user\?\.isSuperAdmin\)/);
  assert.match(page, /canReadProductQuality \? apiClient\.getAdminProductQualityStats\(range\) : Promise\.resolve\(null\)/);
  assert.equal((page.match(/apiClient\.getAdminProductQualityStats\(/g) || []).length, 1, 'single, gated call site');
  // The effect re-runs when the session hydrates as super-admin.
  assert.match(page, /\}, \[timeRange, canReadProductQuality\]\)/);
  // Existing empty state for non-super-admins is kept (no UI change).
  assert.match(page, /La analítica de calidad no está disponible para esta cuenta administrativa\./);
});
