"use client"

import { useState } from "react"
import {
  disableTotp,
  regenerateRecoveryCodes,
  setupTotp,
  verifyTotp,
  type TotpSetupResponse,
} from "@/lib/auth/mfa-totp"
import { writeText as copyTextSafe } from "@/lib/native/clipboard"

/**
 * F3 PR13 — TOTP setup card for `app/settings/security/`.
 *
 * Three states:
 *   - idle           ▸ user not enrolled. Big "Activar TOTP" button.
 *   - setup          ▸ shows QR + secret + 6-digit input. On verify
 *                       success transitions to `codes`.
 *   - codes          ▸ shows the recovery codes ONCE (server-side
 *                       they are hashed). The user must save them.
 *   - enabled        ▸ steady state. Buttons to regenerate codes
 *                       or fully disable TOTP.
 *
 * Props are controlled enough that the parent owns whether the user
 * already has TOTP enabled (the security settings page already knows
 * this from /api/users/me).
 */
export interface TotpSetupCardProps {
  /** Whether the user already has totpEnabled=true on the server. */
  enabledInitial: boolean
  /** Optional callback fired after a state transition that the parent
   * may want to react to (refresh the /me header etc.). */
  onChange?: (next: { enabled: boolean }) => void
}

type Phase = "idle" | "setup" | "codes" | "enabled"

export function TotpSetupCard({ enabledInitial, onChange }: TotpSetupCardProps) {
  const [phase, setPhase] = useState<Phase>(enabledInitial ? "enabled" : "idle")
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null)
  const [code, setCode] = useState("")
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onActivate = async () => {
    setError(null)
    setBusy(true)
    try {
      const result = await setupTotp()
      setSetup(result)
      setPhase("setup")
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo iniciar TOTP")
    } finally {
      setBusy(false)
    }
  }

  const onVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) {
      setError("Ingresa los 6 dígitos del código")
      return
    }
    setError(null)
    setBusy(true)
    try {
      await verifyTotp(code)
      const r = await regenerateRecoveryCodes()
      setRecoveryCodes(r.codes)
      setPhase("codes")
      onChange?.({ enabled: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Código inválido")
    } finally {
      setBusy(false)
    }
  }

  const onConfirmCodesSaved = () => {
    setPhase("enabled")
    setRecoveryCodes(null)
  }

  const onRegenerate = async () => {
    if (!window.confirm("Esto invalidará tus códigos anteriores. ¿Continuar?")) return
    setError(null)
    setBusy(true)
    try {
      const r = await regenerateRecoveryCodes()
      setRecoveryCodes(r.codes)
      setPhase("codes")
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron regenerar los códigos")
    } finally {
      setBusy(false)
    }
  }

  const onDisable = async () => {
    if (!window.confirm("¿Desactivar la autenticación TOTP? Tu cuenta quedará más expuesta.")) return
    setError(null)
    setBusy(true)
    try {
      await disableTotp()
      setPhase("idle")
      setSetup(null)
      onChange?.({ enabled: false })
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo desactivar TOTP")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="totp-card-title"
      className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      data-testid="totp-setup-card"
    >
      <header className="mb-3 flex items-center justify-between">
        <h3
          id="totp-card-title"
          className="text-base font-semibold text-zinc-900 dark:text-zinc-100"
        >
          Autenticación TOTP (Google Authenticator / Authy / 1Password)
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            phase === "enabled"
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300"
          }`}
        >
          {phase === "enabled" ? "Activo" : "Inactivo"}
        </span>
      </header>

      {error ? (
        <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {phase === "idle" ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Agrega un segundo factor de inicio de sesión basado en una app
            autenticadora. Tomará menos de un minuto.
          </p>
          <button
            type="button"
            onClick={onActivate}
            disabled={busy}
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? "Iniciando…" : "Activar TOTP"}
          </button>
        </div>
      ) : null}

      {phase === "setup" && setup ? (
        <form onSubmit={onVerify} className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Escanea el código QR con tu app autenticadora y luego escribe el
            código de 6 dígitos para confirmar.
          </p>
          {setup.qrPngBase64 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`data:image/png;base64,${setup.qrPngBase64}`}
              alt="Código QR de configuración TOTP"
              className="mx-auto h-44 w-44 rounded bg-white p-2"
            />
          ) : null}
          <div className="rounded bg-zinc-100 p-2 text-center text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            <span className="block font-mono break-all">{setup.otpauthUrl}</span>
            {setup.secret ? (
              <span className="mt-1 block">
                Secreto manual: <span className="font-mono">{setup.secret}</span>
              </span>
            ) : null}
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
              Código de 6 dígitos
            </span>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoComplete="one-time-code"
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-center font-mono text-lg tracking-widest text-zinc-900 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              aria-label="Código TOTP"
            />
          </label>
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="w-full rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? "Verificando…" : "Confirmar y activar"}
          </button>
        </form>
      ) : null}

      {phase === "codes" && recoveryCodes ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            Guarda estos códigos de recuperación AHORA — solo se muestran una
            vez. Los necesitarás si pierdes acceso a la app autenticadora.
          </p>
          <ul className="grid grid-cols-2 gap-1 rounded bg-zinc-100 p-3 font-mono text-sm dark:bg-zinc-800">
            {recoveryCodes.map((c) => (
              <li key={c} className="text-zinc-700 dark:text-zinc-200">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void copyTextSafe(recoveryCodes.join("\n"))}
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Copiar al portapapeles
            </button>
            <button
              type="button"
              onClick={onConfirmCodesSaved}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Ya los guardé
            </button>
          </div>
        </div>
      ) : null}

      {phase === "enabled" ? (
        <div className="space-y-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            TOTP activo. Tu próximo inicio de sesión pedirá un código.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRegenerate}
              disabled={busy}
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Regenerar códigos de recuperación
            </button>
            <button
              type="button"
              onClick={onDisable}
              disabled={busy}
              className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/50"
            >
              Desactivar TOTP
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default TotpSetupCard
