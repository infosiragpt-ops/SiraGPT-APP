"use client"

import * as React from "react"
import { motion, useReducedMotion } from "framer-motion"
import { Building2, Check, Crown, FileText, Globe, ImageIcon, MessageCircle, Rocket, ShieldCheck, Sparkles } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { useAuth } from "@/lib/auth-context-integrated"
import { apiClient } from "@/lib/api"

type Plan = "FREE" | "PRO" | "PRO_MAX" | "ENTERPRISE"

type UpgradePlan = {
  id: Exclude<Plan, "FREE">
  name: string
  eyebrow: string
  price: string
  subtitle: string
  icon: typeof Crown
  featured?: boolean
  badge?: string
  cta: string
  features: Array<{
    icon: typeof Crown
    title: string
    desc: string
  }>
}

interface UpgradeModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  user?: any
  /**
   * Called when user clicks subscribe. If provided, must accept plan and return a Promise.
   * If omitted, modal initiates the standard Stripe Checkout flow via
   * apiClient.createStripePayment (the legacy /api/payments/instant endpoint
   * is super-admin-only and is no longer called from non-admin UI paths).
   */
  onSubscribe?: (plan: Exclude<Plan, "FREE">) => Promise<void>
  isSubscribing?: boolean
}

// Palette — self-contained dark "spotlight" surface (cohesive with the auth
// brand rail). All exotic effects are inline styles because the production
// Tailwind build is curated (arbitrary colors/effects/`-950` may not exist).
const VIOLET = "#a78bfa" // accent that reads well on dark
const VIOLET_STRONG = "rgb(124,58,237)"

const POSITIONING = {
  eyebrow: "Todos los modelos. Todas las capacidades. Una cuenta.",
  headline: "Toda la IA de frontera, por una fracción del precio de una sola.",
  subhead:
    "GPT, Claude, Gemini, Grok y más — con imagen, voz, video, documentos, código y agentes integrados. Otros te venden un modelo de un solo proveedor; SiraGPT te los da todos desde $5/mes.",
}

const TRUST_ROW = [
  "Pago seguro con Stripe — nunca vemos ni guardamos tu tarjeta",
  "Cancela cuando quieras, sin permanencia",
  "Precio fijo, sin cargos ocultos",
  "Precios en USD, se cobra en tu moneda local",
  "Tu trabajo es tuyo siempre, en cualquier plan",
]

const upgradePlans: UpgradePlan[] = [
  {
    id: "PRO",
    name: "Pro",
    eyebrow: "El que la mayoría elige",
    price: "$5",
    subtitle: "Toda la IA de SiraGPT en una cuenta. El punto de partida perfecto.",
    icon: Crown,
    featured: true,
    badge: "Más popular",
    cta: "Empezar con Pro",
    features: [
      { icon: Sparkles, title: "Cambia de modelo sin cambiar de app", desc: "GPT, Claude, Gemini, Grok y más en un solo chat — usa el mejor para cada tarea." },
      { icon: ImageIcon, title: "Crea en cualquier formato", desc: "Imagen, voz, video y música con IA, más documentos y código, todo integrado." },
      { icon: FileText, title: "Convierte ideas en entregables", desc: "34 herramientas visuales (SWOT, flujos, organigramas, dashboards) en segundos." },
      { icon: Rocket, title: "Agentes que trabajan por ti", desc: "Investigación, búsqueda web y tareas multi-paso que se ejecutan solas." },
    ],
  },
  {
    id: "PRO_MAX",
    name: "Pro Extendido",
    eyebrow: "Para uso intensivo a diario",
    price: "$10",
    subtitle: "Todo lo de Pro con el doble de volumen para producir sin frenar.",
    icon: Rocket,
    cta: "Elegir Pro Extendido",
    features: [
      { icon: Globe, title: "El doble de capacidad mensual", desc: "Para quien usa IA todos los días sin pensar en el límite." },
      { icon: Crown, title: "Todo Pro, sin recortes", desc: "Cada modelo, cada herramienta y cada agente, exactamente igual." },
      { icon: Sparkles, title: "Aún la mitad de una sola rival", desc: "$10/mes frente a los $20 de ChatGPT, Claude o Gemini — y aquí tienes todos." },
      { icon: ShieldCheck, title: "Prioridad y soporte reforzados", desc: "Continuidad superior para proyectos frecuentes y equipos pequeños." },
    ],
  },
  {
    id: "ENTERPRISE",
    name: "Enterprise",
    eyebrow: "A la medida de tu equipo",
    price: "Hablemos",
    subtitle: "Para equipos y empresas con necesidades específicas.",
    icon: Building2,
    cta: "Comunícate al WhatsApp",
    features: [
      { icon: Building2, title: "Espacios de equipo compartidos", desc: "Contexto común y trabajo multi-usuario en un mismo espacio." },
      { icon: ShieldCheck, title: "Seguridad de nivel empresa", desc: "SSO, listas de IP permitidas y accesos por rol." },
      { icon: Globe, title: "Integraciones a tu flujo", desc: "Conecta Slack, GitHub y tus APIs internas." },
      { icon: MessageCircle, title: "Onboarding y soporte directo", desc: "Acompañamiento por WhatsApp, precios y SLA a medida." },
    ],
  },
]

function FeatureRow({ icon: Icon, title, desc, featured }: { icon: typeof Crown; title: string; desc: string; featured?: boolean }) {
  return (
    <div className="flex gap-3 py-2.5">
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{
          border: `1px solid ${featured ? "rgba(167,139,250,0.35)" : "rgba(255,255,255,0.12)"}`,
          background: featured ? "rgba(124,58,237,0.12)" : "rgba(255,255,255,0.04)",
          color: featured ? VIOLET : "rgba(255,255,255,0.75)",
        }}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium leading-5" style={{ color: "rgba(255,255,255,0.95)" }}>{title}</div>
        <div className="text-xs leading-5" style={{ color: "rgba(255,255,255,0.55)" }}>{desc}</div>
      </div>
    </div>
  )
}

export default function UpgradeModal({ open, onOpenChange, user, onSubscribe, isSubscribing }: UpgradeModalProps) {
  const [loadingPlan, setLoadingPlan] = React.useState<Plan | null>(null)
  const { user: authUser } = useAuth()
  const reduceMotion = useReducedMotion()
  const currentUser = authUser || user
  const currentPlan = (currentUser?.plan || "FREE") as Plan
  const apiUsage = currentUser?.apiUsage ?? 0
  const monthlyLimit = currentUser?.monthlyLimit ?? 0
  const usageRatio = monthlyLimit > 0 ? apiUsage / monthlyLimit : 0
  const usagePct = Math.min(100, Math.round(usageRatio * 100))

  const openEnterpriseWhatsapp = () => {
    const whatsappNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || ""
    const message = encodeURIComponent(
      "Hola 👋, me interesa el plan Enterprise de SiraGPT. ¿Podrían ayudarme?",
    )
    window.open(`https://wa.me/${whatsappNumber}?text=${message}`, "_blank", "noopener,noreferrer")
  }

  const subscribe = async (plan: Exclude<Plan, "FREE">) => {
    if (plan === "ENTERPRISE") {
      openEnterpriseWhatsapp()
      return
    }

    try {
      setLoadingPlan(plan)

      if (onSubscribe) {
        await onSubscribe(plan)
        return
      }

      if (!currentUser) {
        toast.error("Inicia sesión para suscribirte")
        return
      }

      const response = await apiClient.createStripePayment({ plan })

      if (!response?.url) {
        throw new Error("No checkout URL received")
      }

      window.location.href = response.url
    } catch (err: any) {
      console.error("subscribe error", err)
      const status = err?.status ?? err?.statusCode
      const data = err?.errorData

      if (status === 503 || /not configured/i.test(err?.message || "")) {
        toast.error(
          data?.message || "El procesamiento de pagos aún no está disponible. Contacta a soporte.",
          { duration: 6000 },
        )
      } else if (status === 401) {
        toast.error("Tu sesión expiró — inicia sesión de nuevo.")
      } else {
        toast.error(err?.message || "Falló la suscripción")
      }
    } finally {
      setLoadingPlan(null)
    }
  }

  // Thin progress ring for the honest "loss-framing" quota nudge.
  const ringR = 13
  const ringC = 2 * Math.PI * ringR
  const ringOffset = ringC * (1 - Math.min(1, usageRatio))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92vh] w-[96vw] max-w-5xl overflow-y-auto border-0 p-0 text-white"
        style={{ background: "#0a0a0a", boxShadow: "0 50px 140px -28px rgba(0,0,0,0.85)" }}
      >
        <div className="relative">
          {/* Background layers — technical grid + top aurora (inline; curated-Tailwind safe) */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.04) 1px,transparent 1px)",
              backgroundSize: "40px 40px",
              maskImage: "radial-gradient(120% 90% at 50% 0%, #000 40%, transparent 80%)",
              WebkitMaskImage: "radial-gradient(120% 90% at 50% 0%, #000 40%, transparent 80%)",
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-72"
            style={{ background: "radial-gradient(60% 100% at 50% 0%, rgba(124,58,237,0.20), transparent 70%)" }}
          />

          {/* Content */}
          <div className="relative px-6 py-7 sm:px-9 sm:py-9">
            <DialogHeader>
              <div
                className="mb-3 inline-flex w-fit items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em]"
                style={{ border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.7)" }}
              >
                <Sparkles className="h-3.5 w-3.5" style={{ color: VIOLET }} />
                {POSITIONING.eyebrow}
              </div>
              <DialogTitle className="max-w-3xl text-balance text-2xl font-semibold tracking-[-0.035em] sm:text-[32px] sm:leading-[1.12]" style={{ color: "#fff" }}>
                {POSITIONING.headline}
              </DialogTitle>
            </DialogHeader>

            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <p className="max-w-2xl text-sm leading-6" style={{ color: "rgba(255,255,255,0.6)" }}>
                {POSITIONING.subhead}
              </p>
              <div className="shrink-0 rounded-full px-3 py-1 text-xs" style={{ border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.6)" }}>
                Plan actual: <span style={{ color: "#fff", fontWeight: 600 }}>{currentPlan}</span>
              </div>
            </div>

            {/* Value-anchor banner (price anchoring from the market study) */}
            <div
              className="mt-5 rounded-2xl px-4 py-3.5 text-sm leading-6 sm:px-5"
              style={{ border: "1px solid rgba(167,139,250,0.22)", background: "rgba(124,58,237,0.07)", color: "rgba(255,255,255,0.78)" }}
            >
              Una sola suscripción de ChatGPT, Claude o Gemini cuesta{" "}
              <span style={{ color: VIOLET, fontWeight: 600 }}>$20/mes</span> — y trae un solo proveedor. SiraGPT te da{" "}
              <span style={{ color: "#fff", fontWeight: 600 }}>todos los modelos líderes</span> más imagen, voz, video, documentos, código y agentes{" "}
              <span style={{ color: VIOLET, fontWeight: 600 }}>desde $5/mes</span>: la mitad de precio, el doble de mundo.
            </div>

            {/* Honest quota nudge — thin ring, only when usage is high */}
            {usageRatio >= 0.7 ? (
              <div
                className="mt-4 flex items-center gap-3 rounded-2xl px-4 py-3"
                style={{ border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.03)" }}
              >
                <svg width="34" height="34" viewBox="0 0 34 34" className="shrink-0">
                  <circle cx="17" cy="17" r={ringR} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="3" />
                  <circle
                    cx="17" cy="17" r={ringR} fill="none" stroke={VIOLET} strokeWidth="3" strokeLinecap="round"
                    strokeDasharray={ringC} strokeDashoffset={ringOffset} transform="rotate(-90 17 17)"
                  />
                </svg>
                <div className="text-sm" style={{ color: "rgba(255,255,255,0.8)" }}>
                  Has usado <span style={{ color: "#fff", fontWeight: 600 }}>{usagePct}%</span> de tu actividad este mes. Mejora tu plan para seguir sin interrupciones.
                </div>
              </div>
            ) : null}

            {/* Plans */}
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {upgradePlans.map((plan, idx) => {
                const Icon = plan.icon
                const isCurrent = currentPlan === plan.id
                const isLoading = loadingPlan === plan.id || isSubscribing
                const isEnterprise = plan.id === "ENTERPRISE"
                const featured = !!plan.featured

                return (
                  <motion.article
                    key={plan.id}
                    initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, delay: reduceMotion ? 0 : idx * 0.07, ease: [0.22, 1, 0.36, 1] }}
                    className="relative flex min-h-[480px] flex-col rounded-[22px] p-5"
                    style={{
                      border: featured ? "1px solid rgba(167,139,250,0.55)" : "1px solid rgba(255,255,255,0.09)",
                      background: featured ? "rgba(124,58,237,0.07)" : "rgba(255,255,255,0.025)",
                      boxShadow: featured ? "0 24px 60px -24px rgba(124,58,237,0.5)" : "none",
                    }}
                  >
                    {/* Aurora glow only behind the featured card */}
                    {featured ? (
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -inset-px"
                        style={{ borderRadius: 23, background: "radial-gradient(120% 70% at 50% 0%, rgba(124,58,237,0.20), transparent 60%)", filter: "blur(8px)" }}
                      />
                    ) : null}

                    <div className="relative flex flex-1 flex-col">
                      {plan.badge ? (
                        <motion.div
                          initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3, delay: 0.15 }}
                          className="absolute right-0 top-0 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                          style={{ border: `1px solid ${VIOLET}`, background: "rgba(124,58,237,0.16)", color: VIOLET }}
                        >
                          {plan.badge}
                        </motion.div>
                      ) : null}

                      <div
                        className="flex h-11 w-11 items-center justify-center rounded-2xl"
                        style={{ border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: featured ? VIOLET : "rgba(255,255,255,0.85)" }}
                      >
                        <Icon className="h-5 w-5" />
                      </div>

                      <div className="mt-6">
                        <div className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "rgba(255,255,255,0.5)" }}>
                          {plan.eyebrow}
                        </div>
                        <h3 className="mt-3 text-2xl font-semibold tracking-[-0.03em]" style={{ color: "#fff" }}>{plan.name}</h3>
                        <p className="mt-3 min-h-[44px] text-sm leading-6" style={{ color: "rgba(255,255,255,0.6)" }}>
                          {plan.subtitle}
                        </p>
                      </div>

                      <div className="mt-6 border-t pt-6" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[44px] font-semibold leading-none tracking-[-0.05em]" style={{ color: "#fff" }}>{plan.price}</span>
                          {!isEnterprise ? (
                            <span className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>/mes</span>
                          ) : null}
                        </div>
                        <div className="mt-1 text-xs" style={{ color: "rgba(255,255,255,0.45)" }}>
                          {isEnterprise ? "Comunicación directa por WhatsApp" : "Facturación mensual · cancela cuando quieras"}
                        </div>
                      </div>

                      <div className="mt-4 flex-1">
                        {plan.features.map((feature) => (
                          <FeatureRow key={feature.title} {...feature} featured={featured} />
                        ))}
                      </div>

                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isCurrent || !!isLoading}
                        onClick={() => subscribe(plan.id)}
                        className="mt-6 h-11 w-full rounded-full border-0 font-semibold"
                        style={
                          featured
                            ? { background: "#fff", color: "#0a0a0a" }
                            : { background: "rgba(255,255,255,0.06)", color: "#fff", border: "1px solid rgba(255,255,255,0.18)" }
                        }
                      >
                        {isCurrent ? (
                          <>
                            <Check className="mr-2 h-4 w-4" />
                            Plan actual
                          </>
                        ) : isEnterprise ? (
                          <>
                            <MessageCircle className="mr-2 h-4 w-4" />
                            {plan.cta}
                          </>
                        ) : (
                          plan.cta
                        )}
                      </Button>
                    </div>
                  </motion.article>
                )
              })}
            </div>

            {/* Secondary ghost CTA + honesty line (reduces "trap" feeling, lifts primary conversion) */}
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-sm underline-offset-4 transition-colors hover:underline"
                style={{ color: "rgba(255,255,255,0.6)" }}
              >
                Seguir con el plan gratis
              </button>
              <p className="mt-1.5 text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>
                FlashGPT es gratis e ilimitado, siempre. Pagas solo por los modelos premium y las herramientas.
              </p>
            </div>

            {/* Trust row */}
            <div className="mt-6 border-t pt-5" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                {TRUST_ROW.map((t, i) => (
                  <div key={t} className="flex items-center gap-1.5 text-[11px]" style={{ color: "rgba(255,255,255,0.5)" }}>
                    {i === 0 ? (
                      <ShieldCheck className="h-3.5 w-3.5" style={{ color: VIOLET }} />
                    ) : (
                      <Check className="h-3 w-3" style={{ color: "rgba(255,255,255,0.4)" }} />
                    )}
                    {t}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
