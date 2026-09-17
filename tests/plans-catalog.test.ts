import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  CONTACT_PLAN,
  PAID_PLAN,
  PAID_PLAN_CODE,
  PLAN_DISPLAY_NAMES,
  buildWhatsAppHref,
  describeCheckoutError,
  isPaidPlanCode,
  normalizeWhatsAppNumber,
  planDisplayName,
  resolveWhatsAppNumber,
} from "@/lib/plans-catalog"

/**
 * plans-catalog is the single source of truth for the two plans SiraGPT
 * sells (Pro $10/mes via Stripe, Hablemos via WhatsApp). These tests pin
 * the contract every plans surface relies on.
 */

describe("plans-catalog · catalog shape", () => {
  it("sells exactly one paid plan at 10 USD backed by PRO_MAX", () => {
    assert.equal(PAID_PLAN.code, "PRO_MAX")
    assert.equal(PAID_PLAN_CODE, "PRO_MAX")
    assert.equal(PAID_PLAN.priceUsd, 10)
    assert.equal(PAID_PLAN.name, "Pro")
    assert.ok(PAID_PLAN.features.length >= 4)
  })

  it("contact plan is Hablemos with no self-serve price", () => {
    assert.equal(CONTACT_PLAN.name, "Hablemos")
    assert.equal(CONTACT_PLAN.code, "ENTERPRISE")
    assert.equal("priceUsd" in CONTACT_PLAN, false)
    assert.match(CONTACT_PLAN.cta, /WhatsApp/)
  })

  it("maps every backend plan code to a human label (PRO_MAX shows as Pro)", () => {
    assert.equal(PLAN_DISPLAY_NAMES.PRO_MAX, "Pro")
    assert.equal(planDisplayName("PRO_MAX"), "Pro")
    assert.equal(planDisplayName("pro"), "Pro")
    assert.equal(planDisplayName("ENTERPRISE"), "Enterprise")
    assert.equal(planDisplayName(undefined), "Gratis")
    assert.equal(planDisplayName("SOMETHING_ELSE"), "Gratis")
  })

  it("isPaidPlanCode treats PRO / PRO_MAX / ENTERPRISE as paid", () => {
    assert.equal(isPaidPlanCode("PRO"), true)
    assert.equal(isPaidPlanCode("pro_max"), true)
    assert.equal(isPaidPlanCode("ENTERPRISE"), true)
    assert.equal(isPaidPlanCode("FREE"), false)
    assert.equal(isPaidPlanCode(null), false)
  })
})

describe("plans-catalog · WhatsApp links", () => {
  it("normalizes any formatting down to digits", () => {
    assert.equal(normalizeWhatsAppNumber("+51 999 123 456"), "51999123456")
    assert.equal(normalizeWhatsAppNumber("(51) 999-123-456"), "51999123456")
    assert.equal(normalizeWhatsAppNumber(""), null)
    assert.equal(normalizeWhatsAppNumber("12345"), null)
    assert.equal(normalizeWhatsAppNumber(undefined), null)
  })

  it("builds a wa.me link with the encoded message", () => {
    const href = buildWhatsAppHref("+51 999 123 456", "Hola, quiero el plan Pro")
    assert.equal(href, "https://wa.me/51999123456?text=Hola%2C%20quiero%20el%20plan%20Pro")
  })

  it("omits the text query when the message is empty", () => {
    assert.equal(buildWhatsAppHref("51999123456", ""), "https://wa.me/51999123456")
  })

  it("returns null instead of a broken link when there is no number", () => {
    assert.equal(buildWhatsAppHref(""), null)
    assert.equal(buildWhatsAppHref(null), null)
    assert.equal(buildWhatsAppHref("abc"), null)
  })

  it("prefers the runtime number over the build-time env", () => {
    const prev = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER
    process.env.NEXT_PUBLIC_WHATSAPP_NUMBER = "51900000000"
    try {
      assert.equal(resolveWhatsAppNumber("+51 911 111 111"), "51911111111")
      assert.equal(resolveWhatsAppNumber(null), "51900000000")
      assert.equal(resolveWhatsAppNumber(""), "51900000000")
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_WHATSAPP_NUMBER
      else process.env.NEXT_PUBLIC_WHATSAPP_NUMBER = prev
    }
  })

  it("returns null when neither runtime nor build-time number exists", () => {
    const prev = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER
    delete process.env.NEXT_PUBLIC_WHATSAPP_NUMBER
    try {
      assert.equal(resolveWhatsAppNumber(null), null)
    } finally {
      if (prev !== undefined) process.env.NEXT_PUBLIC_WHATSAPP_NUMBER = prev
    }
  })
})

describe("plans-catalog · checkout error copy", () => {
  it("maps a 503 (Stripe not configured) to the WhatsApp fallback in Spanish", () => {
    const info = describeCheckoutError({
      status: 503,
      message: "Stripe not configured",
      errorData: {
        code: "STRIPE_NOT_CONFIGURED",
        message: "El pago con tarjeta aún no está habilitado.",
        whatsappNumber: "51999123456",
      },
    })
    assert.equal(info.kind, "unavailable")
    assert.equal(info.message, "El pago con tarjeta aún no está habilitado.")
    assert.equal(info.whatsappNumber, "51999123456")
  })

  it("recognises the legacy English 'not configured' message without a status", () => {
    const info = describeCheckoutError(new Error("Stripe not configured"))
    assert.equal(info.kind, "unavailable")
    assert.match(info.message, /WhatsApp/)
    assert.equal(info.whatsappNumber, null)
  })

  it("maps 401 to a session-expired message", () => {
    const info = describeCheckoutError({ status: 401 })
    assert.equal(info.kind, "auth")
    assert.match(info.message, /sesión/i)
  })

  it("falls back to a generic Spanish message for unknown failures", () => {
    const info = describeCheckoutError({ status: 500, message: "boom" })
    assert.equal(info.kind, "generic")
    assert.equal(info.message, "boom")
    assert.equal(describeCheckoutError(undefined).kind, "generic")
    assert.match(describeCheckoutError(undefined).message, /pago/i)
  })
})
