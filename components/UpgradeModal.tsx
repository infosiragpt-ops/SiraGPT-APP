"use client"

import * as React from "react"
import { motion } from "framer-motion"
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

const upgradePlans: UpgradePlan[] = [
  {
    id: "PRO",
    name: "Pro",
    eyebrow: "Acceso completo",
    price: "$5",
    subtitle: "Toda la IA de SiraGPT en una sola cuenta. El plan con el que la mayoría empieza.",
    icon: Crown,
    featured: true,
    cta: "Empezar con Pro",
    features: [
      { icon: Sparkles, title: "Todos los modelos líderes", desc: "GPT, Claude, Gemini, Grok y más, sin cambiar de app" },
      { icon: FileText, title: "Chat, documentos y código", desc: "Crea, analiza y edita en un mismo lugar" },
      { icon: ImageIcon, title: "Imagen, voz, video y música", desc: "Generación creativa con IA, integrada" },
      { icon: Rocket, title: "Agentes y proyectos", desc: "Investigación y tareas que se ejecutan solas" },
    ],
  },
  {
    id: "PRO_MAX",
    name: "Pro Extendido",
    eyebrow: "Más capacidad",
    price: "$10",
    subtitle: "La experiencia completa de Pro con mucho más volumen para trabajar a diario.",
    icon: Rocket,
    cta: "Elegir Pro Extendido",
    features: [
      { icon: Crown, title: "Todo lo de Pro incluido", desc: "Acceso completo a cada función" },
      { icon: Globe, title: "Mucho más volumen de uso", desc: "Para producir sin frenar cada día" },
      { icon: Rocket, title: "Ideal para uso intensivo", desc: "Proyectos frecuentes y equipos pequeños" },
      { icon: ShieldCheck, title: "Prioridad superior", desc: "Soporte y continuidad reforzados" },
    ],
  },
  {
    id: "ENTERPRISE",
    name: "Enterprise",
    eyebrow: "A medida",
    price: "Enterprise",
    subtitle: "Para equipos, empresas y requerimientos especiales.",
    icon: Building2,
    cta: "Comunícate al WhatsApp",
    features: [
      { icon: Building2, title: "Equipos", desc: "Configuración para operación interna" },
      { icon: ShieldCheck, title: "Seguridad", desc: "Revisión de necesidades por caso" },
      { icon: Globe, title: "Integraciones", desc: "Flujos y herramientas conectadas" },
      { icon: MessageCircle, title: "Atención directa", desc: "Acompañamiento por WhatsApp" },
    ],
  },
]

function FeatureRow({ icon: Icon, title, desc }: { icon: typeof Crown; title: string; desc: string }) {
  return (
    <div className="flex gap-3 py-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium leading-5 text-foreground">{title}</div>
        <div className="text-xs leading-5 text-muted-foreground">{desc}</div>
      </div>
    </div>
  )
}

export default function UpgradeModal({ open, onOpenChange, user, onSubscribe, isSubscribing }: UpgradeModalProps) {
  const [loadingPlan, setLoadingPlan] = React.useState<Plan | null>(null)
  const { user: authUser } = useAuth()
  const currentUser = authUser || user
  const currentPlan = (currentUser?.plan || "FREE") as Plan
  const apiUsage = currentUser?.apiUsage ?? 0
  const monthlyLimit = currentUser?.monthlyLimit ?? 0
  const usageRatio = monthlyLimit > 0 ? apiUsage / monthlyLimit : 0

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
          data?.message || "El procesamiento de pagos aún no está configurado. Contacta a soporte.",
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[96vw] max-w-5xl overflow-y-auto border-border/70 bg-background p-0 shadow-2xl">
        <div className="relative overflow-hidden border-b border-border/60 px-6 py-6 sm:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-40%,rgba(124,58,237,0.14),transparent_55%)]" />
          <div className="relative">
            <DialogHeader>
              <div className="mb-3 inline-flex w-fit items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-violet-600 dark:text-violet-300">
                <Sparkles className="h-3.5 w-3.5" />
                SiraGPT Pro
              </div>
              <DialogTitle className="max-w-2xl text-balance text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">
                Una sola suscripción. Toda la IA.
              </DialogTitle>
            </DialogHeader>

            <div className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl">
                Los mejores modelos, generación de imagen, voz y video, agentes y documentos — todo integrado y listo para producir desde el primer día.
              </p>
              <div className="shrink-0 rounded-full border border-border/70 px-3 py-1 text-xs">
                Plan actual: <span className="font-medium text-foreground">{currentPlan}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 py-6 sm:px-8">
          {usageRatio >= 0.7 ? (
            <div className="mb-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200">
              <div className="font-medium">Tu actividad del mes está alta.</div>
              <p className="mt-1 text-amber-800/80 dark:text-amber-200/80">
                Mejora tu plan para mantener continuidad y trabajar sin interrupciones.
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {upgradePlans.map((plan, index) => {
              const Icon = plan.icon
              const isCurrent = currentPlan === plan.id
              const isLoading = loadingPlan === plan.id || isSubscribing
              const isEnterprise = plan.id === "ENTERPRISE"

              return (
                <motion.article
                  key={plan.id}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: "easeOut", delay: index * 0.07 }}
                  className={`relative flex min-h-[470px] flex-col rounded-[26px] border p-5 transition-all duration-200 ${
                    plan.featured
                      ? "border-violet-500/25 bg-card shadow-xl shadow-violet-500/10 ring-1 ring-violet-500/20"
                      : "border-border/70 bg-card/45 hover:border-foreground/20 hover:bg-card/70"
                  }`}
                >
                  {plan.featured ? (
                    <div className="absolute right-5 top-5 rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-1 text-[11px] font-medium text-violet-600 shadow-sm dark:text-violet-300">
                      Recomendado
                    </div>
                  ) : null}

                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-current/10 bg-current/[0.04]">
                    <Icon className="h-5 w-5" />
                  </div>

                  <div className="mt-6">
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      {plan.eyebrow}
                    </div>
                    <h3 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">{plan.name}</h3>
                    <p className="mt-3 min-h-[44px] text-sm leading-6 text-muted-foreground">
                      {plan.subtitle}
                    </p>
                  </div>

                  <div className="mt-6 border-t border-current/10 pt-6">
                    <div className="text-4xl font-semibold tracking-[-0.05em]">{plan.price}</div>
                    {plan.id !== "ENTERPRISE" ? (
                      <div className="mt-1 text-xs text-muted-foreground">Facturación mensual</div>
                    ) : (
                      <div className="mt-1 text-xs text-muted-foreground">Comunicación directa por WhatsApp</div>
                    )}
                  </div>

                  <div className="mt-5 flex-1 divide-y divide-border/50">
                    {plan.features.map((feature) => (
                      <FeatureRow key={feature.title} {...feature} />
                    ))}
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isCurrent || !!isLoading}
                    onClick={() => subscribe(plan.id)}
                    className={`mt-6 h-11 w-full rounded-full ${plan.featured ? "border-foreground bg-foreground text-background hover:bg-foreground/90 hover:text-background" : ""}`}
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
                </motion.article>
              )
            })}
          </div>

          <div className="mt-6 flex flex-col items-center justify-center gap-1 text-center text-[11px] text-muted-foreground">
            <div className="inline-flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5" />
              Pago seguro con Stripe · Cancela cuando quieras · Sin permanencia
            </div>
            <div>Precios en USD — se cobra en tu moneda local al tipo de cambio del día.</div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
