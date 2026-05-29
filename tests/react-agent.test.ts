import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"

const cjsRequire = createRequire(__filename)

type ReactStep = { step: number; thought: string; actions: Array<{ tool: string; args: string; observation: unknown }> }
type ReactResult = { finalAnswer: string | null; steps: ReactStep[]; stoppedReason: string }

type ReactAgent = {
  run: (openai: FakeOpenAI, opts: {
    query: string
    tools: Array<{
      name: string
      description: string
      parameters?: unknown
      execute: (args: unknown, ctx: unknown) => Promise<unknown> | unknown
    }>
    maxSteps?: number
    maxRuntimeMs?: number
    onStepStart?: (step: ReactStep) => void
    onStepDone?: (step: ReactStep) => void
    onStep?: (step: ReactStep) => void
    ctx?: unknown
    model?: string
    finalizeGuard?: (args: { answer: string; confidence: string | null; steps: ReactStep[]; currentStep: ReactStep; ctx: unknown }) => Promise<{ ok: boolean; message?: string; missingTools?: string[]; repairInstructions?: string }> | { ok: boolean; message?: string; missingTools?: string[]; repairInstructions?: string }
  }) => Promise<ReactResult>
  DEFAULT_MAX_STEPS: number
}

const reactAgent = cjsRequire("../../backend/src/services/react-agent") as ReactAgent

// ──────────────────────────────────────────────────────────────────
// Fake OpenAI — plays back a scripted list of assistant messages so
// tests can exercise the ReAct loop without network or API keys.
// ──────────────────────────────────────────────────────────────────
type FakeMessage = {
  content?: string
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
}

class FakeOpenAI {
  calls = 0
  history: Array<{ model: string; messages: unknown[]; tool_choice: unknown }> = []
  constructor(private script: FakeMessage[]) {}
  chat = {
    completions: {
      create: async (req: { model: string; messages: unknown[]; tool_choice: unknown }) => {
        this.history.push({ model: req.model, messages: req.messages, tool_choice: req.tool_choice })
        const msg = this.script[this.calls] || { content: "(script exhausted)" }
        this.calls++
        return { choices: [{ message: msg }] }
      },
    },
  }
}

function finalizeCall(id: string, answer: string) {
  return {
    id,
    function: { name: "finalize", arguments: JSON.stringify({ answer, confidence: "high" }) },
  }
}

describe("react-agent · happy path", () => {
  it("executes a tool, observes, then finalizes", async () => {
    const fake = new FakeOpenAI([
      { content: "I need to search the web.", tool_calls: [
        { id: "call_1", function: { name: "echo", arguments: JSON.stringify({ text: "hi" }) } },
      ]},
      { content: "Got it. Finalizing.", tool_calls: [finalizeCall("call_2", "The answer is 42.")] },
    ])
    const result = await reactAgent.run(fake, {
      query: "what's the answer?",
      tools: [{
        name: "echo",
        description: "echoes text back",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        execute: async (args: any) => ({ echoed: args.text }),
      }],
    })
    assert.equal(result.stoppedReason, "finalized")
    assert.equal(result.finalAnswer, "The answer is 42.")
    assert.equal(result.steps.length, 2)
    assert.equal(result.steps[0].actions[0].tool, "echo")
    assert.deepEqual(result.steps[0].actions[0].observation, { echoed: "hi" })
  })

  it("invokes onStep for every step", async () => {
    const fake = new FakeOpenAI([
      { content: "Finalizing immediately.", tool_calls: [finalizeCall("c1", "done")] },
    ])
    const seen: ReactStep[] = []
    await reactAgent.run(fake, {
      query: "q",
      tools: [],
      onStep: (s) => seen.push(s),
    })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].actions[0].tool, "finalize")
  })

  it("fires step_start before tool execution and step_done after observation", async () => {
    const fake = new FakeOpenAI([
      { content: "Need a tool.", tool_calls: [
        { id: "call_1", function: { name: "echo", arguments: JSON.stringify({ text: "hi" }) } },
      ]},
      { content: "Finalizing.", tool_calls: [finalizeCall("call_2", "done")] },
    ])
    const order: string[] = []
    await reactAgent.run(fake, {
      query: "q",
      tools: [{
        name: "echo",
        description: "echoes text back",
        execute: async () => {
          order.push("tool")
          return { ok: true }
        },
      }],
      onStepStart: () => order.push("start"),
      onStep: () => order.push("legacy"),
      onStepDone: () => order.push("done"),
    })
    assert.deepEqual(order.slice(0, 4), ["start", "tool", "legacy", "done"])
  })
})

describe("react-agent · safety", () => {
  it("forces finalize on the last step when maxSteps is reached", async () => {
    const fake = new FakeOpenAI([
      { content: "step 1", tool_calls: [{ id: "a", function: { name: "loop", arguments: "{}" } }] },
      { content: "step 2 (forced finalize)", tool_calls: [finalizeCall("b", "capped")] },
    ])
    const result = await reactAgent.run(fake, {
      query: "q",
      tools: [{ name: "loop", description: "never-ends", execute: async () => ({ ok: true }) }],
      maxSteps: 2,
    })
    assert.equal(result.stoppedReason, "finalized")
    assert.equal(result.finalAnswer, "capped")
    const lastCall = fake.history[fake.history.length - 1]
    assert.deepEqual(lastCall.tool_choice, { type: "function", function: { name: "finalize" } })
  })

  it("returns a structured observation when the model invents an unknown tool", async () => {
    const fake = new FakeOpenAI([
      { content: "calling nonsense", tool_calls: [{ id: "a", function: { name: "does_not_exist", arguments: "{}" } }] },
      { content: "finalizing after failure", tool_calls: [finalizeCall("b", "survived")] },
    ])
    const result = await reactAgent.run(fake, { query: "q", tools: [] })
    const firstObs = result.steps[0].actions[0].observation as { error?: string }
    assert.match(firstObs.error || "", /unknown_tool/)
    assert.equal(result.finalAnswer, "survived")
  })

  it("recovers when a tool throws", async () => {
    const fake = new FakeOpenAI([
      { content: "try tool", tool_calls: [{ id: "a", function: { name: "boom", arguments: "{}" } }] },
      { content: "moving on", tool_calls: [finalizeCall("b", "ok despite error")] },
    ])
    const result = await reactAgent.run(fake, {
      query: "q",
      tools: [{ name: "boom", description: "always throws", execute: async () => { throw new Error("kaboom") } }],
    })
    const firstObs = result.steps[0].actions[0].observation as { error?: string }
    assert.match(firstObs.error || "", /tool_execution_failed: kaboom/)
    assert.equal(result.finalAnswer, "ok despite error")
  })

  it("rejects invalid JSON args with a structured observation", async () => {
    const fake = new FakeOpenAI([
      { content: "bad json", tool_calls: [{ id: "a", function: { name: "ok", arguments: "{this-is-not-json" } }] },
      { content: "finalize", tool_calls: [finalizeCall("b", "done")] },
    ])
    const result = await reactAgent.run(fake, {
      query: "q",
      tools: [{ name: "ok", description: "works", execute: async () => ({ ok: true }) }],
    })
    const firstObs = result.steps[0].actions[0].observation as { error?: string }
    assert.match(firstObs.error || "", /invalid_json_args/)
  })

  it("validates tool args against JSON Schema before execution", async () => {
    const fake = new FakeOpenAI([
      { content: "call with invalid args", tool_calls: [{ id: "a", function: { name: "typed_echo", arguments: JSON.stringify({ extra: true }) } }] },
      { content: "finalize after schema failure", tool_calls: [finalizeCall("b", "schema blocked bad args")] },
    ])
    let executeCount = 0
    const result = await reactAgent.run(fake, {
      query: "q",
      tools: [{
        name: "typed_echo",
        description: "requires text only",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        execute: async () => {
          executeCount += 1
          return { ok: true }
        },
      }],
    })

    const firstObs = result.steps[0].actions[0].observation as { error?: string }
    assert.equal(executeCount, 0)
    assert.match(firstObs.error || "", /invalid_tool_args/)
    assert.match(firstObs.error || "", /required/)
    assert.equal(result.finalAnswer, "schema blocked bad args")
  })

  it("treats plain-text replies (no tool call) as a degenerate finalize", async () => {
    const fake = new FakeOpenAI([
      { content: "I'll just answer directly: it's blue." },
    ])
    const result = await reactAgent.run(fake, { query: "q", tools: [] })
    assert.equal(result.stoppedReason, "plain_text_finalize")
    assert.match(result.finalAnswer || "", /it's blue/)
  })

  it("does not allow plain-text replies to bypass finalizeGuard", async () => {
    const fake = new FakeOpenAI([
      { content: "I'll just answer directly without the required evidence." },
      { content: "Running required tool.", tool_calls: [{ id: "b", function: { name: "echo", arguments: JSON.stringify({ text: "evidence" }) } }] },
      { content: "Finalizing after evidence.", tool_calls: [finalizeCall("c", "done with evidence")] },
    ])
    const result = await reactAgent.run(fake, {
      query: "q",
      tools: [{
        name: "echo",
        description: "required tool",
        execute: async (args: any) => ({ ok: true, text: args.text }),
      }],
      finalizeGuard: ({ steps }) => {
        const hasEcho = steps.some(step => step.actions.some(action => action.tool === "echo"))
        return hasEcho
          ? { ok: true }
          : { ok: false, message: "missing echo", missingTools: ["echo"], repairInstructions: "call echo first" }
      },
    })

    assert.equal(result.stoppedReason, "finalized")
    assert.equal(result.finalAnswer, "done with evidence")
    assert.equal(result.steps[0].actions.length, 0)
    const secondTurnMessages = fake.history[1].messages as Array<{ role?: string; content?: string }>
    assert.ok(
      secondTurnMessages.some(message => String(message.content || "").includes("plain_text_finalize_guard_failed")),
      "expected a repair instruction after guarded plain text"
    )
  })

  it("blocks finalize with a structured observation until deterministic gates pass", async () => {
    const fake = new FakeOpenAI([
      { content: "Trying to finalize too early.", tool_calls: [finalizeCall("a", "too early")] },
      { content: "Running required tool.", tool_calls: [{ id: "b", function: { name: "echo", arguments: JSON.stringify({ text: "evidence" }) } }] },
      { content: "Finalizing after evidence.", tool_calls: [finalizeCall("c", "done with evidence")] },
    ])
    const result = await reactAgent.run(fake, {
      query: "q",
      tools: [{
        name: "echo",
        description: "required tool",
        execute: async (args: any) => ({ ok: true, text: args.text }),
      }],
      finalizeGuard: ({ steps }) => {
        const hasEcho = steps.some(step => step.actions.some(action => action.tool === "echo"))
        return hasEcho
          ? { ok: true }
          : { ok: false, message: "missing echo", missingTools: ["echo"], repairInstructions: "call echo first" }
      },
    })

    assert.equal(result.stoppedReason, "finalized")
    assert.equal(result.finalAnswer, "done with evidence")
    assert.equal((result.steps[0].actions[0].observation as { error?: string }).error, "finalize_guard_failed")
    assert.equal(result.steps[1].actions[0].tool, "echo")
  })
})

describe("react-agent · input validation", () => {
  it("throws when query is missing", async () => {
    await assert.rejects(
      () => reactAgent.run(new FakeOpenAI([]), { query: "", tools: [{ name: "x", description: "x", execute: async () => ({}) }] }),
      /query is required/
    )
  })

  it("throws when tools is not an array", async () => {
    await assert.rejects(
      () => reactAgent.run(new FakeOpenAI([]), { query: "q", tools: null as unknown as [] }),
      /tools must be an array/
    )
  })
})

describe("react-agent · module integration", () => {
  it("agent route module loads cleanly", () => {
    const mod = cjsRequire("../../backend/src/routes/agent")
    assert.ok(mod)
  })
})
