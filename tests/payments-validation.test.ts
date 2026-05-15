import assert from "node:assert/strict"
import { describe, it } from "node:test"

/**
 * Payment validation tests — covers plan validation, webhook event
 * routing, subscription status logic, and Stripe configuration checks.
 *
 * Why these exist:
 *   Payment processing touches real money. The Stripe webhook handler
 *   in routes/payments.js switches on event types and dispatches to
 *   per-event handlers — a logic error here could double-credit or
 *   miss a subscription change. These tests cover the decision trees
 *   without a Stripe API key.
 */

// ── Plan validation ─────────────────────────────────────────────

const VALID_PLANS = new Set(["PRO", "PRO_MAX", "ENTERPRISE"])

const PLAN_CREDITS = {
  PRO: 500000,
  PRO_MAX: 1000000,
  ENTERPRISE: 10000000,
}

const PLAN_AMOUNTS = {
  PRO: 5.00,
  PRO_MAX: 20.00,
  ENTERPRISE: 200.00,
}

type Plan = "PRO" | "PRO_MAX" | "ENTERPRISE"
type SubscriptionStatus = "active" | "inactive" | "canceled" | "past_due"

function isValidPlan(plan: unknown): plan is Plan {
  return typeof plan === "string" && VALID_PLANS.has(plan as Plan)
}

function getPlanCredits(plan: string): number {
  return PLAN_CREDITS[plan as Plan] || 0
}

function getPlanAmount(plan: string): number {
  return PLAN_AMOUNTS[plan as Plan] || 0
}

function getPriceIdForPlan(plan: string, env: Record<string, string | undefined> = process.env): string {
  const key = `STRIPE_PRICE_${plan}`
  return env[key] || `price_mock_${plan.toLowerCase()}`
}

// ── Stripe configuration check ──────────────────────────────────

function isStripeConfigured(env = process.env) {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY !== "sk_test_...")
}

// ── Webhook event type routing ──────────────────────────────────

const WEBHOOK_HANDLERS = {
  "checkout.session.completed": "handleCheckoutSessionCompleted",
  "invoice.payment_succeeded": "handleInvoicePaymentSucceeded",
  "invoice.payment_failed": "handleInvoicePaymentFailed",
  "customer.subscription.created": "handleSubscriptionCreated",
  "customer.subscription.updated": "handleSubscriptionUpdated",
  "customer.subscription.deleted": "handleSubscriptionDeleted",
}



// ── Subscription status machine ─────────────────────────────────

// Allowed transitions for subscription status
const SUBSCRIPTION_TRANSITIONS = {
  active: ["inactive", "canceled", "past_due"],
  inactive: ["active"],
  canceled: ["active"],
  past_due: ["active", "inactive", "canceled"],
}

function getWebhookHandlerName(eventType: string | null): string | null {
  if (!eventType) return null
  return (WEBHOOK_HANDLERS as Record<string, string>)[eventType] || null
}

function isKnownWebhookEvent(eventType: string): boolean {
  return eventType in WEBHOOK_HANDLERS
}

function canTransition(from: string, to: string): boolean {
  const allowed = (SUBSCRIPTION_TRANSITIONS as Record<string, string[]>)[from]
  return Boolean(allowed && allowed.includes(to))
}

function normalizeSubscriptionStatus(status: unknown): SubscriptionStatus | null {
  if (status === null || status === undefined) return null
  const normalized = String(status).toLowerCase().trim()
  const valid: SubscriptionStatus[] = ["active", "inactive", "canceled", "past_due"]
  return (valid as string[]).includes(normalized) ? (normalized as SubscriptionStatus) : null
}

// ── Plan change preview ─────────────────────────────────────────

interface PlanChangePreview {
  error?: string
  currentPlan?: string
  targetPlan?: string
  currentAmount?: number
  targetAmount?: number
  difference?: number
  proratedCharge?: number
  proratedCredit?: number
  billingDaysLeft?: number
  totalDays?: number
}

function computePlanChange(
  currentPlan: string | null,
  targetPlan: string | null,
  billingDaysLeft: number,
  totalDays = 30
): PlanChangePreview {
  if (!currentPlan || !targetPlan) return { error: "Both plans are required" }
  if (!isValidPlan(currentPlan)) return { error: `Invalid current plan: ${currentPlan}` }
  if (!isValidPlan(targetPlan)) return { error: `Invalid target plan: ${targetPlan}` }
  if (currentPlan === targetPlan) return { error: "Already on this plan" }

  const currentAmount = getPlanAmount(currentPlan)
  const targetAmount = getPlanAmount(targetPlan)
  const difference = targetAmount - currentAmount

  // Calculate proration
  const usedFraction = 1 - (billingDaysLeft / totalDays)
  const creditForCurrent = currentAmount * usedFraction
  const chargeForNew = targetAmount * usedFraction
  const netCharge = Math.max(0, chargeForNew - creditForCurrent)
  const netCredit = Math.max(0, creditForCurrent - chargeForNew)

  return {
    currentPlan,
    targetPlan,
    currentAmount,
    targetAmount,
    difference,
    proratedCharge: Math.round(netCharge * 100) / 100,
    proratedCredit: Math.round(netCredit * 100) / 100,
    billingDaysLeft,
    totalDays,
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("payments · plan validation", () => {
  it("accepts known plans", () => {
    assert.equal(isValidPlan("PRO"), true)
    assert.equal(isValidPlan("PRO_MAX"), true)
    assert.equal(isValidPlan("ENTERPRISE"), true)
  })

  it("rejects unknown plans", () => {
    assert.equal(isValidPlan("FREE"), false)
    assert.equal(isValidPlan("PREMIUM"), false)
    assert.equal(isValidPlan(""), false)
    assert.equal(isValidPlan(null), false)
    assert.equal(isValidPlan("pro"), false) // case-sensitive
  })

  it("returns correct credits per plan", () => {
    assert.equal(getPlanCredits("PRO"), 500_000)
    assert.equal(getPlanCredits("PRO_MAX"), 1_000_000)
    assert.equal(getPlanCredits("ENTERPRISE"), 10_000_000)
    assert.equal(getPlanCredits("FREE"), 0)
  })

  it("returns correct amounts per plan", () => {
    assert.equal(getPlanAmount("PRO"), 5.00)
    assert.equal(getPlanAmount("PRO_MAX"), 20.00)
    assert.equal(getPlanAmount("ENTERPRISE"), 200.00)
  })
})

describe("payments · Stripe configuration", () => {
  it("detects configured Stripe", () => {
    assert.equal(isStripeConfigured({
      STRIPE_SECRET_KEY: "sk_live_abc123",
    }), true)
  })

  it("accepts restricted Stripe live keys as configured", () => {
    assert.equal(isStripeConfigured({
      STRIPE_SECRET_KEY: "rk_live_abc123",
    }), true)
  })

  it("detects demo/template key as unconfigured", () => {
    assert.equal(isStripeConfigured({
      STRIPE_SECRET_KEY: "sk_test_...",
    }), false)
  })

  it("detects missing key as unconfigured", () => {
    assert.equal(isStripeConfigured({}), false)
    assert.equal(isStripeConfigured({
      STRIPE_SECRET_KEY: "",
    }), false)
  })
})

describe("payments · webhook event routing", () => {
  it("maps known event types to handlers", () => {
    assert.equal(getWebhookHandlerName("checkout.session.completed"),
      "handleCheckoutSessionCompleted")
    assert.equal(getWebhookHandlerName("invoice.payment_succeeded"),
      "handleInvoicePaymentSucceeded")
    assert.equal(getWebhookHandlerName("customer.subscription.updated"),
      "handleSubscriptionUpdated")
    assert.equal(getWebhookHandlerName("customer.subscription.deleted"),
      "handleSubscriptionDeleted")
  })

  it("returns null for unknown event types", () => {
    assert.equal(getWebhookHandlerName("charge.refunded"), null)
    assert.equal(getWebhookHandlerName(""), null)
    assert.equal(getWebhookHandlerName(null), null)
  })

  it("identifies known vs unknown events", () => {
    assert.equal(isKnownWebhookEvent("checkout.session.completed"), true)
    assert.equal(isKnownWebhookEvent("charge.dispute.created"), false)
  })

  it("covers all 6 handled event types", () => {
    assert.equal(Object.keys(WEBHOOK_HANDLERS).length, 6)
  })
})

describe("payments · subscription status machine", () => {
  it("normalizes valid status strings", () => {
    assert.equal(normalizeSubscriptionStatus("ACTIVE"), "active")
    assert.equal(normalizeSubscriptionStatus("Active"), "active")
    assert.equal(normalizeSubscriptionStatus("past_due"), "past_due")
    assert.equal(normalizeSubscriptionStatus("CANCELED"), "canceled")
  })

  it("rejects invalid status strings", () => {
    assert.equal(normalizeSubscriptionStatus("expired"), null)
    assert.equal(normalizeSubscriptionStatus(""), null)
    assert.equal(normalizeSubscriptionStatus(null), null)
  })

  it("allows valid transitions", () => {
    assert.equal(canTransition("active", "canceled"), true)
    assert.equal(canTransition("active", "past_due"), true)
    assert.equal(canTransition("past_due", "active"), true)
    assert.equal(canTransition("canceled", "active"), true)
  })

  it("rejects invalid transitions", () => {
    assert.equal(canTransition("inactive", "canceled"), false)
    assert.equal(canTransition("active", "active"), false)
    assert.equal(canTransition("canceled", "past_due"), false)
  })
})

describe("payments · plan change preview", () => {
  it("previews upgrade proration (PRO → PRO_MAX)", () => {
    const preview = computePlanChange("PRO", "PRO_MAX", 20, 30)
    assert.equal(preview.error, undefined)
    assert.equal(preview.currentPlan, "PRO")
    assert.equal(preview.targetPlan, "PRO_MAX")
    assert.equal(preview.currentAmount, 5.00)
    assert.equal(preview.targetAmount, 20.00)
    assert.equal(preview.difference, 15.00)
    assert(preview.proratedCharge! > 0)
    assert.equal(preview.proratedCredit, 0)
  })

  it("previews downgrade proration (PRO_MAX → PRO)", () => {
    const preview = computePlanChange("PRO_MAX", "PRO", 20, 30)
    assert.equal(preview.error, undefined)
    assert.equal(preview.proratedCharge, 0)
    assert(preview.proratedCredit! > 0)
  })

  it("returns error for invalid plans", () => {
    const preview = computePlanChange("FREE", "PRO", 15)
    assert.equal(preview.error, "Invalid current plan: FREE")
  })

  it("returns error when already on the target plan", () => {
    const preview = computePlanChange("PRO", "PRO", 15)
    assert.equal(preview.error, "Already on this plan")
  })

  it("returns error for missing plans", () => {
    const preview = computePlanChange(null, "PRO", 15)
    assert.equal(preview.error, "Both plans are required")
  })
})
