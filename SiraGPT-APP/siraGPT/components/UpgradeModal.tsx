"use client"

import * as React from "react"
import { useState, useEffect } from "react"
import { MessageSquare, Globe, ImageIcon, Mic, Video, Crown } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context-integrated"
import { apiClient } from "@/lib/api"

type Plan = "FREE" | "PRO" | "PRO_MAX" | "ENTERPRISE"

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

/** Local FeatureRow used inside modal */
function FeatureRow({ icon, title, desc, included = true }: { icon: React.ReactNode; title: string; desc: string; included?: boolean }) {
  return (
    <div className={`flex items-start gap-3 ${included ? '' : 'opacity-60'}`}>
      <div className="w-8 h-8 rounded-md bg-muted/20 flex items-center justify-center text-muted-foreground">
        {icon}
      </div>
      <div>
        <div className="font-medium text-sm">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
    </div>
  )
}

export default function UpgradeModal({ open, onOpenChange, user, onSubscribe, isSubscribing }: UpgradeModalProps) {
  const [loadingPlan, setLoadingPlan] = React.useState<Plan | null>(null)

  // Use auth context directly for the most up-to-date user data
  const { user: authUser } = useAuth()

  // Use auth context user if available, fallback to prop user
  const currentUser = authUser || user
  const currentPlan = currentUser?.plan || "FREE"
  const apiUsage = currentUser?.apiUsage ?? 0
  const monthlyLimit = currentUser?.monthlyLimit ?? 0
  const monthlyCallLimit = currentUser?.monthlyCallLimit ?? 0
  const remainingCalls = monthlyLimit - monthlyCallLimit

  const planMeta: Record<Exclude<Plan, "FREE">, { price: number; creditsLabel: string; monthlyLimit: number }> = {
    PRO: { price: 5, creditsLabel: "500.000 tokens / mes", monthlyLimit: 500000 },
    PRO_MAX: { price: 20, creditsLabel: "1.000.000 tokens / mes", monthlyLimit: 1000000 },
    ENTERPRISE: { price: 200, creditsLabel: "10.000.000 tokens / mes", monthlyLimit: 10000000 },
  }

  const subscribe = async (plan: Exclude<Plan, "FREE">) => {
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
          data?.message ||
            "El procesamiento de pagos aún no está configurado. Contacta a soporte.",
          { duration: 6000 }
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
      <DialogContent className="max-w-7xl w-[98%] md:w-11/12 lg:w-4/5 p-6 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl">Planes</DialogTitle>
        </DialogHeader>

        <div className="mt-6 flex flex-col gap-6">
          {/* Top summary row */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {currentUser ? (
                <div className="text-sm">
                  <div className="font-medium">{currentUser?.name || "Usuario"}</div>
                  <div className="text-xs text-muted-foreground">{currentUser?.email || ""}</div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <div>No has iniciado sesión</div>
                    <Button size="sm" variant="ghost" onClick={() => (window.location.href = "/auth/login")}>Iniciar sesión</Button>
                  </div>
                </div>
              )}
            </div>

            <div className="text-sm text-muted-foreground">
              <div>Plan: <strong>{currentPlan}</strong></div>
              <div className="text-xs">Uso de tokens: {apiUsage}</div>
            </div>
          </div>
          
         {/* Usage warning message */}
{monthlyLimit > 0 && (
  <>
    {/* Limit exceeded */}
    {apiUsage >= monthlyLimit ? (
      <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-red-500 rounded-full"></div>
          <div className="text-sm font-medium text-red-700 dark:text-red-400">
            Límite mensual alcanzado
          </div>
        </div>
        <p className="text-sm text-red-600 dark:text-red-300 mt-1">
          Has consumido todo tu límite mensual de la API.
          Mejora tu plan para seguir usando todas las funciones.
        </p>
      </div>

    ) : (apiUsage / monthlyLimit) >= 0.9 ? (
      /* 90% Warning */
      <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-red-500 rounded-full"></div>
          <div className="text-sm font-medium text-red-700 dark:text-red-400">
            Casi al límite
          </div>
        </div>
        <p className="text-sm text-red-600 dark:text-red-300 mt-1">
          Has usado {Math.round((apiUsage / monthlyLimit) * 100)}% de tu límite mensual de API.
          Mejora tu plan para seguir usando todas las funciones.
        </p>
      </div>

    ) : (apiUsage / monthlyLimit) >= 0.7 ? (
      /* 70% Warning */
      <div className="p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-orange-500 rounded-full"></div>
          <div className="text-sm font-medium text-orange-700 dark:text-orange-400">
            Acercándote al límite
          </div>
        </div>
        <p className="text-sm text-orange-600 dark:text-orange-300 mt-1">
          Has usado {Math.round((apiUsage / monthlyLimit) * 100)}% de tu límite mensual de API.
          Considera mejorar tu plan para evitar interrupciones.
        </p>
      </div>

    ) : null}
  </>
)}


          {/* Grid of plan cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* FREE */}
            <div className="rounded-2xl p-8 bg-gradient-to-b from-background/80 to-background/60 backdrop-blur-md border border-border/30 shadow-md min-h-[420px] flex flex-col transition hover:shadow-xl hover:scale-[1.02] duration-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">FREE</h3>
                  <div className="text-xs text-muted-foreground mt-1">Acceso básico</div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold">Gratis</div>
                  <div className="text-xs text-muted-foreground">3 llamadas / mes</div>
                </div>
              </div>

              <div className="mt-6 space-y-3 text-sm flex-1">
                <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Asistente conversacional" included />
                <FeatureRow icon={<Globe className="h-5 w-5" />} title="Búsqueda web" desc="Búsqueda web básica" included />
                <FeatureRow icon={<ImageIcon className="h-5 w-5" />} title="Generación de imágenes" desc="No incluido" included={false} />
                <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio (ElevenLabs)" desc="No incluido" included={false} />
                <FeatureRow icon={<Video className="h-5 w-5" />} title="Generación de video" desc="No incluido" included={false} />
              </div>

              <div className="mt-8 border-t border-border/30 pt-6 flex flex-col items-center gap-3">
                {currentPlan === "FREE" ? (
                  <Button size="sm" variant="outline" disabled className="w-full">Plan actual</Button>
                ) : (
                  // Free plan is not a "subscribe" option. Show informative disabled button.
                  <Button size="sm" variant="ghost" disabled className="w-full text-muted-foreground">
                    Gratis (por defecto)
                  </Button>
                )}
                <div className="text-xs text-muted-foreground text-center">
                  El plan gratuito es el predeterminado para nuevos usuarios — no es una suscripción de pago.
                </div>
              </div>
            </div>

            {/* PRO */}
            <div className="rounded-2xl p-8 bg-gradient-to-b from-white/10 to-white/5 border border-border/30 shadow-lg min-h-[400px] flex flex-col transition hover:shadow-xl hover:scale-[1.02] duration-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">PRO</h3>
                  <div className="text-xs text-muted-foreground mt-1">Todos los modelos, soporte prioritario</div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold">$5</div>
                  <div className="text-xs text-muted-foreground">500.000 tokens / mes</div>
                </div>
              </div>

              <div className="mt-6 space-y-3 text-sm">
                <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Todos los modelos" desc="GPT, Claude, Gemini, etc." included />
                <FeatureRow icon={<Globe className="h-5 w-5" />} title="Búsqueda web" desc="Resultados web integrados" included />
                <FeatureRow icon={<ImageIcon className="h-5 w-5" />} title="Generación de imágenes" desc="Incluido" included />
                <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio (ElevenLabs)" desc="No incluido" included={false} />
                <FeatureRow icon={<Video className="h-5 w-5" />} title="Generación de video" desc="No incluido" included={false} />
              </div>

              <div className="mt-8 border-t border-border/30 pt-6 flex flex-col items-center gap-3">
                {currentPlan === "PRO" ? (
                  <Button size="sm" variant="outline" disabled className="w-full">Plan actual</Button>
                ) : (
                  <Button size="sm" onClick={() => subscribe("PRO")} disabled={isSubscribing || !!loadingPlan} className="w-full">
                    Suscribirse
                  </Button>
                )}
              </div>
            </div>

            {/* PRO_MAX */}
            <div className="rounded-2xl p-8 bg-gradient-to-b from-primary/10 to-primary/5 border border-border/30 shadow-lg min-h-[400px] flex flex-col transition hover:shadow-xl hover:scale-[1.02] duration-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">PRO MAX</h3>
                  <div className="text-xs text-muted-foreground mt-1 h-4">Todo PRO + límites ampliados</div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold">$20</div>
                  <div className="text-xs text-muted-foreground h-4">1.000.000 tokens / mes</div>
                </div>
              </div>

              <div className="mt-6 space-y-3 text-sm">
                <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Todo lo de PRO" desc="Todas las funciones PRO" included />
                <FeatureRow icon={<Globe className="h-5 w-5" />} title="Búsqueda web" desc="Incluido" included />
                <FeatureRow icon={<ImageIcon className="h-5 w-5" />} title="Generación de imágenes" desc="Incluido" included />
                <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio (ElevenLabs)" desc="Incluido" included />
                <FeatureRow icon={<Video className="h-5 w-5" />} title="10 videos generados" desc="Incluido" included />
              </div>

              <div className="mt-8 border-t border-border/30 pt-6 flex flex-col items-center gap-3">
                {currentPlan === "PRO_MAX" ? (
                  <Button size="sm" variant="outline" disabled className="w-full">Plan actual</Button>
                ) : (
                  <Button size="sm" onClick={() => subscribe("PRO_MAX")} disabled={isSubscribing || !!loadingPlan} className="w-full">
                    Suscribirse
                  </Button>
                )}
              </div>
            </div>

            {/* ENTERPRISE */}
            <div className="rounded-2xl p-8 bg-gradient-to-b from-amber-900/10 to-amber-900/5 border border-border/30 shadow-lg min-h-[400px] flex flex-col transition hover:shadow-xl hover:scale-[1.02] duration-200">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">ENTERPRISE</h3>
                  <div className="text-xs text-muted-foreground mt-1 h-4">Todas las funciones, prioridad y SLAs</div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold">$200</div>
                  <div className="text-xs text-muted-foreground h-4">10.000.000 tokens / mes</div>
                </div>
              </div>

              <div className="mt-6 space-y-3 text-sm">
                <FeatureRow icon={<MessageSquare className="h-5 w-5" />} title="Chat (GPT)" desc="Incluido" included />
                <FeatureRow icon={<Video className="h-5 w-5" />} title="Generación de video" desc="Incluido" included />
                <FeatureRow icon={<Mic className="h-5 w-5" />} title="Audio y música avanzados" desc="Incluido" included />
                <FeatureRow icon={<Globe className="h-5 w-5" />} title="Prioridad y SLAs" desc="Incluido" included />
                <FeatureRow icon={<Crown className="h-5 w-5" />} title="Llamadas ilimitadas" desc="Incluido" included />
              </div>

              <div className="mt-8 border-t border-border/30 pt-6 flex flex-col items-center gap-3">
                {currentPlan === "ENTERPRISE" ? (
                  <Button size="sm" variant="outline" disabled className="w-full">Plan actual</Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      const whatsappNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER;
                      const isMobile = /Mobi|Android/i.test(navigator.userAgent);
                      const whatsappUrl =
                        // isMobile
                        //   ?
                        `https://wa.me/${whatsappNumber}`
                      // : `https://web.whatsapp.com/send?phone=${whatsappNumber}`;
                      window.open(whatsappUrl, "_blank", "noopener,noreferrer");
                    }}
                    disabled={isSubscribing || !!loadingPlan}
                    className="w-full flex items-center gap-2"
                  >
                    {/* <img src="/icons/whatsapp-logo.png" alt="WhatsApp" className="h-5 w-5" /> */}
                    <img src="/icons/whatsapp.png" alt="WhatsApp" className="w-6 h-6 invert dark:invert-0" />

                    Suscribirse
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-6">
          <div className="w-full text-xs text-muted-foreground">
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
