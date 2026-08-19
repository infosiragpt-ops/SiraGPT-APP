"use client"

import { authenticatedFetch } from "./authenticated-fetch"

/**
 * admin-credits-service — client for /api/admin/credits/* (F2 PR7).
 *
 * Used by the F3 PR19 top-up modal + future admin reports. All
 * endpoints require a user with `credits.adjust` (super admin via the
 * shadow gate until F5 PR23). Backend rejects with 403 otherwise.
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export interface AdminCreditsTransaction {
  id: string
  userId: string
  orgId: string | null
  type:
    | "GRANT"
    | "REFILL"
    | "SPEND"
    | "REFUND"
    | "ADMIN_ADJUSTMENT"
    | "EXPIRY"
  amount: string
  balanceAfter: string
  reason: string
  metadata: Record<string, unknown>
  idempotencyKey: string | null
  createdAt: string
}

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {}
  const token = window.localStorage.getItem("auth-token")
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface TopUpInput {
  userId: string
  amount: number | string
  reason: string
  /** Optional client-provided key for safe retries. */
  idempotencyKey?: string
}

export async function grantCredits(input: TopUpInput): Promise<{
  transaction: AdminCreditsTransaction
  replay: boolean
}> {
  const idempotencyKey = input.idempotencyKey || crypto.randomUUID()
  const res = await authenticatedFetch(`${API_ROOT}/admin/credits/grant`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...authHeader(),
    },
    body: JSON.stringify({
      userId: input.userId,
      amount: input.amount,
      reason: input.reason,
      idempotencyKey,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(
      data?.error || `grantCredits failed (${res.status})`,
    ) as Error & { status?: number; missingPermission?: string }
    err.status = res.status
    err.missingPermission = data?.missingPermission
    throw err
  }
  return data as { transaction: AdminCreditsTransaction; replay: boolean }
}

export async function getUserCredits(userId: string): Promise<{
  credits: {
    userId: string
    balance: string
    reservedBalance: string
    lifetimeGranted: string
    lifetimeSpent: string
  } | null
}> {
  const res = await authenticatedFetch(
    `${API_ROOT}/admin/credits/users/${encodeURIComponent(userId)}`,
    { headers: authHeader() },
  )
  if (!res.ok) {
    throw new Error(`getUserCredits failed (${res.status})`)
  }
  return (await res.json()) as {
    credits: {
      userId: string
      balance: string
      reservedBalance: string
      lifetimeGranted: string
      lifetimeSpent: string
    } | null
  }
}
