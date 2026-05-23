'use strict';

/**
 * plan-critic — deterministic critic for execution plans BEFORE they
 * run, so the orchestrator can detect structural defects and ask the
 * planner to repair them without burning a single tool call.
 *
 * Why this exists:
 *  The Cortex orchestrator + planner-agent emit ordered step graphs
 *  (`task-envelope-builder.js#agent_plan / workflow_graph`). A bad plan
 *  costs the user real money (LLM tokens, API quota) and produces lousy
 *  answers. Today validation is implicit (the runtime runs whatever
 *  the planner gives it). This module fills that gap with a fast,
 *  zero-cost STATIC critic that flags:
 *
 *    - missing_initial_step      (no entry node)
 *    - dangling_terminal_step    (no node feeds the answer / output)
 *    - circular_dependency       (cycles in the dependency graph)
 *    - duplicate_step            (two nodes solve the same subgoal)
 *    - orphan_step               (no edges in or out — unreachable)
 *    - missing_tool              (step requires a tool not in the registry)
 *    - missing_validation_gate   (steps that produce artifacts don't have
 *                                 a validator gate downstream)
 *    - missing_clarification     (intent has unknowns but no clarify step)
 *    - excessive_parallelism     (too many fan-out branches; fragility)
 *    - excessive_depth           (chain too long; latency risk)
 *    - missing_acceptance_test   (output node has no success criterion)
 *
 * The critic returns a structured report the planner can act on.
 *
 * Public API:
 *   critiquePlan(plan, opts?) → CritiqueReport
 *   suggestRepairs(report)    → string[] (action sentences)
 *
 * Plan shape (lenient — handles variants):
 *   plan: {
 *     steps: [
 *       { id, goal, type?, tool?, depends_on?, produces?, validates?,
 *         acceptance?, parallel_group? },
 *       ...
 *     ],
 *     intent?: { primary_intent, unknowns? },
 *     output_contract?: { ... },
 *     tool_registry?: string[]
 *   }
 */

// ─── Tunables ──────────────────────────────────────────────────────

const MAX_DEPTH = Number(process.env.SIRAGPT_PLAN_MAX_DEPTH) || 8;
const MAX_PARALLEL_BRANCHES = Number(process.env.SIRAGPT_PLAN_MAX_PARALLEL) || 6;
const MIN_PARALLEL_TO_FLAG = 4;

// ─── Public API ────────────────────────────────────────────────────

function critiquePlan(plan, opts = {}) {
  const safePlan = normalizePlan(plan);
  if (!safePlan) {
    return reportEmpty('plan-shape-invalid', 'plan is null / not an object / no steps array');
  }
  const issues = [];
  const seenIds = new Set();
  for (const step of safePlan.steps) {
    if (!step.id) issues.push(issue('missing_id', 'step has no id', { step }));
    else if (seenIds.has(step.id)) issues.push(issue('duplicate_id', `step id "${step.id}" appears more than once`, { step }));
    else seenIds.add(step.id);
  }

  // Build adjacency: id → depends_on[]
  const byId = new Map();
  for (const step of safePlan.steps) {
    if (step.id) byId.set(step.id, step);
  }

  // ─── Structural defects ─────────────────────────────────────────

  // Missing initial step: no node with empty depends_on
  const entryNodes = safePlan.steps.filter(s => !Array.isArray(s.depends_on) || s.depends_on.length === 0);
  if (entryNodes.length === 0) {
    issues.push(issue('missing_initial_step', 'no step has empty depends_on — plan cannot start', {}));
  }

  // Cycle detection (Kahn's algorithm — topological)
  const cycles = detectCycles(safePlan.steps);
  if (cycles.length > 0) {
    issues.push(issue('circular_dependency', `cycle detected involving: ${cycles[0].join(' → ')}`, { cycle: cycles[0] }));
  }

  // Orphan steps (no edges in or out)
  if (safePlan.steps.length > 1) {
    const referenced = new Set();
    for (const step of safePlan.steps) {
      for (const dep of step.depends_on || []) referenced.add(dep);
    }
    for (const step of safePlan.steps) {
      const hasOutgoing = referenced.has(step.id);
      const hasIncoming = Array.isArray(step.depends_on) && step.depends_on.length > 0;
      if (!hasOutgoing && !hasIncoming && safePlan.steps.length > 2) {
        issues.push(issue('orphan_step', `step "${step.id}" has no edges in or out`, { step }));
      }
    }
  }

  // Dangling terminal step (no step's depends_on includes any "produces" goal)
  const producingSteps = safePlan.steps.filter(s => s.produces);
  if (producingSteps.length > 0 && safePlan.steps.length > 1) {
    const referenced = new Set();
    for (const step of safePlan.steps) {
      for (const dep of step.depends_on || []) referenced.add(dep);
    }
    const terminals = producingSteps.filter(s => !referenced.has(s.id));
    if (terminals.length === 0 && producingSteps.length > 0) {
      // No producing step is unreferenced — that means every producer
      // depends on someone but no one terminates the plan.
      // Acceptable IFF the last step in declaration order is a producer.
      const last = safePlan.steps[safePlan.steps.length - 1];
      if (!last.produces) {
        issues.push(issue('dangling_terminal_step', 'no step terminates the plan with a produces[] declaration', {}));
      }
    }
  }

  // Duplicate goals
  const goalsSeen = new Map();
  for (const step of safePlan.steps) {
    const g = String(step.goal || '').trim().toLowerCase();
    if (!g) continue;
    if (goalsSeen.has(g)) {
      issues.push(issue('duplicate_step', `steps "${goalsSeen.get(g)}" and "${step.id}" share the same goal`, { step }));
    } else {
      goalsSeen.set(g, step.id);
    }
  }

  // Missing tool registrations
  const toolRegistry = new Set((safePlan.tool_registry || opts.tool_registry || []).map(String));
  if (toolRegistry.size > 0) {
    for (const step of safePlan.steps) {
      if (step.tool && !toolRegistry.has(String(step.tool))) {
        issues.push(issue('missing_tool', `step "${step.id}" requires tool "${step.tool}" which is not in the registry`, { step }));
      }
    }
  }

  // Missing validation gate after artifact-producing steps
  for (const step of safePlan.steps) {
    if (!Array.isArray(step.produces) || step.produces.length === 0) continue;
    const hasArtifact = step.produces.some(p => /artifact|file|document|report|deck|spreadsheet|image|video|code/i.test(p));
    if (!hasArtifact) continue;
    const downstreamSteps = safePlan.steps.filter(s => (s.depends_on || []).includes(step.id));
    const hasValidator = downstreamSteps.some(s => s.validates || s.type === 'validate' || s.type === 'review');
    if (!hasValidator) {
      issues.push(issue('missing_validation_gate', `step "${step.id}" produces an artifact but no downstream step validates it`, { step }));
    }
  }

  // Missing clarification when intent has unknowns
  const unknowns = Array.isArray(safePlan.intent?.unknowns) ? safePlan.intent.unknowns : [];
  if (unknowns.length > 0) {
    const hasClarify = safePlan.steps.some(s => s.type === 'clarify' || /clarif|ask\s+user|confirma/i.test(String(s.goal || '')));
    if (!hasClarify) {
      issues.push(issue('missing_clarification', `intent declares ${unknowns.length} unknown(s) but no clarify step is planned`, { unknowns }));
    }
  }

  // Excessive parallelism
  const groupCounts = new Map();
  for (const step of safePlan.steps) {
    const g = step.parallel_group;
    if (!g) continue;
    groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
  }
  for (const [groupId, count] of groupCounts.entries()) {
    if (count >= MIN_PARALLEL_TO_FLAG && count > MAX_PARALLEL_BRANCHES) {
      issues.push(issue('excessive_parallelism', `parallel group "${groupId}" has ${count} branches (cap ${MAX_PARALLEL_BRANCHES})`, { groupId, count }));
    }
  }

  // Excessive depth (longest path in DAG)
  if (cycles.length === 0) {
    const longest = longestPath(safePlan.steps);
    if (longest > MAX_DEPTH) {
      issues.push(issue('excessive_depth', `plan depth ${longest} exceeds cap ${MAX_DEPTH}`, { depth: longest }));
    }
  }

  // Missing acceptance test on terminal/output steps
  const referenced = new Set();
  for (const step of safePlan.steps) {
    for (const dep of step.depends_on || []) referenced.add(dep);
  }
  const terminalSteps = safePlan.steps.filter(s => !referenced.has(s.id));
  for (const term of terminalSteps) {
    if (term.acceptance) continue;
    // Only flag terminals whose goal is producing an output (not validators)
    if (term.type === 'validate' || term.type === 'review') continue;
    issues.push(issue('missing_acceptance_test', `terminal step "${term.id}" has no acceptance criterion`, { step: term }));
  }

  // ─── Severity aggregation ─────────────────────────────────────

  const severity = aggregateSeverity(issues);
  const verdict = decideVerdict(issues, severity);
  return {
    plan_steps: safePlan.steps.length,
    issues,
    severity,
    verdict,
    summary: {
      issue_count: issues.length,
      blocking_count: issues.filter(i => i.severity === 'blocking').length,
      warning_count: issues.filter(i => i.severity === 'warning').length,
      info_count: issues.filter(i => i.severity === 'info').length,
    },
  };
}

function suggestRepairs(report) {
  if (!report || !Array.isArray(report.issues)) return [];
  const tips = [];
  for (const i of report.issues) {
    switch (i.code) {
      case 'missing_initial_step':
        tips.push('Add an entry step with empty depends_on (e.g. a clarify or fetch_context step).');
        break;
      case 'circular_dependency':
        tips.push(`Break the cycle ${(i.context?.cycle || []).join(' → ')} by removing one edge or splitting the step.`);
        break;
      case 'orphan_step':
        tips.push(`Connect step "${i.context?.step?.id}" to the rest of the graph or remove it.`);
        break;
      case 'dangling_terminal_step':
        tips.push('Add a terminal step that produces the user-facing output (artifact / answer).');
        break;
      case 'duplicate_step':
        tips.push(`Merge duplicate-goal steps or differentiate them with sub-goals.`);
        break;
      case 'missing_tool':
        tips.push(`Either register tool "${i.context?.step?.tool}" or pick an alternative from the tool registry.`);
        break;
      case 'missing_validation_gate':
        tips.push(`Add a "validate" step after "${i.context?.step?.id}" before delivery.`);
        break;
      case 'missing_clarification':
        tips.push('Insert a clarify_user step at the front so the unknowns are resolved before execution.');
        break;
      case 'excessive_parallelism':
        tips.push(`Reduce parallel group "${i.context?.groupId}" or batch branches sequentially to limit blast radius.`);
        break;
      case 'excessive_depth':
        tips.push(`Compress the plan or split into a second phase — depth ${i.context?.depth} is too long for one turn.`);
        break;
      case 'missing_acceptance_test':
        tips.push(`Define an acceptance criterion on the terminal step "${i.context?.step?.id}" so the validator knows when to ship.`);
        break;
      case 'duplicate_id':
        tips.push(`Rename duplicate step id "${i.context?.step?.id}" so identifiers stay unique.`);
        break;
      case 'missing_id':
        tips.push('Assign a unique id to every step (e.g. "s1", "s2").');
        break;
      default:
        tips.push(i.message);
    }
  }
  // Deduplicate while preserving order
  const seen = new Set();
  return tips.filter(t => (seen.has(t) ? false : (seen.add(t), true)));
}

// ─── Helpers ───────────────────────────────────────────────────────

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const steps = Array.isArray(plan.steps) ? plan.steps : Array.isArray(plan.nodes) ? plan.nodes : null;
  if (!steps) return null;
  // Coerce step shape: { id, goal, depends_on, produces, … }
  const normalized = steps.map((s, idx) => {
    if (!s || typeof s !== 'object') return { id: `s${idx + 1}`, goal: String(s || '') };
    return {
      id: s.id || s.step_id || s.node_id || `s${idx + 1}`,
      goal: s.goal || s.task || s.description || '',
      type: s.type || s.kind || null,
      tool: s.tool || s.tool_name || null,
      depends_on: Array.isArray(s.depends_on) ? s.depends_on :
        Array.isArray(s.dependsOn) ? s.dependsOn :
        Array.isArray(s.dependencies) ? s.dependencies : [],
      produces: Array.isArray(s.produces) ? s.produces :
        Array.isArray(s.outputs) ? s.outputs :
        s.output ? [s.output] : [],
      validates: s.validates || null,
      acceptance: s.acceptance || s.acceptance_test || s.success_criteria || null,
      parallel_group: s.parallel_group || s.parallelGroup || null,
    };
  });
  return {
    steps: normalized,
    intent: plan.intent || null,
    output_contract: plan.output_contract || null,
    tool_registry: plan.tool_registry || null,
  };
}

function detectCycles(steps) {
  // Kahn topological-sort variant — anything left at the end is in a cycle.
  const indeg = new Map();
  const outgoing = new Map();
  for (const s of steps) {
    indeg.set(s.id, 0);
    outgoing.set(s.id, []);
  }
  for (const s of steps) {
    for (const dep of s.depends_on || []) {
      if (!outgoing.has(dep)) continue;
      outgoing.get(dep).push(s.id);
      indeg.set(s.id, (indeg.get(s.id) || 0) + 1);
    }
  }
  const queue = [];
  for (const [id, n] of indeg.entries()) if (n === 0) queue.push(id);
  const visited = new Set();
  while (queue.length > 0) {
    const cur = queue.shift();
    visited.add(cur);
    for (const next of outgoing.get(cur) || []) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  const cyclic = [];
  for (const s of steps) if (!visited.has(s.id)) cyclic.push(s.id);
  if (cyclic.length === 0) return [];
  // Try to extract a minimal cycle path
  const cycle = extractCycle(steps, cyclic[0]);
  return cycle.length > 0 ? [cycle] : [cyclic];
}

function extractCycle(steps, startId) {
  const visited = new Set();
  const stack = [];
  const byId = new Map(steps.map(s => [s.id, s]));
  function dfs(id) {
    if (stack.includes(id)) {
      const idx = stack.indexOf(id);
      return stack.slice(idx).concat(id);
    }
    if (visited.has(id)) return null;
    visited.add(id);
    stack.push(id);
    const node = byId.get(id);
    if (!node) { stack.pop(); return null; }
    for (const dep of node.depends_on || []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    return null;
  }
  return dfs(startId) || [];
}

function longestPath(steps) {
  // Memoised longest-path over a DAG by depth
  const byId = new Map(steps.map(s => [s.id, s]));
  const memo = new Map();
  function depth(id, seen = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 0; // safety
    const s = byId.get(id);
    if (!s) return 0;
    const deps = s.depends_on || [];
    if (deps.length === 0) { memo.set(id, 1); return 1; }
    seen.add(id);
    let best = 0;
    for (const d of deps) {
      const sub = depth(d, seen);
      if (sub > best) best = sub;
    }
    seen.delete(id);
    const result = best + 1;
    memo.set(id, result);
    return result;
  }
  let longest = 0;
  for (const s of steps) {
    const d = depth(s.id);
    if (d > longest) longest = d;
  }
  return longest;
}

const BLOCKING_CODES = new Set([
  'missing_initial_step', 'circular_dependency', 'missing_tool',
  'duplicate_id', 'plan-shape-invalid', 'dangling_terminal_step',
]);

const WARNING_CODES = new Set([
  'orphan_step', 'duplicate_step', 'missing_validation_gate',
  'missing_clarification', 'excessive_parallelism', 'excessive_depth',
]);

function issue(code, message, context = {}) {
  let severity = 'info';
  if (BLOCKING_CODES.has(code)) severity = 'blocking';
  else if (WARNING_CODES.has(code)) severity = 'warning';
  return { code, severity, message, context };
}

function aggregateSeverity(issues) {
  if (issues.some(i => i.severity === 'blocking')) return 'blocking';
  if (issues.some(i => i.severity === 'warning')) return 'warning';
  if (issues.length > 0) return 'info';
  return 'clean';
}

function decideVerdict(issues, severity) {
  if (severity === 'blocking') return 'reject';
  if (severity === 'warning') return 'revise';
  if (severity === 'info') return 'accept_with_notes';
  return 'accept';
}

function reportEmpty(code, message) {
  return {
    plan_steps: 0,
    issues: [issue(code, message)],
    severity: 'blocking',
    verdict: 'reject',
    summary: { issue_count: 1, blocking_count: 1, warning_count: 0, info_count: 0 },
  };
}

module.exports = {
  critiquePlan,
  suggestRepairs,
  _internal: {
    normalizePlan,
    detectCycles,
    longestPath,
    aggregateSeverity,
    decideVerdict,
    BLOCKING_CODES,
    WARNING_CODES,
  },
};
