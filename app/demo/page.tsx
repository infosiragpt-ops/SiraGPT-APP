"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BrandLogo } from "@/components/BrandLogo"
import { LoginButton } from "@/components/AuthNavButtons"
import { ThemeToggle } from "@/components/theme-toggle"
import { track } from "@/lib/analytics"

/**
 * Public demo (growth handoff 2026-07-02): three curated demos an anonymous
 * visitor can run against /api/demo (cached results — no LLM cost, no auth).
 * The post-result CTA stashes the prompt under sessionStorage "demo-prefill"
 * (consumed by the chat composer after sign-up) and routes through
 * /auth/register?next=/chat.
 */

const DEMOS = [
  {
    id: "contenido",
    title: "Crear contenido",
    cardTitle: "Convierte una idea en un post listo para publicar",
    prompt:
      'Convierte esta idea en un post corto para Instagram y LinkedIn: "Una sola plataforma para usar GPT, Claude, Gemini, imágenes, voz y agentes sin cambiar de app". Dame 3 versiones: profesional, directa y viral.',
  },
  {
    id: "comparar",
    title: "Comparar modelos",
    cardTitle: "Compara cómo responderían varios modelos",
    prompt:
      "Tengo que lanzar una app de IA esta semana. Dame una respuesta tipo GPT, una tipo Claude y una tipo Gemini para priorizar las 5 tareas más importantes, con el razonamiento detrás de cada una.",
  },
  {
    id: "automatizar",
    title: "Automatizar trabajo",
    cardTitle: "Transforma una tarea en un plan ejecutable",
    prompt:
      "Actúa como un agente de operaciones. Tengo que revisar leads, escribir follow-ups y preparar una propuesta. Organiza el trabajo en pasos, mensajes listos para enviar y una checklist final.",
  },
] as const

type Demo = (typeof DEMOS)[number]

/** Minimal renderer for the cached results: **bold** + line breaks. */
function ResultText({ text }: { text: string }) {
  const nodes: React.ReactNode[] = []
  text.split(/(\*\*[^*]+\*\*)/g).forEach((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      nodes.push(<strong key={i}>{part.slice(2, -2)}</strong>)
    } else {
      nodes.push(<React.Fragment key={i}>{part}</React.Fragment>)
    }
  })
  return <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.65 }}>{nodes}</div>
}

export default function DemoPage() {
  const router = useRouter()
  const [activeDemo, setActiveDemo] = React.useState<Demo>(DEMOS[0])
  const [result, setResult] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const runDemo = async () => {
    setLoading(true)
    setResult(null)
    setError(null)
    track("demo.started", { demoId: activeDemo.id })
    const t0 = Date.now()
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ demoId: activeDemo.id }),
      })
      if (!res.ok) throw new Error(`http ${res.status}`)
      const data = await res.json()
      // Small beat so the preview feels generated rather than pasted.
      await new Promise((r) => setTimeout(r, 600))
      setResult(String(data.result || ""))
      track("demo.generation_completed", { demoId: activeDemo.id, latency_ms: Date.now() - t0, was_cached: true })
    } catch {
      setError("Lo sentimos, hubo un error. Intenta de nuevo o crea una cuenta para probar SiraGPT completo.")
    } finally {
      setLoading(false)
    }
  }

  const goToSignup = () => {
    track("demo.signup_cta_clicked", { demoId: activeDemo.id, cta_position: "post_result" })
    try {
      sessionStorage.setItem("demo-prefill", activeDemo.prompt)
    } catch {
      /* private mode — the user still lands in chat, just without prefill */
    }
    router.push("/auth/register?next=%2Fchat")
  }

  const tryAnother = () => {
    const next = DEMOS[(DEMOS.findIndex((d) => d.id === activeDemo.id) + 1) % DEMOS.length]
    setActiveDemo(next)
    setResult(null)
    setError(null)
  }

  const selectDemo = (demo: Demo) => {
    setActiveDemo(demo)
    setResult(null)
    setError(null)
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-white text-neutral-950 dark:bg-neutral-950 dark:text-white">
      <header className="fixed top-0 z-50 w-full border-b border-neutral-200/80 bg-white/90 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/90">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3 md:px-6 md:py-4">
          <BrandLogo />
          <div className="flex items-center gap-2 md:gap-3">
            <ThemeToggle />
            <LoginButton href="/auth/login" />
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 880, margin: "0 auto", padding: "110px 20px 64px" }}>
        <div style={{ textAlign: "center", marginBottom: 34 }}>
          <h1 style={{ fontSize: "clamp(1.9rem, 4.5vw, 2.8rem)", fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.08, margin: 0 }}>
            Prueba SiraGPT en 30 segundos
          </h1>
          <p className="text-neutral-600 dark:text-neutral-300" style={{ margin: "12px auto 0", maxWidth: 560, lineHeight: 1.6 }}>
            Elige una demo. Te mostramos un resultado real y, si te sirve, creas tu cuenta gratis para continuarlo.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 22 }}>
          {DEMOS.map((demo) => {
            const active = demo.id === activeDemo.id
            return (
              <button
                key={demo.id}
                type="button"
                onClick={() => selectDemo(demo)}
                aria-pressed={active}
                className={
                  active
                    ? "border-neutral-900 bg-neutral-950 text-white dark:border-white dark:bg-white dark:text-neutral-950"
                    : "border-neutral-200 bg-white text-neutral-900 hover:bg-neutral-50 dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
                }
                style={{ border: "1px solid", borderRadius: 14, padding: "16px 16px 14px", textAlign: "left", cursor: "pointer", transition: "all .15s" }}
              >
                <span style={{ display: "block", fontWeight: 800, marginBottom: 4 }}>{demo.title}</span>
                <span style={{ display: "block", fontSize: "0.86rem", opacity: 0.75, lineHeight: 1.45 }}>{demo.cardTitle}</span>
              </button>
            )
          })}
        </div>

        <div
          className="border-neutral-200 bg-neutral-50 dark:border-white/10 dark:bg-white/5"
          style={{ border: "1px solid", borderRadius: 16, padding: 18 }}
        >
          <label htmlFor="demo-prompt" style={{ display: "block", fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.6, marginBottom: 8 }}>
            Prompt de la demo
          </label>
          <textarea
            id="demo-prompt"
            value={activeDemo.prompt}
            readOnly
            rows={4}
            className="border-neutral-200 bg-white text-neutral-800 dark:border-white/10 dark:bg-neutral-950 dark:text-neutral-200"
            style={{ width: "100%", border: "1px solid", borderRadius: 12, padding: 12, fontSize: "0.92rem", lineHeight: 1.55, resize: "none" }}
          />
          <button
            type="button"
            onClick={runDemo}
            disabled={loading}
            className="bg-neutral-950 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
            style={{ marginTop: 12, borderRadius: 12, padding: "12px 20px", fontWeight: 700, cursor: loading ? "wait" : "pointer", opacity: loading ? 0.7 : 1 }}
          >
            {loading ? "Generando…" : "Generar vista previa"}
          </button>
        </div>

        {error && (
          <p role="alert" className="text-red-600" style={{ marginTop: 16 }}>
            {error}
          </p>
        )}

        {result && (
          <div style={{ marginTop: 22 }}>
            <div
              className="border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5"
              style={{ border: "1px solid", borderRadius: 16, padding: 20, fontSize: "0.95rem" }}
            >
              <ResultText text={result} />
            </div>

            <div
              className="border-neutral-900 bg-neutral-950 text-white dark:border-white/20"
              style={{ border: "1px solid", borderRadius: 16, padding: 20, marginTop: 14, textAlign: "center" }}
            >
              <p style={{ margin: 0, fontWeight: 800, fontSize: "1.05rem" }}>¿Quieres continuar este resultado?</p>
              <p style={{ margin: "8px auto 14px", maxWidth: 460, fontSize: "0.9rem", opacity: 0.85, lineHeight: 1.55 }}>
                Crea una cuenta gratis para guardar el chat, cambiar de modelo y seguir trabajando con SiraGPT.
              </p>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={goToSignup}
                  className="bg-white text-neutral-950 hover:bg-neutral-200"
                  style={{ borderRadius: 12, padding: "12px 20px", fontWeight: 800, cursor: "pointer" }}
                >
                  Crear cuenta gratis
                </button>
                <button
                  type="button"
                  onClick={tryAnother}
                  className="text-white hover:bg-white/10"
                  style={{ border: "1px solid rgba(255,255,255,.35)", borderRadius: 12, padding: "12px 20px", fontWeight: 700, cursor: "pointer", background: "transparent" }}
                >
                  Probar otra demo
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
