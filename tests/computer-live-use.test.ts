import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

import {
  HAS_COMPUTER_POLICY_ES,
  isLiveComputerUsePrompt,
  routeAuthenticatedComputerTask,
} from "../lib/computer-login-handoff"
import {
  classifyIntentFastPath,
  shouldRouteTextPromptThroughAgenticRuntime,
} from "../lib/ai-service"
import { isAgentComputerEnabled } from "../lib/agent-computer-flag"

const cjsRequire = createRequire(path.join(process.cwd(), "package.json"))
const handoff = cjsRequire("./backend/src/services/computer/login-handoff") as {
  HAS_COMPUTER_POLICY_ES: string
  POLICY_ES: string
  isLiveComputerUsePrompt: (prompt: string) => boolean
  routeAuthenticatedComputerTask: (prompt: string) => {
    useComputer: boolean
    loginHandoff: boolean
    askPasswordInChat: boolean
    openComputerInstead: boolean
    replyClass: string
  }
}
const masterPrompt = cjsRequire("./backend/src/services/master-prompt") as {
  buildSystemPrompt: (opts: { language?: string; userMessage?: string }) => { system: string; intent: string }
  SIRAGPT_PRODUCT_OPERATING_CONTRACT: string
}
const chatComputer = cjsRequire("./backend/src/services/computer/chat-computer-tools") as {
  HAS_COMPUTER_POLICY_ES: string
  COMPUTER_TOOL_NAMES: string[]
  shouldOfferComputerTools: (env?: Record<string, string>) => boolean
  buildChatComputerTools: (opts: { env?: Record<string, string>; userId?: string }) => Array<{ name: string }>
  offeredComputerToolNames: (env?: Record<string, string>) => string[]
}
const { extraToolDefinitions } = cjsRequire("./backend/src/services/agent-runner/multimodal") as {
  extraToolDefinitions: (opts: { env: Record<string, string> }) => Array<{ function: { name: string } }>
}

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

const SHOPPING = "abre tu computadora y búscame ofertas de prendas de vestir de mujer"

const COMPUTER_PHRASES = [
  SHOPPING,
  "abre tu computadora",
  "abre la computadora y busca zapatos",
  "busca en vivo ofertas de ropa de mujer",
  "búscame ofertas de prendas de vestir",
  "reserva un hotel en lima",
  "agenda una cita en el DMV",
  "renueva mi licencia en el DMV",
  "tramita el pasaporte",
  "abre el navegador y entra a amazon",
]

const NOT_COMPUTER = [
  "hola",
  "explícame cómo funciona React",
  "busca restaurantes cerca de mi",
  "consulta el clima actual de La Paz",
]

describe("live computer-use · shopping prompt must not cop out", () => {
  it("routes the live shopping prompt to computer-use / agent_task, not a no-computer class", () => {
    assert.equal(classifyIntentFastPath(SHOPPING), "agent_task")
    assert.equal(isLiveComputerUsePrompt(SHOPPING), true)
    assert.equal(handoff.isLiveComputerUsePrompt(SHOPPING), true)
    const routed = routeAuthenticatedComputerTask(SHOPPING)
    assert.equal(routed.useComputer, true)
    assert.equal(routed.replyClass, "computer_use")
    assert.notEqual(routed.replyClass, "no_computer")
    assert.equal(routed.askPasswordInChat, false)
    assert.equal(shouldRouteTextPromptThroughAgenticRuntime(SHOPPING, []), true)
    const backend = handoff.routeAuthenticatedComputerTask(SHOPPING)
    assert.equal(backend.useComputer, true)
    assert.equal(backend.replyClass, "computer_use")
  })

  it("system prompt / tool preamble HAS a computer and omits cop-out phrases", () => {
    const built = masterPrompt.buildSystemPrompt({ language: "es", userMessage: SHOPPING })
    const taskPrompt = source("backend/src/routes/agent-task.js")
    const stream = source("backend/src/services/agentic-chat-stream.js")
    const blobs = [
      HAS_COMPUTER_POLICY_ES,
      handoff.HAS_COMPUTER_POLICY_ES,
      handoff.POLICY_ES,
      masterPrompt.SIRAGPT_PRODUCT_OPERATING_CONTRACT,
      built.system,
      taskPrompt,
      stream,
    ]
    for (const blob of blobs) {
      assert.match(blob, /Cada chat TIENE una computadora en vivo/)
      assert.doesNotMatch(blob, /no tengo acceso a tu computadora/)
      assert.doesNotMatch(blob, /no live browser/)
    }
  })

  it("combinatorial live phrases all route to computer-use", () => {
    for (const phrase of COMPUTER_PHRASES) {
      assert.equal(isLiveComputerUsePrompt(phrase), true, phrase)
      assert.equal(handoff.isLiveComputerUsePrompt(phrase), true, phrase)
      assert.equal(classifyIntentFastPath(phrase), "agent_task", phrase)
      assert.equal(routeAuthenticatedComputerTask(phrase).useComputer, true, phrase)
      assert.equal(routeAuthenticatedComputerTask(phrase).replyClass, "computer_use", phrase)
      assert.equal(shouldRouteTextPromptThroughAgenticRuntime(phrase, []), true, phrase)
    }
    for (const phrase of NOT_COMPUTER) {
      assert.equal(isLiveComputerUsePrompt(phrase), false, phrase)
      assert.notEqual(classifyIntentFastPath(phrase), "agent_task", phrase)
    }
  })

  it("source contract: computer tools offered when AGENT_COMPUTER is on", () => {
    const off = { NODE_ENV: "test" }
    const on = { NODE_ENV: "test", SIRAGPT_AGENT_COMPUTER: "1", NEXT_PUBLIC_AGENT_COMPUTER: "1" }
    assert.equal(chatComputer.shouldOfferComputerTools(off), false)
    assert.equal(chatComputer.shouldOfferComputerTools(on), true)
    assert.equal(isAgentComputerEnabled({ NEXT_PUBLIC_AGENT_COMPUTER: "1" }), true)
    assert.equal(isAgentComputerEnabled({ NEXT_PUBLIC_AGENT_COMPUTER: "0" }), false)
    assert.equal(isAgentComputerEnabled({}), false)

    const offered = chatComputer.offeredComputerToolNames(on)
    for (const name of ["computer_screenshot", "computer_click", "computer_type", "computer_navigate", "computer_list_files", "computer_read_file", "computer_write_file", "computer_edit_file"]) {
      assert.ok(offered.includes(name), name)
    }
    const tools = chatComputer.buildChatComputerTools({ env: on, userId: "u1" })
    const names = tools.map((t) => t.name)
    for (const name of ["computer_screenshot", "computer_click", "computer_type", "computer_navigate", "computer_list_files", "computer_read_file", "computer_write_file", "computer_edit_file"]) {
      assert.ok(names.includes(name), `buildChatComputerTools missing ${name}`)
    }
    const f7 = extraToolDefinitions({ env: { ...on, SIRAGPT_AGENT_VISION: "0", SIRAGPT_AGENT_VOICE: "0" } })
    const f7Names = f7.map((d) => d.function.name)
    assert.ok(f7Names.includes("computer_screenshot"))
    assert.ok(f7Names.includes("computer_click"))
    assert.ok(f7Names.includes("computer_type"))

    const taskSrc = source("backend/src/services/agents/task-tools.js")
    assert.match(taskSrc, /chat-computer-tools/)
    assert.match(taskSrc, /shouldOfferComputerTools/)
    const streamSrc = source("backend/src/services/agentic-chat-stream.js")
    assert.match(streamSrc, /computer_screenshot/)
    assert.match(streamSrc, /computer_navigate/)
    const compose = source("docker-compose.prod.yml")
    assert.match(compose, /NEXT_PUBLIC_AGENT_COMPUTER: \$\{NEXT_PUBLIC_AGENT_COMPUTER:-1\}/)
    assert.match(compose, /SIRAGPT_AGENT_COMPUTER: \$\{SIRAGPT_AGENT_COMPUTER:-1\}/)
    const chat = source("components/chat-interface-enhanced.tsx")
    assert.match(chat, /isLiveComputerUsePrompt/)
    assert.match(chat, /openComputerPanel\(\)/)
    assert.doesNotMatch(source("backend/src/services/agents/agent-tools.js"), /No active browser driver/)
  })
})
