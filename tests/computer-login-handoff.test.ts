import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

import {
  EXAMPLE_AUTHENTICATED_TASKS,
  isPasswordPasteRequest,
  LOGIN_HANDOFF_COPY,
  LOGIN_HANDOFF_WINDOW_EVENT,
  overlayLayoutContract,
  routeAuthenticatedComputerTask,
} from "../lib/computer-login-handoff"

const cjsRequire = createRequire(path.join(process.cwd(), "package.json"))
const handoff = cjsRequire("./backend/src/services/computer/login-handoff") as {
  REDACTED: string
  LOGIN_HANDOFF_CODE: string
  POLICY_ES: string
  isSecretField: (field: object, opts?: object) => boolean
  redactSecretsFromText: (text: string, opts?: object) => string
  detectLoginGate: (input: object) => { gated: boolean; code: string | null }
  refuseAgentType: (input: object) => { refuse: boolean; ok: boolean; code?: string; text?: string; message?: string }
  resetTakeoverForTests: () => void
  beginTakeover: (input: object) => object
  endTakeover: (input: object) => { active: boolean }
  redactToolArgs: (args: object) => Record<string, string>
  redactLogPayload: (payload: object) => object
  redactObservePayload: (payload: object) => {
    loginHandoff: boolean
    screenshotBlocked?: boolean
    png?: string | null
    metadata?: { password?: string }
  }
  assertCookiesIsolated: (a: unknown, b: unknown, ia: object, ib: object) => { ok: boolean; keyA?: string; keyB?: string }
  isAuthenticatedComputerTask: (prompt: string) => boolean
  modelMustNotAskPasswordInChat: (text: string) => boolean
}
const { resolveSessionIdentity } = cjsRequire("./backend/src/services/computer/member-key") as {
  resolveSessionIdentity: (user: { id: string }, conversationId: string) => {
    conversationBound: boolean
    sessionKey: string
    userId: string
    conversationId: string | null
  }
}

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")
const bootEs = "Arranca" + "ndo"
const runEs = "Ejecu" + "tar"

const TYPES = ["password", "text", "tel", "number", "email", "hidden", "search", "url"] as const
const NAMES = [
  "password", "passwd", "pwd", "otp", "2fa", "totp", "cvv", "cvc", "csc",
  "username", "email", "login", "user", "q", "comment",
] as const
const AUTOS = [
  "current-password", "new-password", "one-time-code", "cc-csc", "cc-number",
  "username", "email", "off", "on",
] as const
const SECRET = "SuperSecretValue-12345"

type FieldFix = { type: string; name: string; autocomplete: string; expectSecret: boolean }

function expectSecret(type: string, name: string, autocomplete: string): boolean {
  if (type === "password") return true
  if (/password|passwd|pwd|otp|2fa|totp|cvv|cvc|csc/.test(name)) return true
  if (/password|one-time-code|cc-csc|cc-number/.test(autocomplete)) return true
  return false
}

const FIELD_FIXTURES: FieldFix[] = []
for (const type of TYPES) {
  for (const name of NAMES) {
    for (const autocomplete of AUTOS) {
      FIELD_FIXTURES.push({
        type,
        name,
        autocomplete,
        expectSecret: expectSecret(type, name, autocomplete),
      })
    }
  }
}

const LOGIN_DOMS = [
  `<form><input type="password" name="password" value="${SECRET}"><input name="username" value="valeria"></form>`,
  `<form id="login"><input type="text" name="email" autocomplete="username" value="a@b.c"><input type="password" autocomplete="current-password" value="${SECRET}"></form>`,
  `<div>Sign in with Google</div><button>Continuar con Google</button>`,
  `<div class="g-recaptcha">I'm not a robot</div>`,
  `<label>Código de verificación</label><input name="otp" autocomplete="one-time-code" value="482913">`,
  `<form><input name="cardNumber" autocomplete="cc-number" value="4111111111111111"><input name="cvv" autocomplete="cc-csc" value="123"></form>`,
  `textbox "Password" = ${SECRET}`,
  `url: https://accounts.google.com/signin\ntitle: Sign in\ntextbox "Email"\ntextbox "Password" type=password = ${SECRET}`,
  `<input type="password" id="passwd" name="passwd" value="${SECRET}">`,
  `<input type="tel" name="totp" value="918273">`,
]

describe("computer login handoff · combinatorial redaction", () => {
  it(`enumerates ${FIELD_FIXTURES.length} field fixtures (need 1000+)`, () => {
    assert.ok(FIELD_FIXTURES.length >= 1000, `got ${FIELD_FIXTURES.length}`)
  })

  const batchSize = 50
  for (let i = 0; i < FIELD_FIXTURES.length; i += batchSize) {
    const batch = FIELD_FIXTURES.slice(i, i + batchSize)
    it(`redacts or preserves field batch ${i / batchSize + 1} (${batch.length})`, () => {
      for (const fix of batch) {
        const field = { type: fix.type, name: fix.name, autocomplete: fix.autocomplete, value: SECRET }
        const secret = handoff.isSecretField(field, { inLoginForm: /user|email|login|password|otp|cvv/.test(fix.name) })
        const html = `<input type="${fix.type}" name="${fix.name}" autocomplete="${fix.autocomplete}" value="${SECRET}">`
        const redacted = handoff.redactSecretsFromText(html, { inLoginForm: secret || fix.expectSecret })
        if (fix.expectSecret || secret) {
          assert.equal(handoff.isSecretField(field, { inLoginForm: true }), true, JSON.stringify(fix))
          assert.doesNotMatch(redacted, new RegExp(SECRET), JSON.stringify(fix))
          const typed = handoff.refuseAgentType({
            toolName: "computer_type",
            text: SECRET,
            focused: { ...field, focused: true },
          })
          assert.equal(typed.refuse, true, `type must refuse ${JSON.stringify(fix)}`)
          assert.equal(typed.text, undefined)
          assert.match(String(typed.message), /contrase/)
        } else if (fix.type !== "password" && !/password|otp|cvv|cvc|csc|passwd|pwd|2fa|totp/.test(fix.name + fix.autocomplete)) {
          assert.equal(handoff.isSecretField(field), false, JSON.stringify(fix))
        }
      }
    })
  }

  for (const [idx, dom] of LOGIN_DOMS.entries()) {
    it(`login DOM fixture ${idx} never leaks secret into model text`, () => {
      const redacted = handoff.redactSecretsFromText(dom, { inLoginForm: true })
      assert.doesNotMatch(redacted, new RegExp(SECRET))
      assert.doesNotMatch(redacted, /482913|918273|4111111111111111/)
      const gate = handoff.detectLoginGate({ text: dom, url: "https://portal.example/login", title: "Iniciar sesión" })
      assert.equal(gate.gated, true)
      assert.equal(gate.code, handoff.LOGIN_HANDOFF_CODE)
    })
  }
})

describe("computer login handoff · type refusal & takeover", () => {
  it("refuses computer_type into a focused password field", () => {
    handoff.resetTakeoverForTests()
    const out = handoff.refuseAgentType({
      toolName: "computer_type",
      text: "hunter2",
      focused: { type: "password", name: "password", focused: true },
    })
    assert.equal(out.refuse, true)
    assert.equal(out.ok, false)
    assert.equal(out.code, "login_handoff_required")
    assert.doesNotMatch(JSON.stringify(out), /hunter2/)
  })

  it("refuses type while user takeover is active", () => {
    handoff.resetTakeoverForTests()
    const identity = resolveSessionIdentity({ id: "user_alpha" }, "chat-login-1")
    handoff.beginTakeover({ identity, conversationId: "chat-login-1", kind: "password", reason: "login_form" })
    const out = handoff.refuseAgentType({
      toolName: "computer_type",
      text: "hello",
      identity,
      conversationId: "chat-login-1",
    })
    assert.equal(out.refuse, true)
    const after = handoff.endTakeover({ identity, conversationId: "chat-login-1" })
    assert.equal(after.active, false)
    const resume = handoff.refuseAgentType({
      toolName: "computer_type",
      text: "hello",
      identity,
      conversationId: "chat-login-1",
    })
    assert.equal(resume.refuse, false)
  })

  it("redacts tool args and logs so secrets never reach analytics", () => {
    const args = handoff.redactToolArgs({ text: "password: hunter2", password: "hunter2", otp: "123456" })
    assert.equal(args.password, handoff.REDACTED)
    assert.equal(args.otp, handoff.REDACTED)
    const log = handoff.redactLogPayload({ args: { password: "hunter2" }, typed: "hunter2", name: "computer_type" })
    const dumped = JSON.stringify(log)
    assert.doesNotMatch(dumped, /hunter2/)
  })

  it("observe payload strips password values and can block screenshots of focused secrets", () => {
    const out = handoff.redactObservePayload({
      text: `textbox "Password" = ${SECRET}`,
      url: "https://seguro.example/login",
      title: "Iniciar sesión",
      focused: { type: "password", name: "password", focused: true },
      png: "BASE64PNG",
      ocrText: `password: ${SECRET}`,
      metadata: { password: SECRET, note: "ok" },
    })
    assert.doesNotMatch(JSON.stringify(out), new RegExp(SECRET))
    assert.equal(out.loginHandoff, true)
    assert.equal(out.screenshotBlocked, true)
    assert.equal(out.png, null)
    assert.equal(out.metadata?.password, handoff.REDACTED)
  })
})

describe("computer login handoff · conversationBound cookies", () => {
  it("chat A cookies are not used for chat B", () => {
    const user = { id: "user_shared" }
    const a = resolveSessionIdentity(user, "chat-aaa")
    const b = resolveSessionIdentity(user, "chat-bbb")
    assert.equal(a.conversationBound, true)
    assert.equal(b.conversationBound, true)
    assert.notEqual(a.sessionKey, b.sessionKey)
    assert.notEqual(a.userId, b.userId)
    const jarA = new Map([["sessionid", "cookie-A-secret"]])
    const jarB = new Map([["sessionid", "cookie-B-other"]])
    const isolated = handoff.assertCookiesIsolated(jarA, jarB, a, b)
    assert.equal(isolated.ok, true)
    assert.notEqual(isolated.keyA, isolated.keyB)
    const leaked = handoff.assertCookiesIsolated(jarA, jarA, a, a)
    assert.equal(leaked.ok, false)
  })
})

describe("computer login handoff · example tasks route through computer not chat passwords", () => {
  for (const prompt of EXAMPLE_AUTHENTICATED_TASKS) {
    it(`routes: ${prompt.slice(0, 48)}`, () => {
      const routed = routeAuthenticatedComputerTask(prompt)
      assert.equal(routed.useComputer, true, prompt)
      assert.equal(routed.loginHandoff, true, prompt)
      assert.equal(routed.askPasswordInChat, false, prompt)
      assert.equal(routed.openComputerInstead, true, prompt)
      assert.equal(handoff.isAuthenticatedComputerTask(prompt), true, prompt)
      assert.equal(isPasswordPasteRequest("abre la computadora e inicia sesión"), false)
      assert.equal(isPasswordPasteRequest("pega tu password: hunter2 en el chat"), true)
      assert.equal(handoff.modelMustNotAskPasswordInChat("Inicia sesión en el equipo. SiraGPT no ve tu contraseña."), true)
    })
  }

  it("model-side 'password: x' is not how login works", () => {
    assert.equal(handoff.modelMustNotAskPasswordInChat("password: hunter2"), true)
    assert.equal(isPasswordPasteRequest("escríbeme tu contraseña aquí"), true)
    assert.match(handoff.POLICY_ES, /NUNCA pidas/)
    assert.match(handoff.POLICY_ES, /computadora/)
    assert.match(handoff.POLICY_ES, /No inventes integraciones por sitio/)
  })
})

describe("computer login handoff · overlay layout contracts", () => {
  it("full screen on a narrow phone viewport with 44px tap targets", () => {
    const mobile = overlayLayoutContract(390)
    assert.equal(mobile.mobile, true)
    assert.equal(mobile.fullScreen, true)
    assert.equal(mobile.minTapPx, 44)
    assert.equal(mobile.overlayPosition, "fixed-inset-0")
    assert.equal(mobile.noClippedChrome, true)
    const desktop = overlayLayoutContract(1280)
    assert.equal(desktop.mobile, false)
    assert.equal(desktop.fullScreen, false)
    assert.equal(desktop.overlayPosition, "panel")
  })
})

describe("computer login handoff · source & Spanish chrome", () => {
  it("ships banner, panel, policy, and Spanish copy", () => {
    assert.equal(existsSync("components/chat/computer-login-handoff-banner.tsx"), true)
    assert.equal(existsSync("backend/src/services/computer/login-handoff.js"), true)
    const banner = source("components/chat/computer-login-handoff-banner.tsx")
    const panel = source("components/chat/chat-agent-computer-panel.tsx")
    const chat = source("components/chat-interface-enhanced.tsx")
    const computer = source("backend/src/services/agent-runner/multimodal/computer.js")
    const stream = source("backend/src/services/agentic-chat-stream.js")
    const route = source("backend/src/routes/agent-computer.js")
    const es = JSON.parse(source("messages/es.json"))
    assert.match(banner, /data-testid="computer-login-handoff-banner"/)
    assert.match(banner, /data-testid="computer-login-handoff-ready"/)
    assert.match(banner, /SiraGPT no ve tu contraseña|LOGIN_HANDOFF_COPY/)
    assert.match(panel, /ComputerLoginHandoffBanner/)
    assert.match(panel, /login-handoff/)
    assert.match(chat, /LOGIN_HANDOFF_WINDOW_EVENT/)
    assert.match(chat, /loginHandoff/)
    assert.match(computer, /loginHandoff.refuseAgentType/)
    assert.match(computer, /NUNCA escribas contraseñas/)
    assert.match(stream, /login-handoff/)
    assert.match(route, /login-handoff/)
    assert.equal(es.codex.panel.agentComputer.loginHandoff.title, LOGIN_HANDOFF_COPY.title)
    assert.equal(es.codex.panel.agentComputer.loginHandoff.neverSees, LOGIN_HANDOFF_COPY.neverSees)
    assert.equal(es.codex.panel.agentComputer.loginHandoff.ready, LOGIN_HANDOFF_COPY.ready)
    assert.equal(LOGIN_HANDOFF_WINDOW_EVENT, "siragpt:computer-login-handoff")
  })

  it("keeps overlay professional and never Ejecutar/Arrancando", () => {
    const files = [
      "components/chat/computer-login-handoff-banner.tsx",
      "components/chat/chat-agent-computer-panel.tsx",
      "lib/computer-login-handoff.ts",
    ]
    for (const file of files) {
      const src = source(file)
      assert.doesNotMatch(src, new RegExp(bootEs, "i"), file)
      assert.doesNotMatch(src, new RegExp(runEs, "i"), file)
      assert.doesNotMatch(src, /Aislamiento por chat pendiente/)
      assert.doesNotMatch(src, /session key/)
      assert.doesNotMatch(src, /noVNC/)
      assert.doesNotMatch(src, /XFCE/)
    }
    const bars = source("components/pensando-bars.tsx")
    assert.match(bars, /#38BDF8/)
  })

  it("does not add OpenRouter computer models", () => {
    const flags = source("backend/src/services/computer/flags.js")
    assert.match(flags, /deepseek-v4-flash/)
    assert.match(flags, /openrouter/)
    const handoffSrc = source("backend/src/services/computer/login-handoff.js")
    assert.doesNotMatch(handoffSrc, /openrouter\.ai/)
  })
})
