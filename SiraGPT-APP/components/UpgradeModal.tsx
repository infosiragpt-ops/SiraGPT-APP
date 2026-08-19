"use client"

import * as React from "react"
import { motion, useReducedMotion } from "framer-motion"
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
  accent: string
  accentRgb: string
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
    "GPT, Claude, Gemini, Grok y más con imagen, voz, video, documentos, código y agentes integrados. SiraGPT reúne todo en una experiencia simple desde $5/mes.",
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
    subtitle: "Sigue usando SiraGPT con acceso básico y FlashGPT gratis e ilimitado.",
    icon: Sparkles,
    cta: "Seguir con Gratis",
    accent: "#e8e2d8",
    accentRgb: "232,226,216",
    capacity: "Acceso inicial",
    accessLine: "FlashGPT gratis e ilimitado, siempre.",
    features: [
      { icon: Zap, title: "FlashGPT sin costo", desc: "Para preguntas rápidas y uso diario básico." },
      { icon: MessageCircle, title: "Tus chats se conservan", desc: "Mantén tu cuenta y sube cuando lo necesites." },
      { icon: ShieldCheck, title: "Sin permanencia", desc: "Puedes cambiar de plan en cualquier momento." },
    ],
  },
  {
    id: "PRO",
    name: "Pro",
    eyebrow: "El que la mayoría elige",
    price: "$5",
    priceSuffix: "/mes",
    subtitle: "Toda la IA de SiraGPT en una cuenta. El punto de partida perfecto.",
    icon: Crown,
    featured: true,
    badge: "Más popular",
    cta: "Empezar con Pro",
    accent: "#ff3b30",
    accentRgb: "255,59,48",
    capacity: "Todos los modelos",
    accessLine: "GPT, Claude, Gemini, Grok y más en un solo chat.",
    features: [
      { icon: Sparkles, title: "Cambia de modelo sin cambiar de app", desc: "Todos los modelos líderes en una sola cuenta." },
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
    priceSuffix: "/mes",
    subtitle: "Todo lo de Pro con el doble de volumen para producir sin frenar.",
    icon: Rocket,
    cta: "Elegir Pro Extendido",
    accent: "#6255ff",
    accentRgb: "98,85,255",
    capacity: "Doble capacidad",
    accessLine: "Para quien usa IA todos los días sin recortar herramientas.",
    features: [
      { icon: Globe, title: "El doble de capacidad mensual", desc: "Más volumen para tareas largas y frecuentes." },
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
    accent: "#d8a900",
    accentRgb: "216,169,0",
    capacity: "Equipo y seguridad",
    accessLine: "Configuración, soporte e integraciones a la medida.",
    features: [
      { icon: Building2, title: "Espacios de equipo compartidos", desc: "Contexto común y trabajo multi-usuario." },
      { icon: ShieldCheck, title: "Seguridad de nivel empresa", desc: "SSO, listas de IP y accesos por rol." },
      { icon: Globe, title: "Integraciones a tu flujo", desc: "Slack, GitHub y tus APIs internas." },
      { icon: MessageCircle, title: "Onboarding y soporte directo", desc: "Acompañamiento por WhatsApp y SLA a medida." },
    ],
  },
]

function isPaidPlan(plan: Plan): plan is Exclude<Plan, "FREE"> {
  return plan !== "FREE"
}

function FeatureRow({
  icon: Icon,
  title,
  desc,
  active,
}: PlanFeature & { active?: boolean }) {
  return (
    <div className="flex gap-2.5 py-1.5">
      <div
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border"
        style={{
          borderColor: active ? "rgba(var(--plan-rgb),0.42)" : "rgba(255,255,255,0.16)",
          background: active ? "rgba(var(--plan-rgb),0.18)" : "rgba(255,255,255,0.08)",
          color: active ? "var(--plan-accent)" : "rgba(255,255,255,0.78)",
        } as React.CSSProperties}
      >
        <Icon className="h-3 w-3" />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold leading-4 text-white">{title}</div>
        <div className="text-[11px] leading-4 text-white/[0.58]">{desc}</div>
      </div>
    </div>
  )
}

export default function UpgradeModal({ open, onOpenChange, user, onSubscribe, isSubscribing }: UpgradeModalProps) {
  const [loadingPlan, setLoadingPlan] = React.useState<Plan | null>(null)
  const [hoveredPlan, setHoveredPlan] = React.useState<Plan | null>(null)
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
        className="w-[96vw] max-w-[1320px] overflow-hidden border border-white/[0.15] bg-[#111111] p-0 text-white shadow-[0_40px_140px_-28px_rgba(0,0,0,0.82)] [&>button]:right-5 [&>button]:top-3 [&>button]:rounded-full [&>button]:border [&>button]:border-white/[0.15] [&>button]:bg-black/25 [&>button]:p-2 [&>button]:text-white/80 [&>button]:backdrop-blur-xl [&>button]:transition-colors [&>button]:hover:bg-white/[0.15] [&>button]:hover:text-white"
        style={{ maxHeight: "92vh", borderRadius: 28 }}
      >
        <style>{`
          @keyframes siragptLiquidFlow {
            0% { transform: translate3d(-2%, -1%, 0) scale(1); opacity: .88; }
            50% { transform: translate3d(2%, 1%, 0) scale(1.02); opacity: 1; }
            100% { transform: translate3d(-2%, -1%, 0) scale(1); opacity: .88; }
          }
          .siragpt-upgrade-scroll::-webkit-scrollbar { width: 10px; }
          .siragpt-upgrade-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,.07); border-radius: 999px; }
          .siragpt-upgrade-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.42); border-radius: 999px; border: 2px solid rgba(20,20,20,.55); }
          .siragpt-liquid-card {
            background:
              linear-gradient(155deg, rgba(255,255,255,.24), rgba(255,255,255,.08) 44%, rgba(255,255,255,.13)),
              linear-gradient(22deg, rgba(var(--plan-rgb),.20), transparent 54%),
              rgba(255,255,255,.08);
            box-shadow: inset 0 1px 0 rgba(255,255,255,.24), 0 22px 70px -42px rgba(0,0,0,.95);
            backdrop-filter: blur(28px) saturate(150%);
            -webkit-backdrop-filter: blur(28px) saturate(150%);
          }
          .siragpt-liquid-card::before {
            content: "";
            position: absolute;
            inset: 0;
            pointer-events: none;
            background: linear-gradient(115deg, rgba(255,255,255,.22), transparent 27%, rgba(255,255,255,.08) 55%, transparent 76%);
            opacity: 0;
            transition: opacity .24s ease;
          }
          .siragpt-liquid-card:hover::before,
          .siragpt-liquid-card:focus-within::before {
            opacity: 1;
          }
        `}</style>

        <div className="relative overflow-hidden" style={{ borderRadius: 28 }}>
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(120deg, #090909 0%, #2b2926 22%, #5b626b 52%, #353033 74%, #080808 100%)",
            }}
          />
          <div
            className="absolute inset-[-12%]"
            style={{
              animation: reduceMotion ? undefined : "siragptLiquidFlow 12s ease-in-out infinite",
              background:
                "linear-gradient(105deg, rgba(255,59,48,.26), transparent 28%, rgba(98,85,255,.26) 51%, transparent 66%, rgba(216,169,0,.22))",
              filter: "blur(44px)",
            }}
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0.03)_34%,rgba(0,0,0,0.28))]" />

          <div className="siragpt-upgrade-scroll relative max-h-[92vh] overflow-y-auto px-5 py-6 sm:px-7 lg:px-8">
            <DialogHeader className="relative z-10 pt-7 sm:pt-0">
              <div className="mb-3 inline-flex w-fit max-w-[calc(100%-4.5rem)] items-center gap-2 rounded-full border border-white/[0.16] bg-white/[0.12] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/[0.78] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-xl sm:max-w-none">
                <Sparkles className="h-3.5 w-3.5 text-[#ff6b61]" />
                {POSITIONING.eyebrow}
              </div>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <DialogTitle className="max-w-4xl text-balance text-2xl font-semibold tracking-[-0.03em] text-white sm:text-[34px] sm:leading-[1.06]">
                    {POSITIONING.headline}
                  </DialogTitle>
                  <p className="mt-3 max-w-3xl text-[13px] leading-5 text-white/70 sm:text-sm">
                    {POSITIONING.subhead}
                  </p>
                  <DialogDescription className="sr-only">
                    {POSITIONING.subhead}
                  </DialogDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2 rounded-full border border-white/[0.15] bg-black/[0.18] px-3 py-2 text-xs text-white/70 backdrop-blur-xl">
                  <span>Plan actual:</span>
                  <span className="font-semibold text-white">{currentPlan}</span>
                </div>
              </div>
            </DialogHeader>

            <div className="relative z-10 mt-5 grid gap-3 lg:grid-cols-[1.35fr_.9fr]">
              <div className="rounded-2xl border border-white/[0.14] bg-white/10 px-4 py-3 text-[13px] leading-5 text-white/[0.72] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-2xl">
                Una sola suscripción de ChatGPT, Claude o Gemini cuesta{" "}
                <span className="font-bold text-white">$20/mes</span>. SiraGPT te da{" "}
                <span className="font-bold text-white">todos los modelos líderes</span>, formatos creativos, documentos, código y agentes{" "}
                <span className="font-bold text-[#ff6b61]">desde $5/mes</span>.
              </div>
              {usageRatio >= 0.7 ? (
                <div className="flex items-center gap-3 rounded-2xl border border-[#ff6b61]/25 bg-[#ff3b30]/[0.12] px-4 py-3 text-[13px] text-white/[0.76] backdrop-blur-2xl">
                  <span className="h-2 w-2 rounded-full bg-[#ff6b61]" />
                  <span>
                    Has usado <strong className="text-white">{usagePct}%</strong> de tu actividad este mes. Mejora tu plan para seguir sin interrupciones.
                  </span>
                </div>
              ) : (
                <div className="rounded-2xl border border-white/[0.14] bg-black/[0.14] px-4 py-3 text-[13px] leading-5 text-white/[0.68] backdrop-blur-2xl">
                  Todos los planes mantienen tu cuenta, historial y acceso a las capacidades de SiraGPT.
                </div>
              )}
            </div>

            <div className="relative z-10 mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              {upgradePlans.map((plan, idx) => {
                const Icon = plan.icon
                const isCurrent = currentPlan === plan.id
                const isHovered = hoveredPlan === plan.id
                const isLoading = loadingPlan === plan.id || isSubscribing
                const isEnterprise = plan.id === "ENTERPRISE"
                const isFree = plan.id === "FREE"
                const isActive = isCurrent || isHovered || plan.featured
                const topLabel = isCurrent ? "plan actual" : isHovered ? "seleccionar este plan" : plan.badge

                return (
                  <motion.article
                    key={plan.id}
                    initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.28, delay: reduceMotion ? 0 : idx * 0.055, ease: [0.22, 1, 0.36, 1] }}
                    onMouseEnter={() => setHoveredPlan(plan.id)}
                    onMouseLeave={() => setHoveredPlan(null)}
                    onFocus={() => setHoveredPlan(plan.id)}
                    onBlur={() => setHoveredPlan(null)}
                    className="siragpt-liquid-card group relative flex min-h-[610px] overflow-hidden rounded-[22px] border p-0"
                    style={{
                      "--plan-accent": plan.accent,
                      "--plan-rgb": plan.accentRgb,
                      borderColor: isCurrent || isHovered ? `rgba(${plan.accentRgb},0.72)` : "rgba(255,255,255,0.22)",
                    } as React.CSSProperties}
                  >
                    <div
                      className="absolute inset-x-0 top-0 flex h-7 items-center justify-center text-[10px] font-bold uppercase tracking-[0.08em] text-white transition-opacity duration-200"
                      style={{
                        background: isCurrent || isHovered ? plan.accent : "rgba(255,255,255,0.14)",
                        color: plan.id === "FREE" && (isCurrent || isHovered) ? "#141414" : "#fff",
                        opacity: topLabel ? 1 : 0,
                      }}
                    >
                      {topLabel ? <Check className="mr-1.5 h-3 w-3" /> : null}
                      {topLabel}
                    </div>

                    <div className="relative flex min-w-0 flex-1 flex-col px-4 pb-4 pt-12 sm:px-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/[0.52]">{plan.eyebrow}</div>
                          <h3 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-white">{plan.name}</h3>
                        </div>
                        <div
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/[0.18] bg-white/[0.12] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                          style={{ color: isActive ? plan.accent : "rgba(255,255,255,0.78)" }}
                        >
                          <Icon className="h-[18px] w-[18px]" />
                        </div>
                      </div>

                      <div className="mt-6">
                        <div className="flex min-h-[48px] items-baseline gap-1.5">
                          <span className="text-[40px] font-semibold leading-none tracking-[-0.05em] text-white sm:text-[43px]">
                            {plan.price}
                          </span>
                          {plan.priceSuffix ? <span className="text-xs font-semibold text-white/[0.62]">{plan.priceSuffix}</span> : null}
                        </div>
                        <p className="mt-4 min-h-[40px] text-[12px] leading-5 text-white/[0.68]">{plan.subtitle}</p>
                      </div>

                      <Button
                        size="sm"
                        disabled={isCurrent || !!isLoading}
                        onClick={() => handlePlanAction(plan.id)}
                        className="mt-5 h-10 w-full rounded-full border-0 px-4 text-[13px] font-semibold transition-all"
                        style={{
                          background: isCurrent
                            ? "rgba(255,255,255,0.18)"
                            : isActive
                              ? "rgba(255,255,255,0.92)"
                              : "rgba(0,0,0,0.30)",
                          color: isCurrent ? "rgba(255,255,255,0.78)" : isActive ? "#151515" : "#fff",
                          boxShadow: isActive ? `0 14px 34px -24px rgba(${plan.accentRgb},0.95)` : "inset 0 1px 0 rgba(255,255,255,0.12)",
                        }}
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

                      <div className="mt-5 border-t border-white/[0.14] pt-4">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/[0.45]">Capacidad operativa</div>
                        <div className="mt-2 flex items-center gap-2 text-[13px] font-semibold text-white">
                          <Zap className="h-4 w-4" style={{ color: plan.accent }} />
                          {plan.capacity}
                        </div>
                        <p className="mt-2 text-[11px] leading-4 text-white/[0.58]">{plan.accessLine}</p>
                      </div>

                      <div className="mt-5 border-t border-white/[0.14] pt-4">
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/[0.45]">Modelos incluidos</div>
                        <div className="space-y-1.5">
                          {MODEL_STACK.map((model) => (
                            <div key={model} className="flex items-center gap-2 text-[11px] font-semibold text-white/70">
                              <Layers3 className="h-3.5 w-3.5" style={{ color: plan.accent }} />
                              {model}
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="mt-5 flex-1 border-t border-white/[0.14] pt-4">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/[0.45]">Lo que desbloqueas</div>
                        {plan.features.map((feature) => (
                          <FeatureRow key={feature.title} {...feature} active={isActive} />
                        ))}
                      </div>
                    </div>
                  </motion.article>
                )
              })}
            </div>

            <div className="relative z-10 mt-5 flex flex-col items-center gap-3 border-t border-white/[0.12] pt-4 text-center">
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
                {TRUST_ROW.map((t, i) => (
                  <span key={t} className="inline-flex items-center gap-1.5 text-[11px] text-white/[0.58]">
                    {i === 0 ? <ShieldCheck className="h-3.5 w-3.5 text-[#ff6b61]" /> : <Check className="h-3 w-3 text-white/[0.45]" />}
                    {t}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-[12px] text-white/[0.58] underline-offset-4 transition-colors hover:text-white hover:underline"
              >
                Seguir con el plan gratis. FlashGPT es gratis e ilimitado, siempre.
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
