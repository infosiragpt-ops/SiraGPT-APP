"use client"

import { useState } from "react"
import { grantCredits } from "@/lib/admin-credits-service"
import type { AdminCreditsTransaction } from "@/lib/admin-credits-service"

/**
 * F3 PR19 — Admin top-up credits modal (controlled).
 *
 * Calls `POST /api/admin/credits/grant` (F2 PR7) with an
 * Idempotency-Key so a double-click cannot double-grant. Surfaces
 * the resulting transaction so the admin sees the new balance
 * immediately.
 *
 * Visually conservative — uses only Tailwind utility classes and the
 * same `text-zinc-*` palette as the existing admin shell. Drop the
 * modal into the existing AdminUsers page row action whenever the
 * super-admin redesign happens — no layout file is touched here.
 */
export interface CreditsTopUpModalProps {
  open: boolean
  userId: string
  userLabel?: string
  onClose: () => void
  onGranted?: (txn: AdminCreditsTransaction) => void
}

export function CreditsTopUpModal({
  open,
  userId,
  userLabel,
  onClose,
  onGranted,
}: CreditsTopUpModalProps) {
  const [amount, setAmount] = useState<string>("100")
  const [reason, setReason] = useState<string>("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<AdminCreditsTransaction | null>(null)

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    const parsedAmount = Number.parseInt(amount, 10)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError("El monto debe ser un entero positivo.")
      return
    }
    if (!reason.trim() || reason.trim().length < 4) {
      setError("Razón requerida (≥ 4 caracteres) para auditoría.")
      return
    }
    setSubmitting(true)
    try {
      const result = await grantCredits({
        userId,
        amount: parsedAmount,
        reason: reason.trim(),
      })
      setSuccess(result.transaction)
      if (onGranted) onGranted(result.transaction)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "No se pudo aplicar el top-up"
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="topup-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="topup-title"
          className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100"
        >
          Top-up de créditos
        </h2>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          {userLabel ? `Usuario: ${userLabel}` : `Usuario ID: ${userId}`}
        </p>

        {!success ? (
          <form onSubmit={handleSubmit} className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
                Monto
              </span>
              <input
                type="number"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                aria-label="Monto de créditos"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
                Razón (queda en audit log)
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="ej. compensación por incidente / promoción Q3"
                className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                aria-label="Razón del top-up"
              />
            </label>
            {error ? (
              <p
                role="alert"
                className="text-sm text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            ) : null}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                disabled={submitting}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                disabled={submitting}
              >
                {submitting ? "Aplicando…" : "Aplicar top-up"}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-emerald-600 dark:text-emerald-400">
              Top-up aplicado.
            </p>
            <p className="text-zinc-600 dark:text-zinc-400">
              Saldo después: <span className="font-mono">{success.balanceAfter}</span>
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              Transaction ID: <span className="font-mono">{success.id}</span>
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-zinc-100"
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default CreditsTopUpModal
