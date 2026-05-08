'use strict';

/**
 * tree-of-thought — generic branching reasoner with adaptive beam search.
 *
 * For problems where stepwise reasoning benefits from exploring multiple
 * alternative paths (planning, complex code generation, multi-step solving),
 * a single linear chain of thought is provably worse than exploring a tree
 * of possibilities and pruning. This module provides a generic, swappable
 * implementation of the Tree-of-Thoughts (Yao et al., NeurIPS 2023) family
 * of search strategies, with three enhancements over the canonical paper:
 *
 *   1. **Adaptive beam width.** The classic ToT uses a fixed beam K; we
 *      adjust K dynamically based on the coefficient of variation of
 *      sibling scores. Low CV (the children agree) → narrow beam (commit).
 *      High CV (the children disagree) → wide beam (explore).
 *
 *   2. **Subtree memoization.** Two paths can converge on the same state
 *      (equivalent partial solutions reached by different routes). A
 *      SingleFlight-backed coalescer ensures we expand each unique state
 *      exactly once per search — a critical optimization for graphs of
 *      thoughts where DAG structure emerges naturally.
 *
 *   3. **Compensation hook.** When a branch is abandoned (pruned by the
 *      beam), the caller's optional `compensate(state)` is invoked so any
 *      side effects from the evaluator can be rolled back. Pairs cleanly
 *      with the saga-coordinator for atomicity guarantees.
 *
 * The module is purely a search framework. Callers inject the problem
 * semantics:
 *
 *   const tot = new TreeOfThought({
 *     expand:    async (state, depth) => [s1, s2, s3],   // candidates
 *     evaluate:  async (state) => 0.0..1.0,              // higher = better
 *     isGoal:    (state) => boolean,
 *     hashState: (state) => 'stable-string',             // optional
 *     compensate: async (state) => {},                   // optional
 *   });
 *   const result = await tot.search(initialState);
 *
 * Result shape:
 *   {
 *     status: 'solved' | 'exhausted' | 'timed-out' | 'aborted' | 'plateaued',
 *     bestPath:    [{ state, score, depth }],
 *     bestScore:   number,
 *     exploredNodes: number,
 *     expansions:    number,
 *     evaluations:   number,
 *     beamHistory:   [{ depth, width, cv }],
 *     elapsedMs:     number,
 *     trace?:        [...expansion events when traceEnabled]
 *   }
 *
 * Public API:
 *   - TreeOfThought class
 *   - SearchError (base error)
 *   - STATUS — frozen status enum
 */

const { SingleFlight } = require('../../cache/single-flight');

class SearchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
    Object.assign(this, details);
  }
}

const STATUS = Object.freeze({
  solved: 'solved',
  exhausted: 'exhausted',
  timedOut: 'timed-out',
  aborted: 'aborted',
  plateaued: 'plateaued',
});

const DEFAULTS = Object.freeze({
  maxDepth: 6,
  maxNodes: 200,
  maxTimeMs: 30_000,
  minBeamWidth: 1,
  maxBeamWidth: 8,
  initialBeamWidth: 3,
  adaptiveBeam: true,
  cvLowThreshold: 0.05,
  cvHighThreshold: 0.25,
  parallelEvaluation: true,
  goalScoreThreshold: 0.95,
  plateauPatience: 2,
  plateauEpsilon: 1e-6,
  traceEnabled: false,
});

let _idCounter = 0;
function makeThought({ state, parentId, depth, score = 0, metadata = null }) {
  return {
    id: ++_idCounter,
    parentId: parentId || null,
    state,
    score,
    depth: depth | 0,
    metadata,
  };
}

/**
 * Coefficient of variation = std-dev / mean. Returns 0 when mean is 0
 * or fewer than 2 samples. Scale-invariant uncertainty measure.
 */
function coefficientOfVariation(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  if (mean === 0) return 0;
  let sq = 0;
  for (const v of values) {
    const d = v - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / values.length);
  return std / Math.abs(mean);
}

class TreeOfThought {
  constructor(opts = {}) {
    if (typeof opts.expand !== 'function') {
      throw new SearchError('expand_required', 'TreeOfThought: expand must be a function');
    }
    if (typeof opts.evaluate !== 'function') {
      throw new SearchError('evaluate_required', 'TreeOfThought: evaluate must be a function');
    }
    if (typeof opts.isGoal !== 'function') {
      throw new SearchError('isGoal_required', 'TreeOfThought: isGoal must be a function');
    }

    this.expand = opts.expand;
    this.evaluate = opts.evaluate;
    this.isGoal = opts.isGoal;
    this.hashState = typeof opts.hashState === 'function' ? opts.hashState : null;
    this.compensate = typeof opts.compensate === 'function' ? opts.compensate : null;
    this.selector = typeof opts.selector === 'function' ? opts.selector : null;

    const cfg = { ...DEFAULTS, ...opts };
    if (cfg.maxBeamWidth < cfg.minBeamWidth) {
      throw new SearchError('config_invalid', 'maxBeamWidth must be >= minBeamWidth');
    }
    if (cfg.initialBeamWidth < cfg.minBeamWidth || cfg.initialBeamWidth > cfg.maxBeamWidth) {
      throw new SearchError('config_invalid', 'initialBeamWidth must be in [minBeamWidth, maxBeamWidth]');
    }
    Object.assign(this, {
      maxDepth: cfg.maxDepth | 0,
      maxNodes: cfg.maxNodes | 0,
      maxTimeMs: cfg.maxTimeMs | 0,
      minBeamWidth: cfg.minBeamWidth | 0,
      maxBeamWidth: cfg.maxBeamWidth | 0,
      initialBeamWidth: cfg.initialBeamWidth | 0,
      adaptiveBeam: !!cfg.adaptiveBeam,
      cvLowThreshold: +cfg.cvLowThreshold,
      cvHighThreshold: +cfg.cvHighThreshold,
      parallelEvaluation: !!cfg.parallelEvaluation,
      goalScoreThreshold: +cfg.goalScoreThreshold,
      plateauPatience: cfg.plateauPatience | 0,
      plateauEpsilon: +cfg.plateauEpsilon,
      traceEnabled: !!cfg.traceEnabled,
    });

    this.signal = opts.signal || null;
    this.onExpand = typeof opts.onExpand === 'function' ? opts.onExpand : null;
    this.onEvaluate = typeof opts.onEvaluate === 'function' ? opts.onEvaluate : null;
    this.onPrune = typeof opts.onPrune === 'function' ? opts.onPrune : null;

    // Internal fast-path single-flight per search (re-instantiated each search).
    this._sf = null;
  }

  /**
   * Execute the search starting from `initialState`. Returns a structured
   * result regardless of outcome — the caller branches on `status`.
   */
  async search(initialState) {
    const startedAt = Date.now();
    const cancelled = () => this.signal && this.signal.aborted;
    const overTime = () => (Date.now() - startedAt) >= this.maxTimeMs;
    this._sf = new SingleFlight();

    let exploredNodes = 0;
    let expansions = 0;
    let evaluations = 0;
    const trace = [];
    const parents = new Map(); // id -> thought (for path reconstruction)

    // ── Evaluate root ────────────────────────────────────────────────
    const root = makeThought({ state: initialState, depth: 0 });
    parents.set(root.id, root);

    try {
      root.score = clamp01(await this._safeEvaluate(root.state));
      evaluations += 1;
    } catch (err) {
      // Root evaluation failure: bail with structured exhausted result.
      return this._finalize(STATUS.exhausted, root, parents, {
        startedAt, exploredNodes, expansions, evaluations, beamHistory: [], trace,
        firstError: serializeErr(err),
      });
    }

    let bestThought = root;

    // Early goal check at root.
    if (this._safeIsGoal(root.state) && root.score >= this.goalScoreThreshold) {
      return this._finalize(STATUS.solved, root, parents, {
        startedAt, exploredNodes, expansions, evaluations, beamHistory: [], trace,
      });
    }

    // ── Beam search ──────────────────────────────────────────────────
    let beam = [root];
    let beamWidth = this.initialBeamWidth;
    let lastBestScore = root.score;
    let plateauCount = 0;
    const beamHistory = [];

    for (let depth = 0; depth < this.maxDepth; depth++) {
      if (cancelled()) return this._finalize(STATUS.aborted, bestThought, parents, {
        startedAt, exploredNodes, expansions, evaluations, beamHistory, trace,
      });
      if (overTime()) return this._finalize(STATUS.timedOut, bestThought, parents, {
        startedAt, exploredNodes, expansions, evaluations, beamHistory, trace,
      });
      if (exploredNodes >= this.maxNodes) return this._finalize(STATUS.exhausted, bestThought, parents, {
        startedAt, exploredNodes, expansions, evaluations, beamHistory, trace,
      });

      // Expand every beam member, possibly via single-flight memoization.
      const expandTasks = beam.map(parent => this._expandOne(parent, depth, trace));
      const childGroups = await Promise.all(expandTasks);
      expansions += childGroups.length;

      // Flatten + register parent pointers.
      const children = [];
      for (let i = 0; i < beam.length; i++) {
        const parent = beam[i];
        for (const childState of childGroups[i]) {
          const ch = makeThought({ state: childState, parentId: parent.id, depth: depth + 1 });
          parents.set(ch.id, ch);
          children.push(ch);
        }
      }
      exploredNodes += children.length;

      if (children.length === 0) {
        // No more frontier to explore; return the best we have.
        return this._finalize(STATUS.exhausted, bestThought, parents, {
          startedAt, exploredNodes, expansions, evaluations, beamHistory, trace,
        });
      }

      // Evaluate children (parallel by default).
      if (this.parallelEvaluation) {
        await Promise.all(children.map(async ch => {
          ch.score = clamp01(await this._safeEvaluate(ch.state));
          evaluations += 1;
        }));
      } else {
        for (const ch of children) {
          ch.score = clamp01(await this._safeEvaluate(ch.state));
          evaluations += 1;
          if (cancelled() || overTime()) break;
        }
      }

      // Track global best.
      for (const ch of children) {
        if (ch.score > bestThought.score) bestThought = ch;
      }

      // Goal check.
      const goalChild = children.find(
        ch => this._safeIsGoal(ch.state) && ch.score >= this.goalScoreThreshold,
      );
      if (goalChild) {
        beamHistory.push({ depth: depth + 1, width: beamWidth, cv: 0 });
        return this._finalize(STATUS.solved, goalChild, parents, {
          startedAt, exploredNodes, expansions, evaluations, beamHistory, trace,
        });
      }

      // Adaptive beam adjustment.
      const cv = coefficientOfVariation(children.map(ch => ch.score));
      if (this.adaptiveBeam) {
        if (cv < this.cvLowThreshold) {
          beamWidth = Math.max(this.minBeamWidth, beamWidth - 1);
        } else if (cv > this.cvHighThreshold) {
          beamWidth = Math.min(this.maxBeamWidth, beamWidth + 1);
        }
      }
      beamHistory.push({ depth: depth + 1, width: beamWidth, cv });

      // Plateau detection.
      const newBestThisLevel = Math.max(...children.map(ch => ch.score));
      if (newBestThisLevel <= lastBestScore + this.plateauEpsilon) {
        plateauCount += 1;
        if (plateauCount >= this.plateauPatience) {
          return this._finalize(STATUS.plateaued, bestThought, parents, {
            startedAt, exploredNodes, expansions, evaluations, beamHistory, trace,
          });
        }
      } else {
        plateauCount = 0;
        lastBestScore = newBestThisLevel;
      }

      // Pick survivors via selector or default top-K.
      const ranked = this.selector
        ? this.selector(children, beamWidth).slice(0, beamWidth)
        : children.slice().sort((a, b) => b.score - a.score).slice(0, beamWidth);
      const rankedIds = new Set(ranked.map(t => t.id));
      const losers = children.filter(t => !rankedIds.has(t.id));

      if (this.onPrune && losers.length > 0) {
        try { this.onPrune(losers.map(l => ({ ...l }))); } catch { /* journal must not break */ }
      }

      // Compensate abandoned branches (best effort, never throws upward).
      if (this.compensate && losers.length > 0) {
        await Promise.all(losers.map(async loser => {
          try { await this.compensate(loser.state); }
          catch { /* swallow — abandonment cleanup is advisory */ }
        }));
      }

      beam = ranked;
    }

    return this._finalize(STATUS.exhausted, bestThought, parents, {
      startedAt, exploredNodes, expansions, evaluations, beamHistory, trace,
    });
  }

  // ── Internals ────────────────────────────────────────────────────

  async _expandOne(parent, depth, trace) {
    let children = [];
    try {
      if (this.hashState) {
        const h = String(this.hashState(parent.state));
        children = await this._sf.do(`expand:${h}`, () => this._safeExpand(parent.state, depth));
      } else {
        children = await this._safeExpand(parent.state, depth);
      }
    } catch {
      children = [];
    }
    if (!Array.isArray(children)) children = [];
    if (this.traceEnabled) {
      trace.push({ kind: 'expand', parentId: parent.id, depth, count: children.length });
    }
    if (this.onExpand) {
      try { this.onExpand({ parent: { ...parent }, depth, count: children.length }); } catch { /* journal */ }
    }
    return children;
  }

  async _safeExpand(state, depth) {
    return await this.expand(state, depth);
  }

  async _safeEvaluate(state) {
    let score;
    try {
      score = await this.evaluate(state);
    } catch {
      score = 0;
    }
    if (this.onEvaluate) {
      try { this.onEvaluate({ state, score }); } catch { /* journal */ }
    }
    return score;
  }

  _safeIsGoal(state) {
    try { return !!this.isGoal(state); }
    catch { return false; }
  }

  _finalize(status, bestThought, parents, extras) {
    const path = [];
    let cursor = bestThought;
    while (cursor) {
      path.unshift({ state: cursor.state, score: cursor.score, depth: cursor.depth });
      if (!cursor.parentId) break;
      cursor = parents.get(cursor.parentId) || null;
    }
    return {
      status,
      bestPath: path,
      bestScore: bestThought.score,
      bestState: bestThought.state,
      exploredNodes: extras.exploredNodes,
      expansions: extras.expansions,
      evaluations: extras.evaluations,
      beamHistory: extras.beamHistory.slice(),
      elapsedMs: Date.now() - extras.startedAt,
      trace: this.traceEnabled ? extras.trace.slice() : undefined,
      firstError: extras.firstError || null,
    };
  }
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function serializeErr(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    message: typeof err.message === 'string' ? err.message.slice(0, 500) : String(err).slice(0, 500),
    code: err.code || null,
  };
}

module.exports = {
  TreeOfThought,
  SearchError,
  STATUS,
  DEFAULTS,
  coefficientOfVariation,
};
