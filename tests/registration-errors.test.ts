import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  emailRuleKey,
  mapRegistrationErrorData,
  nameRuleKey,
  passwordRuleKey,
} from "../lib/auth/registration-errors"

const t = (key: string) => `t:${key}`

describe("registration form rules (mirror of backend RegisterRequestSchema)", () => {
  it("password: 8–128 characters with a letter and a number, like the server", () => {
    assert.equal(passwordRuleKey("abc123"), "passwordTooShort", "6 characters passed the old client check and failed the server")
    assert.equal(passwordRuleKey("abcdefgh"), "passwordNeedsNumber")
    assert.equal(passwordRuleKey("12345678"), "passwordNeedsLetter")
    assert.equal(passwordRuleKey("a".repeat(129) + "1"), "passwordTooLong")
    assert.equal(passwordRuleKey("clave2026"), null)
  })

  it("name and email rules", () => {
    assert.equal(nameRuleKey("  "), "nameRequired")
    assert.equal(nameRuleKey("L"), "nameTooShort")
    assert.equal(nameRuleKey("x".repeat(101)), "nameTooLong")
    assert.equal(nameRuleKey("Luis Carrera"), null)
    assert.equal(emailRuleKey("luis@"), "emailInvalid")
    assert.equal(emailRuleKey("luis@siragpt.com"), null)
  })
})

describe("mapRegistrationErrorData (server 400 → inline field messages)", () => {
  it("maps zod codes from validateBody to the field they belong to", () => {
    const mapped = mapRegistrationErrorData(
      {
        error: "Validation failed",
        code: "validation_failed",
        validation: [
          { field: "password", code: "auth.password.needs_number", message: "auth.password.needs_number" },
          { field: "name", code: "auth.name.too_short" },
        ],
      },
      t,
    )
    assert.deepEqual(mapped.fieldErrors, { password: "t:passwordNeedsNumber", name: "t:nameTooShort" })
    assert.equal(mapped.message, null, "field errors replace the generic toast")
  })

  it("«User already exists» becomes an email hint, with or without the new code", () => {
    assert.deepEqual(mapRegistrationErrorData({ error: "User already exists" }, t).fieldErrors, { email: "t:emailInUse" })
    assert.deepEqual(mapRegistrationErrorData({ error: "User already exists", code: "auth.email.in_use" }, t).fieldErrors, { email: "t:emailInUse" })
  })

  it("keeps a readable server message for the toast when nothing maps to a field", () => {
    const mapped = mapRegistrationErrorData({ error: "registration_disabled", message: "El registro está deshabilitado." }, t)
    assert.deepEqual(mapped.fieldErrors, {})
    assert.equal(mapped.message, "El registro está deshabilitado.")
    assert.equal(mapRegistrationErrorData({ error: "Validation failed" }, t).message, null)
    assert.equal(mapRegistrationErrorData(undefined, t).message, null)
  })

  it("unknown codes fall back to the field's generic message or the server text", () => {
    const mapped = mapRegistrationErrorData(
      { validation: [{ field: "body.email", code: "auth.email.disposable", message: "Correo desechable no permitido" }, { field: "password", code: "auth.password.other" }] },
      t,
    )
    assert.deepEqual(mapped.fieldErrors, { email: "Correo desechable no permitido", password: "t:passwordTooShort" })
  })
})
