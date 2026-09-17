"use client"

/**
 * /planes — full-screen plans page (Claude-style).
 *
 * Exactly two plans, no toggles, no tiers:
 *   · Pro       — $10 USD/mes through Stripe Checkout (backend code PRO_MAX).
 *   · Hablemos  — teams/enterprise, opens WhatsApp with a pre-filled message.
 *
 * The top-left "Atrás" button returns to where the user came from (or to
 * /agentes when the page was opened directly). Card checkout availability
 * and the WhatsApp number are read at runtime from GET /api/payments/config
 * so production can be enabled from the backend .env alone — no rebuild.
 * When checkout is not live yet, the Pro card degrades to a WhatsApp
 * activation instead of surfacing a provider error.
 */

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Check, MessageCircle, ShieldCheck, Sprout, Users } from "lucide-react"
import { toast } from "sonner"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { useAuth } from "@/lib/auth-context-integrated"
import { apiClient } from "@/lib/api"
import { getPaymentsConfig } from "@/lib/plans-service"
import {
  CONTACT_PLAN,
  PAID_PLAN,
  PRO_WHATSAPP_MESSAGE,
  SALES_WHATSAPP_MESSAGE,
  SUPPORT_FALLBACK_PATH,
  buildWhatsAppHref,
  describeCheckoutError,
  isPaidPlanCode,
  planDisplayName,
  resolveWhatsAppNumber,
} from "@/lib/plans-catalog"

const PLANS_PATH = "/planes"
const LOGIN_HREF = `/auth/login?next=${encodeURIComponent(PLANS_PATH)}`

const CTA_BASE =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60 focus-visible:ring-offset-2"
const CTA_PRIMARY = `${CTA_BASE} bg-zinc-900 text-white hover:bg-black active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70`
const CTA_DISABLED = `${CTA_BASE} cursor-default border border-zinc-200 bg-zinc-100 text-zinc-500`

function openExternal(href: string) {
  window.open(href, "_blank", "noopener,noreferrer")
}

export default function PlanesPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()

  // null = unknown (still loading). We stay optimistic until the backend
  // tells us checkout is off, so a slow config request never blocks a sale.
  const [checkoutAvailable, setCheckoutAvailable] = React.useState<boolean | null>(null)
  const [runtimeNumber, setRuntimeNumber] = React.useState<string | null>(null)
  const [checkoutLoading, setCheckoutLoading] = React.useState(false)

  React.useEffect(() => {
    const controller = new AbortController()
    getPaymentsConfig(controller.signal)
      .then((config) => {
        setCheckoutAvailable(Boolean(config.checkoutAvailable))
        setRuntimeNumber(config.whatsappNumber || null)
      })
      .catch(() => {
        // Backend unreachable or old version without /config: keep the
        // optimistic path; a real 503 on checkout still degrades gracefully.
      })
    return () => controller.abort()
  }, [])

  const whatsappNumber = resolveWhatsAppNumber(runtimeNumber)
  const salesHref = buildWhatsAppHref(whatsappNumber, SALES_WHATSAPP_MESSAGE)
  const proWhatsAppHref = buildWhatsAppHref(whatsappNumber, PRO_WHATSAPP_MESSAGE)
  const canCheckout = checkoutAvailable !== false
  const currentPlan = user?.plan
  const alreadyPaid = isPaidPlanCode(currentPlan)

  const goBack = React.useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back()
      return
    }
    router.push("/agentes")
  }, [router])

  const startCheckout = React.useCallback(async () => {
    if (!user) {
      router.push(LOGIN_HREF)
      return
    }
    try {
      setCheckoutLoading(true)
      const response = await apiClient.createStripePayment({ plan: PAID_PLAN.code })
      if (!response?.url) throw new Error("No checkout URL received")
      // Hand off to Stripe Checkout; the success/cancel pages bring the user back.
      window.location.assign(response.url)
    } catch (err) {
      const info = describeCheckoutError(err)
      if (info.kind === "unavailable") {
        setCheckoutAvailable(false)
        if (info.whatsappNumber) setRuntimeNumber(info.whatsappNumber)
        const href = buildWhatsAppHref(info.whatsappNumber || whatsappNumber, PRO_WHATSAPP_MESSAGE)
        toast.error(info.message, {
          duration: 8000,
          action: href ? { label: "Abrir WhatsApp", onClick: () => openExternal(href) } : undefined,
        })
      } else if (info.kind === "auth") {
        toast.error(info.message)
        router.push(LOGIN_HREF)
      } else {
        toast.error(info.message)
      }
      setCheckoutLoading(false)
    }
  }, [router, user, whatsappNumber])

  return (
    <div
      // The app shell pins <body> (no document scroll), so the page owns its
      // scroll container — same pattern as /support and /payment/cancel.
      className="h-[var(--app-viewport-height,100dvh)] overflow-y-auto overflow-x-hidden overscroll-y-contain bg-[#faf9f5] text-zinc-900"
      style={{ colorScheme: "light" }}
    >
      {/* Top bar — back control pinned to the top-left corner */}
      <header className="sticky top-0 z-10 flex h-14 items-center border-b border-zinc-200/80 bg-[#faf9f5]/90 px-3 backdrop-blur sm:px-5">
        <button
          type="button"
          onClick={goBack}
          aria-label="Atrás"
          className="inline-flex items-center gap-2 rounded-full py-1.5 pl-2 pr-3 text-[15px] font-medium text-zinc-700 transition hover:bg-zinc-900/[0.05] hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50"
        >
          <ArrowLeft className="h-[18px] w-[18px]" />
          Atrás
        </button>
        {user ? (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500">
            <span>Plan actual:</span>
            <span className="font-semibold text-zinc-800">{planDisplayName(currentPlan)}</span>
          </div>
        ) : null}
      </header>

      <main className="mx-auto w-full max-w-[1000px] px-4 pb-20 pt-12 sm:px-6 sm:pt-16">
        <h1 className="text-balance text-center font-serif text-[34px] leading-[1.12] tracking-[-0.02em] text-zinc-900 sm:text-[44px]">
          Planes que crecen contigo
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-center text-[15px] leading-6 text-zinc-600">
          Solo dos opciones y sin letra pequeña: el plan Pro para trabajar sin límites,
          o una propuesta a la medida de tu equipo.
        </p>

        <div className="mt-12 grid gap-5 md:grid-cols-2 md:gap-6">
          {/* ── Pro ─────────────────────────────────────────────── */}
          <PlanCard
            icon={<Sprout className="h-7 w-7" strokeWidth={1.5} />}
            name={PAID_PLAN.name}
            tagline={PAID_PLAN.tagline}
            priceLabel={PAID_PLAN.priceLabel}
            priceMeta={[PAID_PLAN.periodLabel, PAID_PLAN.billingNote]}
            reassurance={PAID_PLAN.reassurance}
            featuresIntro={PAID_PLAN.featuresIntro}
            features={PAID_PLAN.features}
            cta={
              alreadyPaid ? (
                <div className="space-y-2.5">
                  <button type="button" disabled className={CTA_DISABLED}>
                    <Check className="h-4 w-4" />
                    {PAID_PLAN.ctaCurrent}
                  </button>
                  <Link
                    href="/billing"
                    className="block text-center text-[13px] font-medium text-zinc-600 underline-offset-4 hover:text-zinc-900 hover:underline"
                  >
                    {PAID_PLAN.ctaManage}
                  </Link>
                </div>
              ) : canCheckout ? (
                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={startCheckout}
                    disabled={checkoutLoading || authLoading}
                    className={CTA_PRIMARY}
                  >
                    {checkoutLoading ? (
                      <>
                        <ThinkingIndicator size="sm" className="h-4 w-4" />
                        Abriendo pago seguro…
                      </>
                    ) : (
                      PAID_PLAN.cta
                    )}
                  </button>
                  <p className="flex items-center justify-center gap-1.5 text-[12px] text-zinc-500">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Pago seguro con tarjeta · Stripe
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {proWhatsAppHref ? (
                    <a href={proWhatsAppHref} target="_blank" rel="noopener noreferrer" className={CTA_PRIMARY}>
                      <MessageCircle className="h-4 w-4" />
                      Activar Pro por WhatsApp
                    </a>
                  ) : (
                    <Link href={SUPPORT_FALLBACK_PATH} className={CTA_PRIMARY}>
                      Activar Pro con soporte
                    </Link>
                  )}
                  <p className="text-center text-[12px] text-zinc-500">
                    El pago con tarjeta se habilita muy pronto. Te activamos Pro en minutos.
                  </p>
                </div>
              )
            }
          />

          {/* ── Hablemos ────────────────────────────────────────── */}
          <PlanCard
            icon={<Users className="h-7 w-7" strokeWidth={1.5} />}
            name={CONTACT_PLAN.name}
            tagline={CONTACT_PLAN.tagline}
            priceLabel={CONTACT_PLAN.priceLabel}
            priceMeta={[CONTACT_PLAN.periodLabel, CONTACT_PLAN.billingNote]}
            reassurance={CONTACT_PLAN.reassurance}
            featuresIntro={CONTACT_PLAN.featuresIntro}
            features={CONTACT_PLAN.features}
            cta={
              salesHref ? (
                <a href={salesHref} target="_blank" rel="noopener noreferrer" className={CTA_PRIMARY}>
                  <MessageCircle className="h-4 w-4" />
                  {CONTACT_PLAN.cta}
                </a>
              ) : (
                <Link href={SUPPORT_FALLBACK_PATH} className={CTA_PRIMARY}>
                  <MessageCircle className="h-4 w-4" />
                  Contactar a soporte
                </Link>
              )
            }
          />
        </div>

        <p className="mx-auto mt-10 max-w-2xl text-center text-[13px] leading-5 text-zinc-500">
          * Se aplican límites de uso justo. Los precios y planes están sujetos a cambios.{" "}
          <Link href="/terms" className="underline underline-offset-4 hover:text-zinc-800">
            Términos
          </Link>{" "}
          ·{" "}
          <Link href={SUPPORT_FALLBACK_PATH} className="underline underline-offset-4 hover:text-zinc-800">
            Soporte
          </Link>
        </p>
      </main>
    </div>
  )
}

interface PlanCardProps {
  icon: React.ReactNode
  name: string
  tagline: string
  priceLabel: string
  priceMeta: readonly string[]
  reassurance: string
  featuresIntro: string
  features: readonly string[]
  cta: React.ReactNode
}

function PlanCard({
  icon,
  name,
  tagline,
  priceLabel,
  priceMeta,
  reassurance,
  featuresIntro,
  features,
  cta,
}: PlanCardProps) {
  return (
    <article className="flex flex-col overflow-hidden rounded-[20px] border border-zinc-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.18)]">
      <div className="px-7 pb-7 pt-8">
        <div className="flex h-14 w-14 items-center justify-center text-zinc-900">{icon}</div>

        <h2 className="mt-6 text-[26px] font-semibold tracking-[-0.02em] text-zinc-900">{name}</h2>
        <p className="mt-1 text-[15px] leading-6 text-zinc-600">{tagline}</p>

        <div className="mt-7 flex flex-wrap items-end gap-x-3 gap-y-1">
          <span className="text-[38px] font-semibold leading-none tracking-[-0.03em] text-zinc-900 sm:text-[42px]">
            {priceLabel}
          </span>
          <div className="pb-1 text-[13px] leading-[1.35] text-zinc-500">
            {priceMeta.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        </div>

        <div className="mt-7">{cta}</div>
        <p className="mt-3 text-center text-[12px] text-zinc-500">{reassurance}</p>
      </div>

      <div className="flex-1 border-t border-zinc-200/80 bg-white px-7 pb-8 pt-6">
        <p className="text-[15px] font-medium text-zinc-900">{featuresIntro}</p>
        <ul className="mt-3.5 space-y-2.5">
          {features.map((feature) => (
            <li key={feature} className="flex gap-3 text-[15px] leading-6 text-zinc-700">
              <Check className="mt-1.5 h-3.5 w-3.5 shrink-0 text-zinc-500" strokeWidth={2.25} />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  )
}
