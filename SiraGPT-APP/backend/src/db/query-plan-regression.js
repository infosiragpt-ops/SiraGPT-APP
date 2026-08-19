'use strict';

// ──────────────────────────────────────────────────────────────
// siraGPT — Query Plan Regression Analyzer
// ──────────────────────────────────────────────────────────────
// Snapshots Postgres EXPLAIN (FORMAT JSON) plans into a stable
// fingerprint and compares them against an expected baseline so
// CI fails when the planner regresses (new Seq Scan on a hot
// table, an expected index is no longer used, etc).
//
//   const { summarizePlan, fingerprint, detectRegressions } =
//     require('./query-plan-regression');
//
//   const { plan } = await explain(prisma, sql, params);
//   const issues = detectRegressions(plan, {
//     fingerprint: 'IndexScan|User.User_email_key',
//     noSeqScan:   ['User'],
//     requireIndexes: ['User_email_key'],
//   });
//   if (issues.length) throw new Error(issues.join('; '));
//
// The analyzer is fully deterministic — it strips costs/rows/
// timing and only keeps the structural shape (node types, scanned
// relations, and indexes), so two runs against the same data must
// produce the same fingerprint.
// ──────────────────────────────────────────────────────────────

const SCAN_NODES = new Set([
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'Tid Scan',
  'CTE Scan',
  'Subquery Scan',
  'Function Scan',
  'Foreign Scan',
]);

class PlanRegressionError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = 'PlanRegressionError';
    this.code = 'PLAN_REGRESSION';
    this.issues = Array.isArray(issues) ? issues : [];
  }
}

function unwrapPlan(plan) {
  // Postgres `EXPLAIN (FORMAT JSON)` returns an array with one
  // object per statement. Each object has a top-level `Plan` key.
  // Be tolerant: the caller may pass either the array, the
  // object, or the inner `Plan` node directly.
  if (plan == null) return null;
  if (Array.isArray(plan)) {
    if (plan.length === 0) return null;
    return unwrapPlan(plan[0]);
  }
  if (typeof plan !== 'object') return null;
  if (plan.Plan && typeof plan.Plan === 'object') return plan.Plan;
  return plan;
}

function summarizePlan(plan) {
  const node = unwrapPlan(plan);
  if (!node) return null;
  const out = {
    nodeType: typeof node['Node Type'] === 'string' ? node['Node Type'] : 'Unknown',
  };
  if (typeof node['Relation Name'] === 'string') out.relation = node['Relation Name'];
  if (typeof node['Index Name'] === 'string') out.index = node['Index Name'];
  if (typeof node['Join Type'] === 'string') out.joinType = node['Join Type'];
  if (typeof node['Strategy'] === 'string') out.strategy = node['Strategy'];
  if (typeof node['Scan Direction'] === 'string') out.scanDirection = node['Scan Direction'];
  const children = Array.isArray(node.Plans) ? node.Plans : [];
  if (children.length > 0) {
    out.children = children
      .map((child) => summarizePlan(child))
      .filter((c) => c != null);
  }
  return out;
}

function walk(summary, visit) {
  if (!summary) return;
  visit(summary);
  if (Array.isArray(summary.children)) {
    for (const child of summary.children) walk(child, visit);
  }
}

function collectNodeTypes(summary) {
  const out = [];
  walk(summary, (n) => out.push(n.nodeType));
  return out;
}

function collectIndexes(summary) {
  const out = new Set();
  walk(summary, (n) => { if (n.index) out.add(n.index); });
  return Array.from(out).sort();
}

function collectRelations(summary) {
  const out = new Set();
  walk(summary, (n) => { if (n.relation) out.add(n.relation); });
  return Array.from(out).sort();
}

function collectScansOnRelation(summary, relation) {
  const out = [];
  walk(summary, (n) => {
    if (n.relation === relation && SCAN_NODES.has(n.nodeType)) {
      out.push(n.nodeType);
    }
  });
  return out;
}

function fingerprintFromSummary(summary) {
  if (!summary) return '';
  const parts = [];
  walk(summary, (n) => {
    let token = n.nodeType.replace(/\s+/g, '');
    if (n.relation) token += `:${n.relation}`;
    if (n.index) token += `@${n.index}`;
    parts.push(token);
  });
  return parts.join('|');
}

function fingerprint(plan) {
  return fingerprintFromSummary(summarizePlan(plan));
}

function detectRegressions(plan, expected = {}) {
  const issues = [];
  const summary = summarizePlan(plan);
  if (!summary) {
    issues.push('plan is empty or unparseable');
    return issues;
  }

  if (typeof expected.fingerprint === 'string' && expected.fingerprint.length > 0) {
    const actual = fingerprintFromSummary(summary);
    if (actual !== expected.fingerprint) {
      issues.push(`fingerprint mismatch: expected ${expected.fingerprint} got ${actual}`);
    }
  }

  if (typeof expected.topNodeType === 'string' && summary.nodeType !== expected.topNodeType) {
    issues.push(`top node type mismatch: expected ${expected.topNodeType} got ${summary.nodeType}`);
  }

  if (Array.isArray(expected.noSeqScan)) {
    for (const rel of expected.noSeqScan) {
      const scans = collectScansOnRelation(summary, rel);
      if (scans.includes('Seq Scan')) {
        issues.push(`unexpected Seq Scan on ${rel}`);
      }
    }
  }

  if (Array.isArray(expected.requireIndexes)) {
    const used = new Set(collectIndexes(summary));
    for (const idx of expected.requireIndexes) {
      if (!used.has(idx)) issues.push(`expected index ${idx} not used`);
    }
  }

  if (Array.isArray(expected.forbidIndexes)) {
    const used = new Set(collectIndexes(summary));
    for (const idx of expected.forbidIndexes) {
      if (used.has(idx)) issues.push(`forbidden index ${idx} was used`);
    }
  }

  if (Array.isArray(expected.allowedNodeTypes)) {
    const allowed = new Set(expected.allowedNodeTypes);
    const seen = collectNodeTypes(summary);
    for (const nt of seen) {
      if (!allowed.has(nt)) issues.push(`disallowed node type ${nt}`);
    }
  }

  if (typeof expected.maxNodes === 'number') {
    const count = collectNodeTypes(summary).length;
    if (count > expected.maxNodes) {
      issues.push(`plan has ${count} nodes, exceeds maxNodes=${expected.maxNodes}`);
    }
  }

  return issues;
}

function assertPlanMatches(plan, expected) {
  const issues = detectRegressions(plan, expected || {});
  if (issues.length > 0) {
    throw new PlanRegressionError(
      `query plan regression detected: ${issues.join('; ')}`,
      issues,
    );
  }
}

module.exports = {
  summarizePlan,
  fingerprint,
  detectRegressions,
  assertPlanMatches,
  collectNodeTypes,
  collectIndexes,
  collectRelations,
  collectScansOnRelation,
  unwrapPlan,
  PlanRegressionError,
  SCAN_NODES,
};
