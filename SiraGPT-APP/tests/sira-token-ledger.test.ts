import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

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

describe("sira token ledger", () => {
  it("builds privacy-safe token usage frames by user, conversation, model and task", () => {
    const frame = tokenLedger.buildTokenUsageFrame({
      envelope: {
        request_id: "req_token_1",
        conversation_id: "conv_token_1",
        user_id: "user_token_1",
        intent_analysis: {
          primary_intent: { id: "pptx_generation" },
          task_family: "presentation_artifacts",
        },
      },
      userMessage: "crea una ppt profesional sobre marketing con 10 diapositivas",
      attachments: [
        {
          file_id: "file_1",
          filename: "brief.pdf",
          mime_type: "application/pdf",
          size_bytes: 1200,
          content: "no debe quedar registrado",
        },
      ],
      selectedModel: { provider: "deepseek", modelId: "deepseek-v4-flash" },
      runtimeResult: {
        tool_results: [{ tool: "create_pptx", status: "skipped_dry_run", output: { internal: "x" } }],
        artifact_frame: { artifacts: [{ artifact_id: "a1", type: "file", format: "pptx", status: "planned" }] },
        validation_frame: { checks: [{ name: "artifact_validator", status: "passed" }] },
      },
      responseText: "Presentacion preparada.",
    })

    assert.equal(frame.frame_type, "token_usage_frame")
    assert.equal(frame.dimensions.user_id, "user_token_1")
    assert.equal(frame.dimensions.conversation_id, "conv_token_1")
    assert.equal(frame.dimensions.provider, "deepseek")
    assert.equal(frame.dimensions.model_id, "deepseek-v4-flash")
    assert.equal(frame.dimensions.task_intent, "pptx_generation")
    assert.equal(frame.privacy.raw_user_text_logged, false)
    assert.equal(frame.privacy.raw_attachment_content_logged, false)
    assert.ok(frame.usage.total_tokens > 0)
  })

  it("summarizes usage across users, models and tasks", () => {
    const ledger = tokenLedger.createInMemoryTokenLedger()
    ledger.record(tokenLedger.buildTokenUsageFrame({
      envelope: {
        request_id: "req_a",
        conversation_id: "conv_a",
        user_id: "user_a",
        intent_analysis: { primary_intent: { id: "docx_generation" }, task_family: "document_artifacts" },
      },
      userMessage: "crea un word",
      selectedModel: { provider: "openai", modelId: "gpt-5-mini" },
      responseText: "ok",
    }))
    ledger.record(tokenLedger.buildTokenUsageFrame({
      envelope: {
        request_id: "req_b",
        conversation_id: "conv_b",
        user_id: "user_b",
        intent_analysis: { primary_intent: { id: "image_transcription" }, task_family: "conversation" },
      },
      userMessage: "transcribir imagen",
      selectedModel: { provider: "deepseek", modelId: "deepseek-v4-flash" },
      responseText: "texto",
    }))

    const userSummary = ledger.summarize({ userId: "user_a" })

    assert.equal(userSummary.records, 1)
    assert.ok(userSummary.totals.total_tokens > 0)
    assert.equal(userSummary.by_user.user_a.records, 1)
    assert.equal(userSummary.by_task.docx_generation.records, 1)
  })

  it("normalizes provider token usage so totals cannot be under-reported", () => {
    const frame = tokenLedger.buildTokenUsageFrame({
      providerUsage: {
        input_tokens: 120.9,
        output_tokens: 80.4,
        total_tokens: 50,
      },
      responseText: "ok",
    })

    assert.equal(frame.usage.provider_reported, true)
    assert.equal(frame.usage.provider_usage.input_tokens, 120)
    assert.equal(frame.usage.provider_usage.output_tokens, 80)
    assert.equal(frame.usage.provider_usage.total_tokens, 200)
    assert.ok(frame.usage.total_tokens >= 200)
  })

  it("evaluates token budgets without storing prompt content", () => {
    const frame = tokenLedger.buildTokenUsageFrame({
      userMessage: "x".repeat(400),
      responseText: "y".repeat(120),
    })

    const ok = tokenLedger.evaluateTokenBudget(frame, { maxTotalTokens: frame.usage.total_tokens * 2 })
    const warning = tokenLedger.evaluateTokenBudget(frame, {
      maxTotalTokens: frame.usage.total_tokens + 1,
      warnAtRatio: 0.5,
    })
    const exceeded = tokenLedger.evaluateTokenBudget(frame, { maxTotalTokens: 1 })

    assert.equal(ok.status, "ok")
    assert.equal(warning.status, "warning")
    assert.equal(exceeded.status, "exceeded")
    assert.equal(exceeded.remaining_tokens, 0)
  })
})

describe("sira chat controller token accounting", () => {
  it("records a token usage frame and audit event for completed chat turns", async () => {
    const audits: any[] = []
    const adapter = createInMemoryStorage()
    const appendAudit = adapter.appendAudit.bind(adapter)
    adapter.appendAudit = async (entry: any) => {
      audits.push(entry)
      return appendAudit(entry)
    }

    const storage = createSiraStorage({
      adapter,
      idFactory: (prefix: string) => `${prefix}_token_test_${audits.length}_${Date.now()}`,
    })
    const ledger = tokenLedger.createInMemoryTokenLedger()

    const result = await handleChatTurn({
      conversationId: "conv_token_chat",
      userId: "user_token_chat",
      userMessage: "crea un documento word profesional sobre marketing con referencias APA",
      selectedModel: { provider: "deepseek", modelId: "deepseek-v4-flash" },
      dryRun: true,
      bypassSessionQueue: true,
    }, { storage, tokenLedger: ledger })

    assert.ok(["delivered", "needs_repair"].includes(result.stage))
    assert.equal(result.token_usage.frame_type, "token_usage_frame")
    assert.equal(result.token_usage.dimensions.user_id, "user_token_chat")
    assert.equal(result.token_usage.dimensions.conversation_id, "conv_token_chat")
    assert.ok(result.summary.token_usage.total_tokens > 0)
    assert.equal(ledger.snapshot().length, 1)
    assert.equal(ledger.summarize({ userId: "user_token_chat" }).records, 1)
    assert.ok(audits.some(entry => entry.eventType === "token_usage_recorded"))
  })
})
