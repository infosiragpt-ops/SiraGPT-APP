"use client"

import { motion } from "framer-motion"
import { ArrowRight, Check, MessageCircle, Sparkles, Sprout, Users } from "lucide-react"
import Link from "next/link"

import {
  CONTACT_PLAN,
  PAID_PLAN,
  SALES_WHATSAPP_MESSAGE,
  SUPPORT_FALLBACK_PATH,
  buildWhatsAppHref,
  resolveWhatsAppNumber,
} from "@/lib/plans-catalog"

/**
 * Landing pricing — the same two plans as /planes (single source of truth
 * in lib/plans-catalog). "Pro" sends visitors to the full-screen plans page
 * (which handles login → Stripe Checkout); "Hablemos" opens WhatsApp with
 * the build-time number, or /support when no number is configured.
 */

type Plan = {
  name: string
  eyebrow: string
  description: string
  price: string
  period: string
  icon: typeof Sparkles
  featured?: boolean
  cta: string
  href: string
  features: readonly string[]
  note?: string
  external?: boolean
}

const salesWhatsAppHref = buildWhatsAppHref(resolveWhatsAppNumber(), SALES_WHATSAPP_MESSAGE)

const plans: Plan[] = [
  {
    name: PAID_PLAN.name,
    eyebrow: "Acceso completo",
    description: PAID_PLAN.tagline,
    price: `$${PAID_PLAN.priceUsd}`,
    period: "/mes",
    icon: Sprout,
    featured: true,
    cta: PAID_PLAN.cta,
    href: "/planes",
    note: PAID_PLAN.reassurance,
    features: PAID_PLAN.features,
  },
  {
    name: CONTACT_PLAN.name,
    eyebrow: "A medida",
    description: CONTACT_PLAN.tagline,
    price: CONTACT_PLAN.priceLabel,
    period: "",
    icon: Users,
    cta: salesWhatsAppHref ? CONTACT_PLAN.cta : "Contactar a soporte",
    href: salesWhatsAppHref || SUPPORT_FALLBACK_PATH,
    external: Boolean(salesWhatsAppHref),
    note: CONTACT_PLAN.billingNote,
    features: CONTACT_PLAN.features,
  },
]

export function PricingSection() {
  return (
    <section id="pricing" className="relative overflow-hidden border-y border-zinc-200 bg-white py-20 sm:py-28">
      <div className="relative mx-auto w-full max-w-5xl px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.45 }}
          className="mx-auto max-w-2xl text-center"
        >
          <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-600 shadow-sm">
            <Sparkles className="h-3.5 w-3.5 text-zinc-900" />
            Dos planes. Sin letra pequeña.
          </div>
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.04em] text-zinc-900 sm:text-5xl">
            Planes que crecen contigo.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-pretty text-sm leading-6 text-zinc-600 sm:text-base">
            El plan Pro para trabajar con IA sin límites artificiales, o una propuesta a la medida de tu equipo.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 md:grid-cols-2">
          {plans.map((plan, index) => {
            const Icon = plan.icon
            const cardClass = plan.featured
              ? "border-zinc-900 bg-white text-zinc-900 shadow-xl shadow-zinc-900/10 ring-1 ring-zinc-900"
              : "border-zinc-200 bg-white text-zinc-900 shadow-sm hover:border-zinc-300 hover:shadow-md"
            const mutedClass = "text-zinc-600"
            const titleClass = "text-zinc-900"
            const buttonClass = plan.featured
              ? "bg-zinc-900 text-white hover:bg-black"
              : "border border-zinc-300 bg-white text-zinc-900 hover:border-zinc-900 hover:bg-zinc-50"

            return (
              <motion.article
                key={plan.name}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.45, delay: index * 0.06 }}
                className={`group relative flex min-h-[500px] flex-col rounded-[26px] border p-6 transition-all duration-300 hover:-translate-y-1 ${cardClass}`}
              >
                {plan.featured ? (
                  <div className="absolute right-5 top-5 rounded-full border border-zinc-200 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm">
                    Recomendado
                  </div>
                ) : null}

                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50 text-zinc-900">
                  <Icon className="h-5 w-5" />
                </div>

                <div className="mt-7">
                  <p className={`text-xs font-medium uppercase tracking-[0.16em] ${mutedClass}`}>{plan.eyebrow}</p>
                  <h3 className={`mt-3 text-2xl font-semibold tracking-[-0.03em] ${titleClass}`}>{plan.name}</h3>
                  <p className={`mt-3 min-h-[48px] text-sm leading-6 ${mutedClass}`}>{plan.description}</p>
                </div>

                <div className="mt-7 border-t border-zinc-200 pt-7">
                  <div className="flex items-end gap-1">
                    <span className={`text-4xl font-semibold tracking-[-0.05em] ${titleClass}`}>{plan.price}</span>
                    {plan.period ? <span className={`pb-1 text-sm ${mutedClass}`}>{plan.period}</span> : null}
                  </div>
                  {plan.note ? <p className={`mt-2 text-xs leading-5 ${mutedClass}`}>{plan.note}</p> : null}
                </div>

                <ul className="mt-7 flex-1 space-y-3.5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-3 text-sm leading-5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-zinc-900" />
                      <span className={mutedClass}>{feature}</span>
                    </li>
                  ))}
                </ul>

                {plan.external ? (
                  <a
                    href={plan.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`mt-8 inline-flex h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition ${buttonClass}`}
                  >
                    <MessageCircle className="h-4 w-4" />
                    {plan.cta}
                  </a>
                ) : (
                  <Link
                    href={plan.href}
                    className={`mt-8 inline-flex h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition ${buttonClass}`}
                  >
                    {plan.cta}
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                )}
              </motion.article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
