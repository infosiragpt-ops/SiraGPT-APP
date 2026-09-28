import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  OWNED_ELSEWHERE_PHASES,
  answerTextForCounter,
  countWords,
  createIncrementalWordCounter,
  formatCount,
  formatStepDuration,
  hasAgentSentinel,
  isGenericThinkingLabel,
  latestReasoningHeadline,
  mentionsDuration,
} from "../lib/chat/live-progress"

describe("live progress helpers (thinking timeline)", () => {
  it("counts words, and the incremental counter always equals a full recount", () => {
    assert.equal(countWords(""), 0)
    assert.equal(countWords("   "), 0)
    assert.equal(countWords("Hola mundo"), 2)
    assert.equal(countWords("  uno\n\ndos\ttres  "), 3)
    assert.equal(countWords(undefined), 0)

    const count = createIncrementalWordCounter()
    const text = "El contrato establece un plazo de doce meses, renovable por acuerdo mutuo.\n\nLa cláusula 4 fija la penalidad."
    let prefix = ""
    // Chunks that split words in half, start with spaces, end with spaces…
    for (const chunk of ["El contr", "ato estab", "lece un ", " plazo de doce", " meses, renovable", " por acuerdo mutuo.\n", "\nLa cláu", "sula 4 fija la penalidad."]) {
      prefix += chunk
      assert.equal(count(prefix), countWords(prefix), JSON.stringify(prefix))
    }
    assert.equal(count(prefix), 18)
    // A replaced answer (regenerate / onReplace) falls back to a full recount.
    assert.equal(count("Otra respuesta corta"), 3)
    assert.equal(count(""), 0)
  })

  it("groups counts the Spanish way, by hand (es does not group 4 digits)", () => {
    assert.equal(formatCount(420), "420")
    assert.equal(formatCount(1240), "1.240")
    assert.equal(formatCount(12340), "12.340")
    assert.equal(formatCount(1234567), "1.234.567")
    assert.equal(formatCount(-3), "0")
    assert.equal(formatCount(Number.NaN), "0")
  })

  it("formats step durations: 180 ms · 1,8 s · 12 s · 1 min 5 s", () => {
    assert.equal(formatStepDuration(180), "180 ms")
    assert.equal(formatStepDuration(1840), "1,8 s")
    assert.equal(formatStepDuration(2000), "2 s")
    assert.equal(formatStepDuration(12000), "12 s")
    assert.equal(formatStepDuration(65000), "1 min 5 s")
    assert.equal(formatStepDuration(120000), "2 min")
    assert.equal(formatStepDuration(999.7), "1 s")
    assert.equal(formatStepDuration(undefined), "")
    assert.equal(formatStepDuration(-1), "")
    assert.equal(formatStepDuration(Number.NaN), "")
    // The decimal separator follows the UI locale; Spanish is the default.
    assert.equal(formatStepDuration(1840, "es"), "1,8 s")
    assert.equal(formatStepDuration(1840, "en"), "1.8 s")
    assert.equal(formatStepDuration(1840, "de"), "1,8 s")
    assert.equal(formatStepDuration(1840, "not a locale!"), "1,8 s")
  })

  it("spots a duration already written in a label (no second, differently measured one)", () => {
    for (const text of ["DeepSeek V4 Pro empezó a razonar · 3,2 s", "Decidió en 6.2 s: buscar", "400 ms", "listo en 12s", "1 min 5 s"]) {
      assert.equal(mentionsDuration(text), true, text)
    }
    for (const text of ["Leyendo 3 archivos", "2 semanas de datos", "Paso 12 de 20", "v4s", "", undefined]) {
      assert.equal(mentionsDuration(text), false, String(text))
    }
  })

  it("treats only a bare «Pensando…» as generic (canned phrases are the fallback)", () => {
    for (const label of ["Pensando", "Pensando…", "pensando...", "  Pensando…  ", "Thinking…", "", null, undefined]) {
      assert.equal(isGenericThinkingLabel(label), true, String(label))
    }
    for (const label of ["Leyendo «contrato.pdf»", "Pensando la estructura del informe", "Buscando en la web · “cobre 2026”", "Conectando con DeepSeek V4 Pro"]) {
      assert.equal(isGenericThinkingLabel(label), false, label)
    }
  })

  it("headlines the live reasoning: first sentence of the last paragraph, markdown stripped, ≤120 chars", () => {
    assert.equal(latestReasoningHeadline(""), "")
    assert.equal(latestReasoningHeadline("   \n\n "), "")
    const reasoning = "The user wants a summary. I will read the file.\n\n**Now** I need to check the `penalty` clause. Then compare dates.\n\n"
    assert.equal(latestReasoningHeadline(reasoning), "Now I need to check the penalty clause.")
    // An unfinished paragraph (still streaming) is its own headline.
    assert.equal(latestReasoningHeadline("Done.\n\n## Revisando las fechas del anexo"), "Revisando las fechas del anexo")
    assert.equal(latestReasoningHeadline("- Primero, [la fuente](https://x.y) dice algo."), "Primero, la fuente dice algo.")
    const long = latestReasoningHeadline("a".repeat(300))
    assert.equal(long.length, 120)
    assert.ok(long.endsWith("…"))
  })

  it("counts only the answer: the agent-task-state sentinel is stripped", () => {
    const sentinel = "```agent-task-state\n{\"steps\":[{\"id\":\"a\",\"label\":\"Buscando\"}],\"done\":false}\n```"
    assert.equal(answerTextForCounter(`${sentinel}\n\nHola mundo`), "Hola mundo")
    assert.equal(answerTextForCounter(sentinel), "")
    assert.equal(answerTextForCounter("```agent-task-state\n{\"steps\":["), "", "an unterminated sentinel is not prose")
    assert.equal(answerTextForCounter("Respuesta normal\n```js\ncode\n```"), "Respuesta normal\n```js\ncode\n```")
    assert.equal(answerTextForCounter(undefined), "")
    assert.equal(countWords(answerTextForCounter(`${sentinel}\n\nUna dos tres`)), 3)
    assert.equal(hasAgentSentinel(sentinel), true)
    assert.equal(hasAgentSentinel(`${sentinel}\n\nHola`), true)
    assert.equal(hasAgentSentinel("Hola\n```agent-task-state\n{}\n```"), false, "only a leading sentinel")
    assert.equal(hasAgentSentinel(undefined), false)
  })

  it("leaves the agent-loop phases to AgenticSteps / AgentTrace", () => {
    assert.ok(OWNED_ELSEWHERE_PHASES.has("agent_step"))
    assert.ok(OWNED_ELSEWHERE_PHASES.has("agent_model"))
    assert.ok(!OWNED_ELSEWHERE_PHASES.has("attachments"))
  })
})
