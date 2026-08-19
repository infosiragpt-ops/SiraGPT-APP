"use client"

/**
 * credits-service — client for /api/credits/* (F2 PR7).
 *
 * Drives the F3 PR11 `CreditsBadge` in the sidebar + the credits
 * transaction history in the billing view. BigInt fields ride over
 * JSON as strings; helpers cast when callers need numeric math.
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export interface Credits {
  userId: string
  orgId: string | null
  balance: string
  reservedBalance: string
  lifetimeGranted: string
  lifetimeSpent: string
  lastRefillAt: string | null
  nextRefillAt: string | null
  updatedAt: string
}

export type CreditTransactionType =
  | "GRANT"
  | "REFILL"
  | "SPEND"
  | "REFUND"
  | "ADMIN_ADJUSTMENT"
  | "EXPIRY"

export interface CreditTransaction {
  id: string
  userId: string
  orgId: string | null
  type: CreditTransactionType
  amount: string
  balanceAfter: string
  reason: string
  metadata: Record<string, unknown>
  idempotencyKey: string | null
  createdAt: string
}

interface MeResponse {
  credits: Credits
}

interface TransactionsResponse {
  transactions: CreditTransaction[]
  nextCursor: string | null
}

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {}
  const token = window.localStorage.getItem("auth-token")
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function getMyCredits(): Promise<Credits | null> {
  const res = await fetch(`${API_ROOT}/credits/me`, {
    headers: authHeader(),
  })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`getMyCredits: ${res.status}`)
  const data = (await res.json()) as MeResponse
  return data.credits
}

export async function listMyTransactions(opts?: {
  cursor?: string | null
  limit?: number
  type?: CreditTransactionType
}): Promise<TransactionsResponse> {
  const qs = new URLSearchParams()
  if (opts?.cursor) qs.set("cursor", opts.cursor)
  if (opts?.limit) qs.set("limit", String(opts.limit))
  if (opts?.type) qs.set("type", opts.type)
  const url = `${API_ROOT}/credits/me/transactions${qs.toString() ? `?${qs}` : ""}`
  const res = await fetch(url, { headers: authHeader() })
  if (!res.ok) throw new Error(`listMyTransactions: ${res.status}`)
  return (await res.json()) as TransactionsResponse
}

export function balanceAsBigInt(credits: Credits | null | undefined): bigint {
  if (!credits) return BigInt(0)
  try {
    return BigInt(credits.balance)
  } catch (_err) {
    return BigInt(0)
  }
}

export function isLowBalance(credits: Credits | null, threshold: bigint = BigInt(50)): boolean {
  return balanceAsBigInt(credits) < threshold
}
