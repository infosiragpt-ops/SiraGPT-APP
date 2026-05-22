import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  classifyAuthError,
  getAuthErrorMessage,
  getSafeAuthRedirectMessage,
  normalizeAuthErrorCode,
} from "../../lib/auth/auth-error-classifier"

describe("auth error classifier", () => {
  it("maps auth status codes to safe login states", () => {
    assert.equal(classifyAuthError({ status: 401 }).code, "invalid_credentials")
    assert.equal(classifyAuthError({ statusCode: 403 }).code, "invalid_credentials")
    assert.equal(classifyAuthError({ status: 419 }).code, "expired_session")
    assert.equal(classifyAuthError({ status: 429 }).code, "rate_limited")
  })

  it("maps network-style failures without exposing raw messages", () => {
    assert.equal(classifyAuthError({ status: 0 }).code, "network_error")
    assert.equal(classifyAuthError(new Error("Failed to fetch")).code, "network_error")
    assert.equal(classifyAuthError(new Error("Request timeout")).code, "network_error")
  })

  it("normalizes legacy redirect messages and explicit codes", () => {
    assert.equal(normalizeAuthErrorCode("expired_session"), "expired_session")
    assert.equal(normalizeAuthErrorCode("La sesión es inválida o expiró"), "expired_session")
    assert.equal(normalizeAuthErrorCode("Error de autenticación"), "oauth_failed")
    assert.equal(normalizeAuthErrorCode("Invalid credentials"), "invalid_credentials")
  })

  it("returns localized safe messages", () => {
    assert.equal(getAuthErrorMessage("invalid_credentials", "es-PE"), "Credenciales incorrectas")
    assert.equal(getAuthErrorMessage("invalid_credentials", "en-US"), "Invalid credentials")
  })

  it("does not reflect untrusted redirect text back to the user", () => {
    const message = getSafeAuthRedirectMessage("<script>alert(1)</script>", "es")

    assert.equal(message.includes("<script>"), false)
    assert.equal(message, "No se pudo iniciar sesión. Intenta otra vez.")
  })
})
