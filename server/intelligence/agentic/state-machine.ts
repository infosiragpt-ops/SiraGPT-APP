/**
 * server/intelligence/agentic/state-machine.ts
 *
 * Extension point (stubbed with a real, minimal implementation): a
 * plan → execute → reflect → finalize agentic executor. It owns a bounded loop,
 * runs side-effect-free (read-only) tool calls in PARALLEL while sequencing
 * effectful ones, and records every step for observability.
 *
 * The contract (`AgenticExecutor`) is final. Production can inject a
 * model-backed `planner`/`reflector`/`finalizer`; the defaults are deterministic
 * so the loop is testable without an LLM. The heavier wiring (BullMQ lock
 * renewal, durable checkpoints) is intentionally left as the next step — this
 * module is the typed seam it plugs into.
 */

import type {
  AgentRunResult,
  AgentStep,
  AgenticExecutor,
  ToolCall,
  ToolDescriptor,
  ToolResult,
  ToolRuntime,
} from '../ports';

export interface PlanDecision {
  readonly toolCalls: ToolCall[];
  readonly done: boolean;
  readonly thought?: string;
}

export interface Planner {
  plan(input: {
    goal: string;
    tools: ReadonlyArray<ToolDescriptor>;
    history: ReadonlyArray<AgentStep>;
  }): PlanDecision | Promise<PlanDecision>;
}

export interface Reflector {
  reflect(input: {
    goal: string;
    results: ReadonlyArray<ToolResult>;
    history: ReadonlyArray<AgentStep>;
  }): { done: boolean; thought?: string } | Promise<{ done: boolean; thought?: string }>;
}

export interface Finalizer {
  finalize(input: { goal: string; steps: ReadonlyArray<AgentStep> }): string | Promise<string>;
}

/** Default planner: proposes one call per tool whose name is referenced in the
 *  goal, on the first turn only; finalizes once results exist. */
export function createHeuristicPlanner(): Planner {
  return {
    plan({ goal, tools, history }) {
      const hasExecuted = history.some((s) => s.phase === 'execute');
      if (hasExecuted || tools.length === 0) {
        return { toolCalls: [], done: true, thought: 'sufficient information gathered' };
      }
      const goalLc = goal.toLowerCase();
      const matched = tools.filter((t) => goalLc.includes(t.name.toLowerCase()));
      const chosen = (matched.length > 0 ? matched : tools.slice(0, 1)).slice(0, 3);
      return {
        toolCalls: chosen.map((t) => ({ tool: t.name, args: { query: goal } })),
        done: chosen.length === 0,
        thought: `planning ${chosen.length} tool call(s)`,
      };
    },
  };
}

export function createDefaultReflector(): Reflector {
  return {
    reflect({ results }) {
      const anyFailed = results.some((r) => !r.ok);
      return {
        done: !anyFailed,
        thought: anyFailed ? 'a tool failed; will stop and report what we have' : 'results look sufficient',
      };
    },
  };
}

export function createDefaultFinalizer(): Finalizer {
  return {
    finalize({ goal, steps }) {
      const outputs: string[] = [];
      for (const step of steps) {
        for (const r of step.toolResults ?? []) {
          if (r.ok) outputs.push(`${r.tool}: ${stringify(r.output)}`);
        }
      }
      if (outputs.length === 0) return `No tools were needed for: ${goal}`;
      return [`Result for: ${goal}`, ...outputs.map((o) => `- ${o}`)].join('\n');
    },
  };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 400);
  try {
    return JSON.stringify(value).slice(0, 400);
  } catch {
    return String(value).slice(0, 400);
  }
}

export interface AgenticExecutorOptions {
  readonly planner?: Planner;
  readonly reflector?: Reflector;
  readonly finalizer?: Finalizer;
  readonly defaultMaxSteps?: number;
}

export function createAgenticExecutor(
  options: AgenticExecutorOptions = {}
): AgenticExecutor {
  const planner = options.planner ?? createHeuristicPlanner();
  const reflector = options.reflector ?? createDefaultReflector();
  const finalizer = options.finalizer ?? createDefaultFinalizer();
  const defaultMaxSteps = Math.max(1, options.defaultMaxSteps ?? 6);

  async function run(input: {
    goal: string;
    tools: ReadonlyArray<ToolDescriptor>;
    runtime: ToolRuntime;
    maxSteps?: number;
    signal?: AbortSignal;
  }): Promise<AgentRunResult> {
    const maxSteps = Math.max(1, input.maxSteps ?? defaultMaxSteps);
    const steps: AgentStep[] = [];
    const toolByName = new Map(input.tools.map((t) => [t.name, t]));
    let completed = false;
    let reason = 'max_steps_reached';

    for (let i = 0; i < maxSteps; i += 1) {
      if (input.signal?.aborted) {
        reason = 'aborted';
        break;
      }

      // --- PLAN -------------------------------------------------------------
      const decision = await planner.plan({ goal: input.goal, tools: input.tools, history: steps });
      steps.push({ phase: 'plan', thought: decision.thought, toolCalls: decision.toolCalls });

      if (decision.done || decision.toolCalls.length === 0) {
        completed = true;
        reason = 'planner_finished';
        break;
      }

      // --- EXECUTE (read-only tools in parallel, effectful ones in order) ---
      const readOnly: ToolCall[] = [];
      const effectful: ToolCall[] = [];
      for (const call of decision.toolCalls) {
        const desc = toolByName.get(call.tool);
        if (desc?.readOnly) readOnly.push(call);
        else effectful.push(call);
      }

      const results: ToolResult[] = [];
      const parallel = await Promise.all(
        readOnly.map((call) => invokeSafely(input.runtime, call, input.signal))
      );
      results.push(...parallel);
      for (const call of effectful) {
        results.push(await invokeSafely(input.runtime, call, input.signal));
      }

      steps.push({ phase: 'execute', toolCalls: decision.toolCalls, toolResults: results });

      // --- REFLECT ----------------------------------------------------------
      const reflection = await reflector.reflect({ goal: input.goal, results, history: steps });
      steps.push({ phase: 'reflect', thought: reflection.thought });
      if (reflection.done) {
        completed = true;
        reason = 'reflector_finished';
        break;
      }
    }

    // --- FINALIZE -----------------------------------------------------------
    const output = await finalizer.finalize({ goal: input.goal, steps });
    steps.push({ phase: 'finalize', thought: 'composed final answer' });

    return { steps, output, completed, reason };
  }

  return { run };
}

async function invokeSafely(
  runtime: ToolRuntime,
  call: ToolCall,
  signal?: AbortSignal
): Promise<ToolResult> {
  try {
    return await runtime.invoke(call, signal);
  } catch (e) {
    return {
      tool: call.tool,
      ok: false,
      output: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
