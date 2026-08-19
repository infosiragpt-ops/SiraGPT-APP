'use strict';

/**
 * cost-report-aggregator — roll per-user AI cost report rows up to the
 * organization level via OrgMembership.
 *
 * Used by GET /api/admin/cost-report?groupBy=org (cycle 45). Extracted
 * into its own module so the aggregation logic is unit-testable without
 * spinning up Express.
 *
 * Each user with N memberships contributes their cost to N org buckets
 * (the standard SaaS billing semantic: each org sees the spend of its
 * own members). Users with no memberships fall into the synthetic
 * `__unaffiliated__` bucket so 100% of the cost is still accounted for.
 */

const UNAFFILIATED_KEY = '__unaffiliated__';

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * @param {Array<{userId,costUSD,inputTokens,outputTokens,requests}>} perUser
 * @param {Array<{userId,orgId,organization?:{id,name,slug}}>} memberships
 * @returns {Array<{orgId,name,slug,costUSD,inputTokens,outputTokens,requests,users}>}
 */
function aggregatePerOrg(perUser, memberships) {
  if (!Array.isArray(perUser)) return [];
  const byUser = new Map();
  for (const m of memberships || []) {
    if (!byUser.has(m.userId)) byUser.set(m.userId, []);
    byUser.get(m.userId).push(m);
  }
  const orgs = new Map();
  const ensureBucket = (id, name, slug) => {
    let b = orgs.get(id);
    if (!b) {
      b = {
        orgId: id,
        name: name || null,
        slug: slug || null,
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        users: 0,
      };
      orgs.set(id, b);
    }
    return b;
  };
  for (const u of perUser) {
    const ms = byUser.get(u.userId);
    if (!ms || ms.length === 0) {
      const b = ensureBucket(UNAFFILIATED_KEY, 'Unaffiliated', null);
      b.costUSD = round6(b.costUSD + u.costUSD);
      b.inputTokens += u.inputTokens;
      b.outputTokens += u.outputTokens;
      b.requests += u.requests;
      b.users += 1;
      continue;
    }
    for (const m of ms) {
      const b = ensureBucket(m.orgId, m.organization?.name, m.organization?.slug);
      b.costUSD = round6(b.costUSD + u.costUSD);
      b.inputTokens += u.inputTokens;
      b.outputTokens += u.outputTokens;
      b.requests += u.requests;
      b.users += 1;
    }
  }
  return [...orgs.values()].sort((a, b) => b.costUSD - a.costUSD);
}

module.exports = { aggregatePerOrg, UNAFFILIATED_KEY };
