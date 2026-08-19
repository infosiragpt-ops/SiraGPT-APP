'use strict';

/**
 * prompt-optimizer — programmatic prompt optimization, DSPy/TextGrad-style.
 *
 * Treats prompts as parameter-bearing objects rather than hardcoded strings.
 * An execution tape captures (input, output, score) tuples from real runs;
 * an evaluator-driven optimizer mutates prompt parameters to maximize the
 * average metric over a held-out trainset. Two complementary algorithms
 * ship in this module:
 *
 *   - BootstrapFewShot — selects top-N highest-scoring (input, output)
 *     pairs from past runs as few-shot examples baked into the prompt.
 *     Inspired by DSPy's BootstrapFewShot teleprompter.
 *
 *   - COPRO — Coordinate-wise Prompt Optimization. Holds every parameter
 *     fixed except one, asks the caller's `mutator` for K candidate values,
 *     evaluates each on a trainset, keeps whichever scored best. Repeats
 *     across parameters for `rounds` iterations.
 *
 * Why this exists:
 *   - Today the agent's system prompts are hardcoded strings (see e.g.
 *     services/react-agent.js:35). They cannot improve without a human
 *     editing the file. This module gives a structured way to learn
 *     better prompts from execution traces — a core piece of any
 *     production-grade agent platform.
 *
 * Design constraints:
 *   - This module is purely a framework. The `executor` (LLM call) and
 *     `metric` (output → score) are injected by the caller.
 *   - All optimization is offline: a tape of past executions is the only
 *     input. No live LLM is contacted by this module unless the caller's
 *     `executor` does so.
 *   - The RawExecutionTape is privacy-unfiltered by design — gradients
 *     need raw inputs/outputs. The privacy-filtered trace already exists
 *     at services/sira/execution-trace-frame.js; do NOT confuse the two.
 *
 * Public API:
 *   - PromptModule         — parameterized prompt template
 *   - RawExecutionTape     — non-PII trace for optimization
 *   - BootstrapFewShot     — few-shot example selector
 *   - COPRO                — coordinate-wise prompt mutator/optimizer
 *   - Optimizer            — orchestrator combining bootstrap + copro
 *   - OptimizerError
 *   - interpolate          — exported helper for {{...}} substitution
 */

class OptimizerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OptimizerError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Replace `{{name}}` placeholders in `template` with values from `vars`.
 * Missing values render as empty string. The pattern accepts dotted paths
 * like `{{example.input}}` so callers can interpolate into nested structs
 * passed in as a flat name.
 */
function interpolate(template, vars) {
  if (typeof template !== 'string') {
    throw new OptimizerError('template_invalid', 'template must be a string');
  }
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const v = lookupPath(vars, key);
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    return String(v);
  });
}

function lookupPath(obj, path) {
  if (obj == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// ─────────────────────────────────────────────────────────────────────
// PromptModule — a prompt template with mutable parameters and optional
// few-shot examples baked in. forward(input) renders the template; if an
// executor is configured, it also calls the LLM and returns the output.
// ─────────────────────────────────────────────────────────────────────

class PromptModule {
  constructor({
    name,
    template,
    params = {},
    instructions = '',
    examples = [],
    executor = null,
    exampleFormatter = null,
  } = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new OptimizerError('module_invalid', 'PromptModule.name must be a non-empty string');
    }
    if (typeof template !== 'string') {
      throw new OptimizerError('module_invalid', 'PromptModule.template must be a string');
    }
    this.name = name;
    this.template = template;
    this.params = { ...params };
    this.instructions = String(instructions || '');
    this.examples = examples.slice();
    this.executor = executor && typeof executor === 'function' ? executor : null;
    this.exampleFormatter = typeof exampleFormatter === 'function'
      ? exampleFormatter
      : defaultExampleFormatter;
  }

  /** Render the prompt as a string without invoking any LLM. */
  render(input) {
    const sections = [];
    if (this.instructions) sections.push(this.instructions);
    if (this.examples.length > 0) {
      sections.push(this.examples.map(this.exampleFormatter).join('\n\n'));
    }
    sections.push(interpolate(this.template, { ...this.params, input, ...inputAsObject(input) }));
    return sections.join('\n\n');
  }

  /**
   * Render and (if executor is configured) run the LLM. Returns the raw
   * prompt string when no executor is set, so callers in raw-mode can
   * pipe the prompt to their own LLM client.
   */
  async forward(input) {
    const prompt = this.render(input);
    if (!this.executor) return prompt;
    return await this.executor(prompt, input, this);
  }

  /** Update one parameter. Throws OptimizerError if the key is unknown. */
  update(paramName, value) {
    if (!Object.prototype.hasOwnProperty.call(this.params, paramName)) {
      throw new OptimizerError('unknown_param', `unknown param "${paramName}"`);
    }
    this.params[paramName] = value;
    return this;
  }

  setExamples(examples) {
    if (!Array.isArray(examples)) {
      throw new OptimizerError('examples_invalid', 'examples must be an array');
    }
    this.examples = examples.slice();
    return this;
  }

  /** Deep-ish clone: params and examples are copied, executor is shared. */
  clone() {
    return new PromptModule({
      name: this.name,
      template: this.template,
      params: { ...this.params },
      instructions: this.instructions,
      examples: this.examples.slice(),
      executor: this.executor,
      exampleFormatter: this.exampleFormatter,
    });
  }
}

function defaultExampleFormatter(ex) {
  const inp = typeof ex.input === 'string' ? ex.input : JSON.stringify(ex.input);
  const out = typeof ex.output === 'string' ? ex.output : JSON.stringify(ex.output);
  return `Example:\nInput: ${inp}\nOutput: ${out}`;
}

function inputAsObject(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  return {};
}

// ─────────────────────────────────────────────────────────────────────
// RawExecutionTape — append-only record of (input, output, score) tuples.
//
// !!! PRIVACY WARNING !!!
// This tape is NOT privacy-filtered. It exists to provide raw
// inputs/outputs for gradient-style prompt optimization. Do NOT use it
// for any production response path that surfaces data to end users; for
// that use the privacy-filtered trace at:
//   backend/src/services/sira/execution-trace-frame.js
// ─────────────────────────────────────────────────────────────────────

class RawExecutionTape {
  constructor({ capacity = 1000 } = {}) {
    this.capacity = Math.max(1, capacity | 0);
    this.records = [];
  }

  record({ moduleName, input, output, score, metadata }) {
    if (typeof moduleName !== 'string' || !moduleName) {
      throw new OptimizerError('record_invalid', 'record: moduleName required');
    }
    const entry = {
      moduleName,
      input,
      output,
      score: typeof score === 'number' && Number.isFinite(score) ? score : null,
      metadata: metadata || null,
      ts: Date.now(),
    };
    this.records.push(entry);
    if (this.records.length > this.capacity) this.records.shift();
    return entry;
  }

  getRecords({ moduleName, minScore } = {}) {
    return this.records.filter(r =>
      (!moduleName || r.moduleName === moduleName) &&
      (minScore === undefined || (r.score !== null && r.score >= minScore)),
    );
  }

  size() { return this.records.length; }

  clear() {
    const n = this.records.length;
    this.records = [];
    return n;
  }
}

// ─────────────────────────────────────────────────────────────────────
// BootstrapFewShot — selects top-N highest-scoring (input, output) pairs
// from the tape and assigns them as the module's few-shot examples.
// ─────────────────────────────────────────────────────────────────────

class BootstrapFewShot {
  constructor({ n = 3, minScore = 0.7 } = {}) {
    this.n = Math.max(1, n | 0);
    this.minScore = +minScore;
  }

  async optimize(module, tape) {
    if (!(module instanceof PromptModule)) {
      throw new OptimizerError('module_invalid', 'BootstrapFewShot: module must be a PromptModule');
    }
    if (!(tape instanceof RawExecutionTape)) {
      throw new OptimizerError('tape_invalid', 'BootstrapFewShot: tape must be a RawExecutionTape');
    }
    const recs = tape.getRecords({ moduleName: module.name, minScore: this.minScore });
    const sorted = recs.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = sorted.slice(0, this.n).map(r => ({ input: r.input, output: r.output }));
    const optimized = module.clone();
    optimized.setExamples(top);
    return optimized;
  }
}

// ─────────────────────────────────────────────────────────────────────
// COPRO — Coordinate-wise Prompt Optimization.
// For each parameter in turn, asks the mutator for K candidate values,
// evaluates each on the trainset, keeps the best. Repeats for `rounds`.
// ─────────────────────────────────────────────────────────────────────

class COPRO {
  constructor({ candidatesPerParam = 4, rounds = 1, mutator } = {}) {
    if (typeof mutator !== 'function') {
      throw new OptimizerError('mutator_required', 'COPRO: mutator must be a function');
    }
    this.candidatesPerParam = Math.max(1, candidatesPerParam | 0);
    this.rounds = Math.max(1, rounds | 0);
    this.mutator = mutator;
    this.history = [];
  }

  async optimize(module, trainset, metric) {
    if (!(module instanceof PromptModule)) {
      throw new OptimizerError('module_invalid', 'COPRO: module must be a PromptModule');
    }
    if (!Array.isArray(trainset) || trainset.length === 0) {
      throw new OptimizerError('trainset_invalid', 'COPRO: trainset must be a non-empty array');
    }
    if (typeof metric !== 'function') {
      throw new OptimizerError('metric_required', 'COPRO: metric must be a function');
    }

    let best = module.clone();
    let bestScore = await this._evaluate(best, trainset, metric);
    this.history.push({ round: 0, paramName: '<init>', score: bestScore });

    for (let r = 1; r <= this.rounds; r++) {
      for (const paramName of Object.keys(best.params)) {
        const currentValue = best.params[paramName];
        const candidates = await this._generateCandidates(paramName, currentValue);
        for (const candValue of candidates) {
          const candidate = best.clone();
          candidate.params[paramName] = candValue;
          const score = await this._evaluate(candidate, trainset, metric);
          this.history.push({ round: r, paramName, score });
          if (score > bestScore) {
            best = candidate;
            bestScore = score;
          }
        }
      }
    }
    return best;
  }

  async _generateCandidates(paramName, currentValue) {
    const out = [];
    for (let i = 0; i < this.candidatesPerParam; i++) {
      try {
        const c = await this.mutator(paramName, currentValue, i);
        if (c !== undefined) out.push(c);
      } catch {
        // Absorbed: a flaky mutator should not abort optimization.
      }
    }
    return out;
  }

  async _evaluate(module, trainset, metric) {
    let total = 0;
    let count = 0;
    for (const example of trainset) {
      let output;
      try {
        output = await module.forward(example.input);
      } catch {
        continue;
      }
      try {
        const s = await metric(example.input, output, example);
        const n = Number(s);
        if (Number.isFinite(n)) {
          total += n;
          count += 1;
        }
      } catch {
        // Metric failure: skip this example, do not abort.
      }
    }
    return count > 0 ? total / count : 0;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Optimizer — runs BootstrapFewShot then COPRO (in that order). Either
// can be omitted; with neither configured, compile() is a no-op.
// ─────────────────────────────────────────────────────────────────────

class Optimizer {
  constructor({ bootstrap, copro } = {}) {
    this.bootstrap = bootstrap || null;
    this.copro = copro || null;
  }

  async compile(module, { tape, trainset, metric } = {}) {
    if (!(module instanceof PromptModule)) {
      throw new OptimizerError('module_invalid', 'Optimizer.compile: module must be a PromptModule');
    }
    let m = module.clone();
    if (this.bootstrap) {
      if (!(tape instanceof RawExecutionTape)) {
        throw new OptimizerError('tape_required', 'Optimizer.compile: bootstrap requires a RawExecutionTape');
      }
      m = await this.bootstrap.optimize(m, tape);
    }
    if (this.copro) {
      m = await this.copro.optimize(m, trainset, metric);
    }
    return m;
  }
}

module.exports = {
  PromptModule,
  RawExecutionTape,
  BootstrapFewShot,
  COPRO,
  Optimizer,
  OptimizerError,
  interpolate,
};
