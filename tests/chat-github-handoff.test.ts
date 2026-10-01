import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isExplicitGithubConnectRequest, isGithubAuthorizeUrl, parseGithubConnectionPayload, GITHUB_RESUME_TEXT } from "../lib/chat/github-connect-handoff"

import { detectCodingIntent } from "../lib/software-build-intent"

describe("GitHub chat handoff admission", () => {
  it("continues the bound coding project without creating a project in a normal chat", () => {
    assert.equal(detectCodingIntent(GITHUB_RESUME_TEXT, { hasWorkspace: true }).kind, "followup")
    assert.equal(detectCodingIntent(GITHUB_RESUME_TEXT, { hasWorkspace: false }).active, false)
  })
  it("reserves only an explicit request, not explanations, negation or arbitrary GitHub work", () => {
    for (const text of ["Conecta mi GitHub", "pásame el link de GitHub para loguearme", "abre GitHub para iniciar sesión", "quiero conectar GitHub"]) assert.equal(isExplicitGithubConnectRequest(text), true, text)
    for (const text of ["cómo conectar GitHub", "explica OAuth en GitHub", "no conectes GitHub", "no quiero conectar GitHub", "revisa mi repositorio GitHub", "hola", "abre el correo", "no quiero que conectes GitHub", "no me abras GitHub", "do not connect GitHub", "don't open GitHub", "never authorize GitHub", "para qué sirve conectar GitHub", "desconecta GitHub", "abre https://github.com/owner/repo", "conecta el repositorio GitHub", "```conecta GitHub```"]) assert.equal(isExplicitGithubConnectRequest(text), false, text)
  })
  it("accepts only the official OAuth authorization endpoint with its server-issued state", () => {
    assert.equal(isGithubAuthorizeUrl("https://github.com/login/oauth/authorize?client_id=x&state=y"), true)
    for (const url of ["https://github.com/login", "https://github.com.evil.test/login/oauth/authorize?client_id=x&state=y", "http://github.com/login/oauth/authorize?client_id=x&state=y", "https://evil@github.com/login/oauth/authorize?client_id=x&state=y", "https://github.com/login/oauth/authorize?client_id=x"]) assert.equal(isGithubAuthorizeUrl(url), false)
  })
  it("drops arbitrary payload properties and rejects missing correlation", () => {
    const payload = { chatId: "c", handoffId: "c263cda8-0f8a-42cc-9546-3952e0ff992a" }
    assert.deepEqual(parseGithubConnectionPayload({ ...payload, url: "https://evil.test", token: "ignored" }), payload)
    for (const value of [null, {}, { ...payload, handoffId: "invented" }, { ...payload, chatId: "" }, { ...payload, chatId: "a".repeat(65) }, { ...payload, chatId: "../chat" }]) assert.equal(parseGithubConnectionPayload(value), null)
  })
})
