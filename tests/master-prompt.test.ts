import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"

// The backend is CommonJS JavaScript — we load it via require() rather
// than `import`, so TypeScript doesn't try to type-check files outside
// the tests/ include list. createRequire anchors resolution to THIS
// source file's path so the relative jump is stable regardless of
// where the test-dist directory ends up.
const cjsRequire = createRequire(__filename)

type IntentResult = { intent: string; context: string }

type MasterPrompt = {
  classifyIntent: (msg: string) => IntentResult
  buildUserProfileBlock: (profile: unknown) => string
  buildUserIntentAlignmentProfile: (opts: { request: string; fileIds?: string[] }) => {
    taxonomy: string
    outputMode: string
    requestedFormat: string | null
    groundingMode: string
    hardConstraints: string[]
    responsePolicy: string[]
  }
  buildSystemPrompt: (opts: {
    language?: string
    userMessage?: string
    customGpt?: { name: string; instructions?: string }
    userProfile?: { name?: string; locale?: string; preferredTone?: string; customInstructions?: string }
    fileIds?: string[]
  }) => { system: string; intent: string; language: string; alignmentProfile?: Record<string, unknown> }
  ABSOLUTE_RULES: string
}

const masterPrompt = cjsRequire("../../backend/src/services/master-prompt") as MasterPrompt

describe("master-prompt · classifyIntent", () => {
  it("tags a Word-document request as GENERATE_DOCUMENT", () => {
    assert.equal(masterPrompt.classifyIntent("genera un documento word sobre la revolución industrial").intent, "GENERATE_DOCUMENT")
  })

  it("tags a flowchart request as GENERATE_VISUAL", () => {
    assert.equal(masterPrompt.classifyIntent("dibuja un flowchart del proceso de checkout").intent, "GENERATE_VISUAL")
  })

  it("tags a code-fix request as CODE_EXECUTION", () => {
    assert.equal(masterPrompt.classifyIntent("fix this python bug that throws ValueError").intent, "CODE_EXECUTION")
  })

  it("falls back to GENERAL_CHAT when nothing matches", () => {
    assert.equal(masterPrompt.classifyIntent("hola qué tal cómo va todo").intent, "GENERAL_CHAT")
  })

  it("does NOT trigger GENERATE_DOCUMENT on a pasted paragraph that just happens to mention 'informe' or 'reporte'", () => {
    // Regression: a user pastes a paragraph about operational efficiency
    // and the loose old pattern matched "redacta un informe" somewhere
    // inside. Model wrapped the whole reply in [CREATE_DOCUMENT] and the
    // chat message came back blank. Must stay GENERAL_CHAT now.
    const pasted = "La gestión de inventarios es clave para la eficiencia operativa. Redacta un informe detallado sobre los principales desafíos que enfrentan las empresas en este ámbito y propón soluciones."
    assert.notEqual(masterPrompt.classifyIntent(pasted).intent, "GENERATE_DOCUMENT")
  })

  it("still triggers GENERATE_DOCUMENT on an explicit file request", () => {
    assert.equal(masterPrompt.classifyIntent("crea un documento word sobre la revolución industrial").intent, "GENERATE_DOCUMENT")
    assert.equal(masterPrompt.classifyIntent("hazme un pdf con las conclusiones").intent, "GENERATE_DOCUMENT")
    assert.equal(masterPrompt.classifyIntent("exportar como excel").intent, "GENERATE_DOCUMENT")
  })
})

describe("master-prompt · buildUserProfileBlock", () => {
  it("returns empty string for null / undefined profile", () => {
    assert.equal(masterPrompt.buildUserProfileBlock(null), "")
    assert.equal(masterPrompt.buildUserProfileBlock(undefined), "")
  })

  it("includes the user's name and tone when provided", () => {
    const block = masterPrompt.buildUserProfileBlock({ name: "Luis", preferredTone: "formal" })
    assert.match(block, /## USER PROFILE/)
    assert.match(block, /Name: Luis/)
    assert.match(block, /Preferred tone: formal/)
  })
})

describe("master-prompt · buildSystemPrompt", () => {
  const built = masterPrompt.buildSystemPrompt({ language: "es", userMessage: "hola" })

  it("prepends the LANGUAGE POLICY header so it wins any later drift", () => {
    assert.match(built.system, /LANGUAGE POLICY/i)
    assert.ok(built.system.indexOf("LANGUAGE POLICY") < built.system.indexOf("ABSOLUTE RULES"))
  })

  it("includes the VISUAL ARTIFACTS auto-rendering contract", () => {
    assert.match(built.system, /VISUAL ARTIFACTS RULE/)
  })

  it("includes the 3D scene pattern (Three.js importmap)", () => {
    assert.match(built.system, /3D SCENE PATTERN/)
    assert.match(built.system, /importmap/)
    assert.match(built.system, /OrbitControls/)
  })

  it("includes the architectural / floor plan pattern (SVG + grid)", () => {
    assert.match(built.system, /ARCHITECTURAL \/ FLOOR PLAN PATTERN/)
    assert.match(built.system, /preserveAspectRatio/)
    assert.match(built.system, /viewBox/)
  })

  it("injects a compact InstructGPT-style intent alignment profile", () => {
    const withFile = masterPrompt.buildSystemPrompt({
      language: "es",
      userMessage: "dame un resumen",
      fileIds: ["uploaded-docx"],
    })
    assert.match(withFile.system, /USER INTENT ALIGNMENT/)
    assert.match(withFile.system, /private_context_required/)
    assert.match(withFile.system, /do_not_fabricate_sources_or_claims/)
    assert.equal(withFile.alignmentProfile?.groundingMode, "private_context_required")
  })
})

describe("master-prompt · research route config", () => {
  it("loads the research route module without syntax errors", () => {
    const mod = cjsRequire("../../backend/src/routes/research")
    assert.ok(mod, "research route should export an Express router")
    assert.equal(typeof mod, "function", "exported Express router is a function-like object")
  })
})
