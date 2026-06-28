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
  onSubscribe?: (plan: Exclude<Plan, "FREE">) => Promise<void>
  isSubscribing?: boolean
}

// Brand palette for the upgrade modal.
const ACCENT = "#FF0000"
const ACCENT_RGB = "255,0,0"
const INK = "#0a0a0a"
const BODY = "#525252"
const MUTED = "#737373"
const BORDER = "rgba(10,10,10,0.10)"
const accentAlpha = (alpha: number) => `rgba(${ACCENT_RGB},${alpha})`

const POSITIONING = {
  eyebrow: "Todos los modelos. Todas las capacidades. Una cuenta.",
  headline: "Toda la IA de frontera, por una fracción del precio de una sola.",
  subhead:
    "GPT, Claude, Gemini, Grok y más — con imagen, voz, video, documentos, código y agentes integrados. Otros te venden un modelo de un solo proveedor; SiraGPT te los da todos desde $5/mes.",
}

const TRUST_ROW = [
  "Pago seguro con Stripe",
  "Cancela cuando quieras, sin permanencia",
  "Precio fijo, sin cargos ocultos",
  "Precios en USD, se cobra en tu moneda local",
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
      { icon: Sparkles, title: "Cambia de modelo sin cambiar de app", desc: "GPT, Claude, Gemini, Grok y más en un solo chat." },
      { icon: ImageIcon, title: "Crea en cualquier formato", desc: "Imagen, voz, video, música, documentos y código." },
      { icon: FileText, title: "Convierte ideas en entregables", desc: "34 herramientas visuales en segundos." },
      { icon: Rocket, title: "Agentes que trabajan por ti", desc: "Investigación y tareas multi-paso que se ejecutan solas." },
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
      { icon: Globe, title: "El doble de capacidad mensual", desc: "Para quien usa IA todos los días." },
      { icon: Crown, title: "Todo Pro, sin recortes", desc: "Cada modelo, herramienta y agente, igual." },
      { icon: Sparkles, title: "La mitad de una sola rival", desc: "$10 vs los $20 de ChatGPT, Claude o Gemini." },
      { icon: ShieldCheck, title: "Prioridad y soporte reforzados", desc: "Continuidad superior para proyectos frecuentes." },
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
      { icon: Building2, title: "Espacios de equipo compartidos", desc: "Contexto común y trabajo multi-usuario." },
      { icon: ShieldCheck, title: "Seguridad de nivel empresa", desc: "SSO, listas de IP y accesos por rol." },
      { icon: Globe, title: "Integraciones a tu flujo", desc: "Slack, GitHub y tus APIs internas." },
      { icon: MessageCircle, title: "Onboarding y soporte directo", desc: "Acompañamiento por WhatsApp y SLA a medida." },
    ],
  },
]

function FeatureRow({ icon: Icon, title, desc, featured }: { icon: typeof Crown; title: string; desc: string; featured?: boolean }) {
  return (
    <div className="flex gap-2.5 py-1.5">
      <div
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
        style={{
          border: `1px solid ${featured ? accentAlpha(0.35) : BORDER}`,
          background: featured ? accentAlpha(0.10) : "rgba(10,10,10,0.03)",
          color: featured ? ACCENT : MUTED,
        }}
      >
        <Icon className="h-3 w-3" />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold leading-4" style={{ color: INK }}>{title}</div>
        <div className="text-[11px] leading-4" style={{ color: MUTED }}>{desc}</div>
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
    const message = encodeURIComponent("Hola 👋, me interesa el plan Enterprise de SiraGPT. ¿Podrían ayudarme?")
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
        toast.error(data?.message || "El procesamiento de pagos aún no está disponible. Contacta a soporte.", { duration: 6000 })
      } else if (status === 401) {
        toast.error("Tu sesión expiró — inicia sesión de nuevo.")
      } else {
        toast.error(err?.message || "Falló la suscripción")
      }
    } finally {
      setLoadingPlan(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[96vw] max-w-5xl overflow-y-auto border-0 p-0"
        style={{ maxHeight: "94vh", background: "#ffffff", color: INK, boxShadow: "0 40px 120px -24px rgba(10,10,10,0.45)" }}
      >
        <div className="relative">
          <div className="relative px-5 py-6 sm:px-7">
            {/* Header — compact */}
            <DialogHeader>
              <div
                className="mb-2.5 inline-flex w-fit items-center gap-2 rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]"
                style={{ border: `1px solid ${BORDER}`, background: accentAlpha(0.06), color: BODY }}
              >
                <Sparkles className="h-3.5 w-3.5" style={{ color: ACCENT }} />
                {POSITIONING.eyebrow}
              </div>
              <DialogTitle className="max-w-3xl text-balance text-xl font-semibold tracking-[-0.03em] sm:text-[26px] sm:leading-[1.12]" style={{ color: INK }}>
                {POSITIONING.headline}
              </DialogTitle>
            </DialogHeader>

            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <p className="max-w-2xl text-[13px] leading-5" style={{ color: BODY }}>
                {POSITIONING.subhead}
              </p>
              <div className="hidden shrink-0 rounded-full px-3 py-1 text-xs sm:block" style={{ border: `1px solid ${BORDER}`, color: MUTED }}>
                Plan actual: <span style={{ color: INK, fontWeight: 600 }}>{currentPlan}</span>
              </div>
            </div>

            {/* Value-anchor banner */}
            <div
              className="mt-3.5 rounded-xl px-4 py-2.5 text-[13px] leading-5"
              style={{ border: `1px solid ${accentAlpha(0.25)}`, background: accentAlpha(0.05), color: BODY }}
            >
              Una sola suscripción de ChatGPT, Claude o Gemini cuesta{" "}
              <span style={{ color: ACCENT, fontWeight: 700 }}>$20/mes</span> — y trae un solo proveedor. SiraGPT te da{" "}
              <span style={{ color: INK, fontWeight: 700 }}>todos los modelos líderes</span> más imagen, voz, video, documentos, código y agentes{" "}
              <span style={{ color: ACCENT, fontWeight: 700 }}>desde $5/mes</span>.
            </div>

            {usageRatio >= 0.7 ? (
              <div className="mt-3 flex items-center gap-2 rounded-xl px-3.5 py-2 text-[13px]" style={{ border: `1px solid ${BORDER}`, background: accentAlpha(0.04), color: BODY }}>
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: ACCENT }} />
                Has usado <span style={{ color: INK, fontWeight: 700 }}>{usagePct}%</span> de tu actividad este mes. Mejora tu plan para seguir sin interrupciones.
              </div>
            ) : null}

            {/* Plans — compact, fits one screen */}
            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
              {upgradePlans.map((plan, idx) => {
                const Icon = plan.icon
                const isCurrent = currentPlan === plan.id
                const isLoading = loadingPlan === plan.id || isSubscribing
                const isEnterprise = plan.id === "ENTERPRISE"
                const featured = !!plan.featured

                return (
                  <motion.article
                    key={plan.id}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, delay: reduceMotion ? 0 : idx * 0.06, ease: [0.22, 1, 0.36, 1] }}
                    className="relative flex flex-col rounded-2xl p-4"
                    style={{
                      border: featured ? `1.5px solid ${ACCENT}` : `1px solid ${BORDER}`,
                      background: featured ? accentAlpha(0.04) : "#ffffff",
                      boxShadow: featured ? `0 18px 44px -22px ${accentAlpha(0.55)}` : "0 1px 2px rgba(10,10,10,0.04)",
                    }}
                  >
                    <div className="relative flex flex-1 flex-col">
                      <div className="flex items-center justify-between">
                        <div
                          className="flex h-9 w-9 items-center justify-center rounded-xl"
                          style={{ border: `1px solid ${BORDER}`, background: "rgba(10,10,10,0.02)", color: featured ? ACCENT : INK }}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        {plan.badge ? (
                          <motion.div
                            initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.3, delay: 0.12 }}
                            className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide"
                            style={{ background: ACCENT, color: "#fff" }}
                          >
                            {plan.badge}
                          </motion.div>
                        ) : null}
                      </div>

                      <div className="mt-3.5">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: MUTED }}>{plan.eyebrow}</div>
                        <h3 className="mt-1.5 text-xl font-semibold tracking-[-0.02em]" style={{ color: INK }}>{plan.name}</h3>
                        <p className="mt-1.5 text-[12px] leading-4" style={{ color: BODY }}>{plan.subtitle}</p>
                      </div>

                      <div className="mt-3 flex items-baseline gap-1.5">
                        <span className="text-[34px] font-semibold leading-none tracking-[-0.04em]" style={{ color: INK }}>{plan.price}</span>
                        {!isEnterprise ? <span className="text-[13px]" style={{ color: MUTED }}>/mes</span> : null}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: MUTED }}>
                        {isEnterprise ? "Comunicación directa por WhatsApp" : "Facturación mensual · cancela cuando quieras"}
                      </div>

                      <div className="mt-3 flex-1 border-t pt-2" style={{ borderColor: BORDER }}>
                        {plan.features.map((feature) => (
                          <FeatureRow key={feature.title} {...feature} featured={featured} />
                        ))}
                      </div>

                      <Button
                        size="sm"
                        disabled={isCurrent || !!isLoading}
                        onClick={() => subscribe(plan.id)}
                        className="mt-3 h-10 w-full rounded-full border-0 text-[13px] font-semibold"
                        style={
                          featured
                            ? { background: ACCENT, color: "#fff" }
                            : { background: "#fff", color: INK, border: `1px solid ${BORDER}` }
                        }
                      >
                        {isCurrent ? (
                          <><Check className="mr-2 h-4 w-4" />Plan actual</>
                        ) : isEnterprise ? (
                          <><MessageCircle className="mr-2 h-4 w-4" />{plan.cta}</>
                        ) : (
                          plan.cta
                        )}
                      </Button>
                    </div>
                  </motion.article>
                )
              })}
            </div>

            {/* Footer: free-plan exit + honesty + trust, all on one compact row block */}
            <div className="mt-4 flex flex-col items-center gap-2 border-t pt-3 text-center" style={{ borderColor: BORDER }}>
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                {TRUST_ROW.map((t, i) => (
                  <span key={t} className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: MUTED }}>
                    {i === 0 ? <ShieldCheck className="h-3.5 w-3.5" style={{ color: ACCENT }} /> : <Check className="h-3 w-3" style={{ color: MUTED }} />}
                    {t}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-[12px] underline-offset-4 transition-colors hover:underline"
                style={{ color: MUTED }}
              >
                Seguir con el plan gratis · FlashGPT es gratis e ilimitado, siempre.
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
