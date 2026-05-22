"use client"

import * as React from "react"
import { ShieldAlert, X } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * #45 — Aviso de credenciales en el composer.
 *
 * Cuando el texto del composer parece contener una clave o token
 * (OpenAI, Anthropic, AWS, Google, GitHub, Stripe, Slack, JWT,
 * Hugging Face, etc.) se muestra un chip ámbar sobre el composer
 * sugiriendo borrarlo antes de enviar.
 *
 * - NO bloquea el envío — Sira a veces necesita ver claves de
 *   ejemplo para ayudar a depurar; el aviso es solo informativo.
 * - El usuario puede silenciarlo en este chat con la "X" (persiste
 *   en sessionStorage para no molestar en cada keystroke después
 *   de la primera advertencia).
 * - role="status" + aria-live="polite" para lectores de pantalla.
 */

type Pattern = { name: string; rx: RegExp }

const PATTERNS: Pattern[] = [
  { name: "OpenAI", rx: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic", rx: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "Google API", rx: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: "AWS", rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub", rx: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub PAT", rx: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: "Stripe", rx: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: "Slack", rx: /\bxox[baprsoe]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Hugging Face", rx: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: "Twilio", rx: /\bSK[0-9a-f]{32}\b/ },
  { name: "SendGrid", rx: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  // JWT — al menos las dos primeras secciones, la tercera es
  // opcional para no fallar con tokens sin firma o truncados.
  { name: "JWT", rx: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{0,})?\b/ },
  // Labels obvios: "password: xxx", "api_key=xxx" (>=6 chars del valor).
  { name: "contraseña", rx: /\b(?:password|passwd|contrase[ñn]a)\s*[:=]\s*\S{6,}/i },
  { name: "API key etiquetada", rx: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|bearer)\s*[:=]\s*\S{12,}/i },
]

function detectKinds(text: string): string[] {
  if (!text || text.length < 12) return []
  const found = new Set<string>()
  for (const p of PATTERNS) {
    if (p.rx.test(text)) found.add(p.name)
    if (found.size >= 3) break
  }
  return Array.from(found)
}

export function CredentialWarning({ text }: { text: string }) {
  const [dismissed, setDismissed] = React.useState(false)

  // Restaurar dismiss por sesión — evita que reaparezca en cada
  // tecla pulsada tras la primera advertencia.
  React.useEffect(() => {
    try {
      if (sessionStorage.getItem("sira:credential-warning:dismissed") === "1") {
        setDismissed(true)
      }
    } catch {
      /* sessionStorage puede no estar disponible */
    }
  }, [])

  const kinds = React.useMemo(() => detectKinds(text), [text])

  if (dismissed || kinds.length === 0) return null

  const label =
    kinds.length === 1
      ? `Parece que tu mensaje contiene una credencial (${kinds[0]}).`
      : `Parece que tu mensaje contiene credenciales (${kinds.slice(0, 2).join(", ")}${kinds.length > 2 ? ", …" : ""}).`

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg px-3 py-2",
        "border border-amber-300/60 bg-amber-50/80 text-amber-900",
        "dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
        "text-[12.5px] leading-snug",
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-200",
      )}
    >
      <ShieldAlert className="h-4 w-4 shrink-0 mt-[1px]" strokeWidth={2} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <span className="font-medium">{label}</span>{" "}
        <span className="opacity-90">Bórrala antes de enviar si no quieres compartirla.</span>
      </div>
      <button
        type="button"
        aria-label="Ocultar este aviso"
        onClick={() => {
          setDismissed(true)
          try { sessionStorage.setItem("sira:credential-warning:dismissed", "1") } catch { /* no-op */ }
        }}
        className={cn(
          "shrink-0 -mr-1 -mt-0.5 rounded-md p-1",
          "hover:bg-amber-200/40 dark:hover:bg-amber-500/20",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40",
        )}
      >
        <X className="h-3.5 w-3.5" strokeWidth={2.25} />
      </button>
    </div>
  )
}

export default CredentialWarning
