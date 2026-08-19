import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const budgetPolicy = require(path.join(
  process.cwd(),
  "backend/src/services/sira/token-budget-policy.js",
))
const tokenLedger = require(path.join(
  process.cwd(),
  "backend/src/services/sira/token-ledger.js",
))
const {
  handleChatTurn,
} = require(path.join(
  process.cwd(),
  "backend/src/services/sira/chat-controller.js",
))
const {
  createInMemoryStorage,
  createSiraStorage,
} = require(path.join(
  process.cwd(),
  "backend/src/services/sira/storage-schema.js",
))

describe("sira token budget policy", () => {
  it("allows normal turns under the configured caps", () => {
    const frame = budgetPolicy.assessTokenBudget({
      userId: "user_budget_ok",
      conversationId: "conv_budget_ok",
      userPlan: "FREE",
      userMessage: "resume este texto en un parrafo",
      selectedModel: { provider: "openai", modelId: "gpt-5-mini" },
      caps: {
        max_input_tokens: 1000,
        max_tokens_per_turn: 2000,
        max_tokens_per_conversation: 4000,
        max_tokens_per_day: 8000,
      },
    })

    assert.equal(frame.frame_type, "token_budget_frame")
    assert.equal(frame.decision, "allowed")
    assert.equal(frame.violations.length, 0)
    assert.equal(frame.privacy.raw_user_text_logged, false)
  })

  it("blocks oversized input before runtime execution", () => {
    const frame = budgetPolicy.assessTokenBudget({
      userId: "user_budget_block",
      conversationId: "conv_budget_block",
      userPlan: "FREE",
      userMessage: "x".repeat(2000),
      selectedModel: { provider: "openai", modelId: "gpt-5-mini" },
      caps: {
        max_input_tokens: 10,
        max_tokens_per_turn: 20,
        max_tokens_per_conversation: 30,
        max_tokens_per_day: 40,
      },
    })

    assert.equal(frame.decision, "blocked")
    assert.ok(frame.violations.some((violation: any) => violation.code === "input_tokens_exceeded"))
    assert.ok(frame.violations.some((violation: any) => violation.code === "turn_tokens_exceeded"))
  })

  it("supports observe mode so rollout can measure without blocking", () => {
    const frame = budgetPolicy.assessTokenBudget({
      userId: "user_budget_observe",
      conversationId: "conv_budget_observe",
      userPlan: "FREE",
      userMessage: "x".repeat(2000),
      mode: "observe",
      caps: {
        max_input_tokens: 10,
        max_tokens_per_turn: 20,
        max_tokens_per_conversation: 30,
        max_tokens_per_day: 40,
      },
    })

    assert.equal(frame.decision, "allowed")
    assert.equal(frame.enforcement_mode, "observe")
    assert.ok(frame.violations.length > 0)
  })

  it("uses ledger summaries to enforce conversation and daily caps", () => {
    const ledger = tokenLedger.createInMemoryTokenLedger()
    ledger.record(tokenLedger.buildTokenUsageFrame({
      envelope: {
        request_id: "req_prior_budget",
        conversation_id: "conv_budget_existing",
        user_id: "user_budget_existing",
        intent_analysis: { primary_intent: { id: "general_question" }, task_family: "conversation" },
      },
      userMessage: "pregunta anterior",
      selectedModel: { provider: "openai", modelId: "gpt-5-mini" },
      providerUsage: { input_tokens: 100, output_tokens: 50 },
      responseText: "respuesta anterior",
    }))

    const frame = budgetPolicy.assessTokenBudget({
      userId: "user_budget_existing",
      conversationId: "conv_budget_existing",
      userMessage: "nueva pregunta",
      tokenLedger: ledger,
      caps: {
        max_input_tokens: 1000,
        max_tokens_per_turn: 2000,
        max_tokens_per_conversation: 150,
        max_tokens_per_day: 150,
      },
    })

    assert.equal(frame.current_usage.ledger_available, true)
    assert.equal(frame.decision, "blocked")
    assert.ok(frame.violations.some((violation: any) => violation.code === "conversation_tokens_exceeded"))
    assert.ok(frame.violations.some((violation: any) => violation.code === "daily_tokens_exceeded"))
  })
})

describe("sira chat controller token budget preflight", () => {
  it("blocks expensive turns before the engine runs and audits the decision", async () => {
    const audits: any[] = []
    const adapter = createInMemoryStorage()
    const appendAudit = adapter.appendAudit.bind(adapter)
    adapter.appendAudit = async (entry: any) => {
      audits.push(entry)
      return appendAudit(entry)
    }
    const storage = createSiraStorage({
      adapter,
      idFactory: (prefix: string) => `${prefix}_budget_test_${audits.length}_${Date.now()}`,
    })

    const result = await handleChatTurn({
      conversationId: "conv_budget_chat",
      userId: "user_budget_chat",
      userMessage: "x".repeat(2000),
      selectedModel: { provider: "openai", modelId: "gpt-5-mini" },
      bypassSessionQueue: true,
      dryRun: true,
    }, {
      storage,
      tokenBudgetCaps: {
        max_input_tokens: 10,
        max_tokens_per_turn: 20,
        max_tokens_per_conversation: 30,
        max_tokens_per_day: 40,
      },
    })

    assert.equal(result.stage, "token_budget_exceeded")
    assert.equal(result.token_budget.decision, "blocked")
    assert.ok(result.persisted_ids.user_message_id)
    assert.ok(result.persisted_ids.assistant_message_id)
    assert.ok(audits.some(entry => entry.eventType === "token_budget_checked"))
    assert.ok(audits.some(entry => entry.eventType === "turn_blocked_token_budget"))
    assert.ok(!audits.some(entry => entry.eventType === "token_usage_recorded"))
    assert.deepEqual(adapter.counts(), {
      conversations: 0,
      messages: 2,
      envelopes: 0,
      tool_calls: 0,
      artifacts: 0,
      validation_reports: 0,
      audit_logs: 3,
    })
  })
})
