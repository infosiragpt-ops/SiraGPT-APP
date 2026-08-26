"use client"

/**
 * Upgrade console — strict monochrome edition.
 *
 * Design contract: black & white ONLY (grayscale surfaces, no brand or
 * accent hues), futurist-minimal typography, and the whole console fits
 * one viewport — the dialog is a fixed-height flex column and nothing
 * inside it scrolls.
 */

import * as React from "react"
import {
  ArrowUpRight,
  Building2,
  Check,
  Crown,
  FileText,
  Globe,
  ImageIcon,
  Layers3,
  MessageCircle,
  Rocket,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { useAuth } from "@/lib/auth-context-integrated"
import { apiClient } from "@/lib/api"

type Plan = "FREE" | "PRO" | "PRO_MAX" | "ENTERPRISE"

type PlanFeature = {
  icon: typeof Crown
  title: string
  desc: string
}

type UpgradePlan = {
  id: Plan
  name: string
  eyebrow: string
  price: string
  priceSuffix?: string
  subtitle: string
  icon: typeof Crown
  featured?: boolean
  badge?: string
  cta: string
  capacity: string
  accessLine: string
  features: PlanFeature[]
}

interface UpgradeModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  user?: any
  onSubscribe?: (plan: Exclude<Plan, "FREE">) => Promise<void>
  isSubscribing?: boolean
}

const POSITIONING = {
  eyebrow: "Todos los modelos. Todas las capacidades. Una cuenta.",
  headline: "Toda la IA de frontera, por una fracción del precio de una sola.",
  subhead:
    "GPT, Claude, Gemini, Grok y más con imagen, voz, video, documentos, código y agentes integrados desde $5/mes.",
}

const TRUST_ROW = [
  "Pago seguro con Stripe",
  "Cancela cuando quieras",
  "Precios en USD",
  "Sin cargos ocultos",
]

const MODEL_STACK = [
  "GPT 5.5",
  "Claude Sonnet 5",
  "Google Gemini 3.1 Pro",
  "Grok y modelos líderes",
]

const upgradePlans: UpgradePlan[] = [
  {
    id: "FREE",
    name: "Gratis",
    eyebrow: "Para probar SiraGPT",
    price: "Gratis",
    subtitle: "Acceso básico y FlashGPT gratis e ilimitado.",
    icon: Sparkles,
    cta: "Seguir con Gratis",
    capacity: "Acceso inicial",
    accessLine: "FlashGPT gratis e ilimitado, siempre.",
    features: [
      { icon: Zap, title: "FlashGPT sin costo", desc: "Preguntas rápidas y uso diario básico." },
      { icon: MessageCircle, title: "Tus chats se conservan", desc: "Sube de plan cuando lo necesites." },
      { icon: ShieldCheck, title: "Sin permanencia", desc: "Cambia de plan en cualquier momento." },
    ],
  },
  {
    id: "PRO",
    name: "Pro",
    eyebrow: "El que la mayoría elige",
    price: "$5",
    priceSuffix: "/mes",
    subtitle: "Toda la IA de SiraGPT en una cuenta.",
    icon: Crown,
    featured: true,
    badge: "Más popular",
    cta: "Empezar con Pro",
    capacity: "Todos los modelos",
    accessLine: "GPT, Claude, Gemini, Grok y más en un solo chat.",
    features: [
      { icon: Sparkles, title: "Cambia de modelo sin cambiar de app", desc: "Todos los modelos líderes en una cuenta." },
      { icon: ImageIcon, title: "Crea en cualquier formato", desc: "Imagen, voz, video, documentos y código." },
      { icon: FileText, title: "Ideas convertidas en entregables", desc: "34 herramientas visuales en segundos." },
      { icon: Rocket, title: "Agentes que trabajan por ti", desc: "Tareas multi-paso que se ejecutan solas." },
    ],
  },
  {
    id: "PRO_MAX",
    name: "Pro Extendido",
    eyebrow: "Para uso intensivo a diario",
    price: "$10",
    priceSuffix: "/mes",
    subtitle: "Todo lo de Pro con el doble de volumen.",
    icon: Rocket,
    cta: "Elegir Pro Extendido",
    capacity: "Doble capacidad",
    accessLine: "Para quien usa IA todos los días sin recortar.",
    features: [
      { icon: Globe, title: "El doble de capacidad mensual", desc: "Más volumen para tareas largas y frecuentes." },
      { icon: Crown, title: "Todo Pro, sin recortes", desc: "Cada modelo, herramienta y agente, igual." },
      { icon: Sparkles, title: "La mitad de una sola rival", desc: "$10 vs los $20 de ChatGPT o Claude." },
      { icon: ShieldCheck, title: "Prioridad y soporte reforzados", desc: "Continuidad superior para proyectos frecuentes." },
    ],
  },
  {
    id: "ENTERPRISE",
    name: "Enterprise",
    eyebrow: "A la medida de tu equipo",
    price: "Hablemos",
    subtitle: "Para equipos con necesidades específicas.",
    icon: Building2,
    cta: "Comunícate al WhatsApp",
    capacity: "Equipo y seguridad",
    accessLine: "Configuración, soporte e integraciones a la medida.",
    features: [
      { icon: Building2, title: "Espacios de equipo compartidos", desc: "Contexto común y trabajo multi-usuario." },
      { icon: ShieldCheck, title: "Seguridad de nivel empresa", desc: "SSO, listas de IP y accesos por rol." },
      { icon: Globe, title: "Integraciones a tu flujo", desc: "Slack, GitHub y tus APIs internas." },
      { icon: MessageCircle, title: "Onboarding y soporte directo", desc: "WhatsApp y SLA a medida." },
    ],
  },
]

function isPaidPlan(plan: Plan): plan is Exclude<Plan, "FREE"> {
  return plan !== "FREE"
}

function FeatureRow({ icon: Icon, title, desc, active }: PlanFeature & { active?: boolean }) {
  return (
    <div className="flex min-h-0 gap-2 py-[3px]">
      <div
        className={
          "mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full border " +
          (active
            ? "border-white/40 bg-white/15 text-white"
            : "border-white/15 bg-white/[0.06] text-white/70")
        }
      >
        <Icon className="h-2.5 w-2.5" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-[11.5px] font-semibold leading-4 text-white">{title}</div>
        <div className="truncate text-[10px] leading-[13px] text-white/[0.52]">{desc}</div>
      </div>
    </div>
  )
}

export default function UpgradeModal({ open, onOpenChange, user, onSubscribe, isSubscribing }: UpgradeModalProps) {
  const [loadingPlan, setLoadingPlan] = React.useState<Plan | null>(null)
  const [hoveredPlan, setHoveredPlan] = React.useState<Plan | null>(null)
  const { user: authUser } = useAuth()
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

  const handlePlanAction = (plan: Plan) => {
    if (!isPaidPlan(plan)) {
      onOpenChange(false)
      return
    }
    void subscribe(plan)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[94vh] w-[97vw] max-w-[1440px] flex-col overflow-hidden border border-white/[0.14] bg-[#0a0a0a] p-0 text-white shadow-[0_40px_140px_-28px_rgba(0,0,0,0.9)] [&>button]:right-4 [&>button]:top-4 [&>button]:rounded-full [&>button]:border [&>button]:border-white/[0.16] [&>button]:bg-white/[0.06] [&>button]:p-2 [&>button]:text-white/70 [&>button]:transition-colors [&>button]:hover:bg-white/[0.14] [&>button]:hover:text-white"
        style={{ borderRadius: 24 }}
      >
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-4 pt-5 lg:px-8">
          {/* Header — one compact band. */}
          <DialogHeader className="shrink-0 space-y-0">
            <div className="flex items-start justify-between gap-4 pr-12">
              <div className="min-w-0">
                <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/[0.16] bg-white/[0.05] px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-white/[0.65]">
                  <Sparkles className="h-3 w-3 text-white" />
                  {POSITIONING.eyebrow}
                </div>
                <DialogTitle className="mt-2 truncate text-[22px] font-semibold tracking-[-0.03em] text-white xl:text-[26px]">
                  {POSITIONING.headline}
                </DialogTitle>
                <p className="mt-1 truncate text-[12px] leading-5 text-white/[0.6]">
                  {POSITIONING.subhead}
                </p>
                <DialogDescription className="sr-only">{POSITIONING.subhead}</DialogDescription>
              </div>
              <div className="mt-1 flex shrink-0 items-center gap-2 rounded-full border border-white/[0.16] bg-white/[0.05] px-3 py-1.5 text-[11px] text-white/[0.65]">
                <span>Plan actual:</span>
                <span className="font-semibold text-white">{currentPlan}</span>
              </div>
            </div>
          </DialogHeader>

          {/* Value strip + usage — one thin monochrome line. */}
          <div className="mt-3 grid shrink-0 gap-2 lg:grid-cols-[1.4fr_.9fr]">
            <div className="truncate rounded-xl border border-white/[0.12] bg-white/[0.04] px-3.5 py-2 text-[11.5px] leading-5 text-white/[0.62]">
              Una sola suscripción rival cuesta <span className="font-bold text-white">$20/mes</span>. SiraGPT te da{" "}
              <span className="font-bold text-white">todos los modelos líderes</span>, formatos, código y agentes{" "}
              <span className="font-bold text-white underline underline-offset-2">desde $5/mes</span>.
            </div>
            {usageRatio >= 0.7 ? (
              <div className="flex items-center gap-2 truncate rounded-xl border border-white/[0.3] bg-white/[0.08] px-3.5 py-2 text-[11.5px] text-white/[0.75]">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white" />
                <span className="truncate">
                  Has usado <strong className="text-white">{usagePct}%</strong> de tu actividad este mes. Mejora tu plan para continuar.
                </span>
              </div>
            ) : (
              <div className="truncate rounded-xl border border-white/[0.12] bg-white/[0.03] px-3.5 py-2 text-[11.5px] leading-5 text-white/[0.55]">
                Todos los planes mantienen tu cuenta, historial y capacidades.
              </div>
            )}
          </div>

          {/* Plans — the grid absorbs all remaining height; nothing scrolls. */}
          <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-4">
            {upgradePlans.map((plan) => {
              const Icon = plan.icon
              const isCurrent = currentPlan === plan.id
              const isHovered = hoveredPlan === plan.id
              const isLoading = loadingPlan === plan.id || isSubscribing
              const isEnterprise = plan.id === "ENTERPRISE"
              const isFree = plan.id === "FREE"
              const isActive = isCurrent || isHovered || plan.featured
              const topLabel = isCurrent ? "plan actual" : isHovered ? "seleccionar este plan" : plan.badge

              return (
                <article
                  key={plan.id}
                  onMouseEnter={() => setHoveredPlan(plan.id)}
                  onMouseLeave={() => setHoveredPlan(null)}
                  onFocus={() => setHoveredPlan(plan.id)}
                  onBlur={() => setHoveredPlan(null)}
                  className={
                    "group relative flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-white/[0.035] transition-colors duration-150 " +
                    (isCurrent || isHovered ? "border-white/[0.75]" : plan.featured ? "border-white/[0.4]" : "border-white/[0.16]")
                  }
                >
                  {/* Status band — white on black, monochrome only. */}
                  <div
                    className={
                      "flex h-6 shrink-0 items-center justify-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.1em] transition-opacity duration-150 " +
                      (isCurrent || isHovered ? "bg-white text-black" : "bg-white/[0.1] text-white/85") +
                      (topLabel ? " opacity-100" : " opacity-0")
                    }
                  >
                    {topLabel ? <Check className="h-3 w-3" /> : null}
                    {topLabel}
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col px-4 pb-3.5 pt-3">
                    <div className="flex shrink-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[9.5px] font-semibold uppercase tracking-[0.16em] text-white/[0.45]">{plan.eyebrow}</div>
                        <h3 className="mt-1 truncate text-[17px] font-semibold tracking-[-0.02em] text-white">{plan.name}</h3>
                      </div>
                      <div
                        className={
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border " +
                          (isActive ? "border-white/[0.4] bg-white/[0.12] text-white" : "border-white/[0.16] bg-white/[0.06] text-white/70")
                        }
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                    </div>

                    <div className="mt-2 flex shrink-0 items-baseline gap-1.5">
                      <span className="text-[30px] font-semibold leading-none tracking-[-0.05em] text-white xl:text-[34px]">{plan.price}</span>
                      {plan.priceSuffix ? <span className="text-[11px] font-semibold text-white/[0.55]">{plan.priceSuffix}</span> : null}
                    </div>
                    <p className="mt-1.5 shrink-0 truncate text-[11px] leading-4 text-white/[0.6]">{plan.subtitle}</p>

                    <Button
                      size="sm"
                      disabled={isCurrent || !!isLoading}
                      onClick={() => handlePlanAction(plan.id)}
                      className={
                        "mt-2.5 h-9 w-full shrink-0 rounded-full border-0 px-4 text-[12px] font-semibold transition-colors " +
                        (isCurrent
                          ? "bg-white/[0.14] text-white/[0.7] hover:bg-white/[0.14]"
                          : isActive
                            ? "bg-white text-black hover:bg-white/90"
                            : "bg-white/[0.1] text-white hover:bg-white/[0.2]")
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
                      ) : isFree ? (
                        plan.cta
                      ) : (
                        <>
                          {plan.cta}
                          <ArrowUpRight className="ml-auto h-4 w-4" />
                        </>
                      )}
                    </Button>

                    <div className="mt-2.5 shrink-0 border-t border-white/[0.12] pt-2">
                      <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-white/[0.4]">Capacidad operativa</div>
                      <div className="mt-1 flex items-center gap-1.5 text-[12px] font-semibold text-white">
                        <Zap className="h-3.5 w-3.5 text-white/80" />
                        {plan.capacity}
                      </div>
                      <p className="mt-0.5 truncate text-[10px] leading-[14px] text-white/[0.5]">{plan.accessLine}</p>
                    </div>

                    <div className="mt-2 shrink-0 border-t border-white/[0.12] pt-2">
                      <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-white/[0.4]">Modelos incluidos</div>
                      <div className="space-y-[3px]">
                        {MODEL_STACK.map((model) => (
                          <div key={model} className="flex items-center gap-1.5 text-[10.5px] font-semibold text-white/[0.65]">
                            <Layers3 className="h-3 w-3 text-white/60" />
                            {model}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mt-2 min-h-0 flex-1 overflow-hidden border-t border-white/[0.12] pt-1.5">
                      <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-white/[0.4]">Lo que desbloqueas</div>
                      {plan.features.map((feature) => (
                        <FeatureRow key={feature.title} {...feature} active={isActive} />
                      ))}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>

          {/* Trust footer — one thin line. */}
          <div className="mt-2.5 flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-white/[0.1] pt-2 text-center">
            {TRUST_ROW.map((t, i) => (
              <span key={t} className="inline-flex items-center gap-1.5 text-[10px] text-white/[0.5]">
                {i === 0 ? <ShieldCheck className="h-3 w-3 text-white/70" /> : <Check className="h-2.5 w-2.5 text-white/[0.4]" />}
                {t}
              </span>
            ))}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-[10.5px] text-white/[0.5] underline-offset-4 transition-colors hover:text-white hover:underline"
            >
              Seguir con el plan gratis. FlashGPT es gratis e ilimitado, siempre.
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
