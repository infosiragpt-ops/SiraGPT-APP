"use client"

/**
 * plans-service — client for /api/plans (F2 PR6).
 *
 * F3 PR11 will swap the legacy hardcoded plan list in app/plan/page.tsx
 * for the live catalog returned by getPlans(). Until then this service
 * is unused — landing it now keeps the diff small for the swap.
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export type PlanCode = "FREE" | "PRO" | "PRO_MAX" | "ENTERPRISE"

export interface Plan {
  id: string
  code: PlanCode
  name: string
  description: string | null
  priceMonthlyCents: number
  priceYearlyCents: number
  currency: string
  /**
   * Backend serialises monthlyCredits BigInt as a string (e.g. "500")
   * for JSON-safe transport. Cast with BigInt() if you need numeric
   * comparisons.
   */
  monthlyCredits: string
  trialDays: number
  features: unknown[]
  isActive: boolean
  displayOrder: number
  stripePriceIdMonthly: string | null
  stripePriceIdYearly: string | null
  createdAt: string
  updatedAt: string
}

interface PlansResponse {
  plans: Plan[]
}

interface PlanResponse {
  plan: Plan
}

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {}
  const token = window.localStorage.getItem("auth-token")
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function getPlans(): Promise<Plan[]> {
  const res = await fetch(`${API_ROOT}/plans`, {
    headers: authHeader(),
  })
  if (!res.ok) throw new Error(`getPlans: ${res.status}`)
  const data = (await res.json()) as PlansResponse
  return data.plans
}

export async function getPlan(code: PlanCode): Promise<Plan | null> {
  const res = await fetch(`${API_ROOT}/plans/${code}`, {
    headers: authHeader(),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`getPlan(${code}): ${res.status}`)
  const data = (await res.json()) as PlanResponse
  return data.plan
}

export function monthlyCreditsAsBigInt(plan: Plan): bigint {
  try {
    return BigInt(plan.monthlyCredits)
  } catch (_err) {
    return BigInt(0)
  }
}
