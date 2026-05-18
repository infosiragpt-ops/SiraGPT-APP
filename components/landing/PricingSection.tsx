"use client"

import { motion } from "framer-motion"
import { Building2, Check, Crown, Rocket, Zap } from "lucide-react"
import Link from "next/link"

type Plan = {
  name: string
  description: string
  price: string
  period: string
  icon: typeof Zap
  featured: boolean
  cta: string
  href: string
  features: string[]
  /** Optional small note rendered under the price (e.g. "Facturación mensual"). */
  priceNote?: string
}

/**
 * Planes alineados con la cuenta Stripe de SiraGPT (cuenta acct_…3GHT):
 *   Go    USD   5/mes  → STRIPE_PRICE_PRO            (price_1SqR3WRQfoz6eHKDtSuO3GZb)
 *   Plus  USD  20/mes  → STRIPE_PRICE_PRO_MAX        (price_1SqR3WRQfoz6eHKDEqjtVVmA)
 *   Pro   USD 200/mes  → STRIPE_PRICE_ENTERPRISE     (price_1SqR3XRQfoz6eHKDBD3yq4VT)
 * El backend (backend/src/services/stripe.js) ya mapea PRO/PRO_MAX/ENTERPRISE
 * a estos display names.
 */
const plans: Plan[] = [
  {
    name: "Free",
    description: "Para explorar la plataforma",
    price: "$0",
    period: "/mes",
    icon: Zap,
    featured: false,
    cta: "Empezar gratis",
    href: "/auth/register",
    features: [
      "Cupo mensual y modelos esenciales",
      "Chat y proyectos básicos",
      "Ideal para probar Sira GPT",
      "Soporte por comunidad",
    ],
  },
  {
    name: "Go",
    description: "Profesionales y estudiantes",
    price: "$5",
    period: "/mes",
    icon: Crown,
    featured: true,
    cta: "Empezar Go",
    href: "/auth/register",
    features: [
      "500.000 tokens al mes",
      "Modelos premium (GPT, Claude, Gemini, Grok)",
      "Generación de imágenes",
      "Análisis de documentos y GPTs",
      "Soporte prioritario por email",
    ],
  },
  {
    name: "Plus",
    description: "Uso intensivo individual",
    price: "$20",
    period: "/mes",
    icon: Rocket,
    featured: false,
    cta: "Empezar Plus",
    href: "/auth/register",
    features: [
      "1.000.000 de tokens al mes",
      "Todo lo de Go con cupos mayores",
      "Prioridad en cola y rate limits altos",
      "Agentes y flujos avanzados",
      "Soporte prioritario",
    ],
  },
  {
    name: "Pro",
    description: "Equipos y organizaciones",
    price: "$200",
    period: "/mes",
    icon: Building2,
    featured: false,
    cta: "Empezar Pro",
    href: "/auth/register",
    priceNote: "Para equipos: facturación mensual y SLA.",
    features: [
      "10.000.000 de tokens al mes",
      "Todos los modelos + acceso API",
      "Integraciones e infraestructura dedicada",
      "SSO/SAML y SLA garantizado",
      "Onboarding personalizado",
    ],
  },
]

export function PricingSection() {
  return (
    <section className="relative overflow-hidden bg-muted/30 py-6 sm:py-8 lg:py-10">
      <div className="mx-auto w-full max-w-screen-2xl px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="mx-auto max-w-2xl text-center"
        >
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-border/60 bg-background px-3 py-1 text-xs font-medium text-foreground/80">
            <Crown className="h-3 w-3" />
            <span>Precios transparentes</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl lg:text-4xl">
            Elige tu plan
          </h2>
          <p className="mt-2 text-sm leading-snug text-muted-foreground sm:text-base">
            Empieza gratis y escala según necesites. Sin compromisos, cancela cuando quieras.
          </p>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="mx-auto mt-4 grid w-full grid-cols-1 gap-3 sm:grid-cols-2 min-[960px]:mt-5 min-[960px]:grid-cols-4 min-[960px]:gap-3 xl:gap-4"
        >
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }}
              className={`relative flex h-full min-h-0 min-w-0 flex-col rounded-2xl border p-3 transition-all duration-300 sm:p-4 ${
                plan.featured
                  ? "border-primary bg-card shadow-lg shadow-primary/10 ring-2 ring-primary/30"
                  : "border-border/50 bg-card/60 hover:border-border hover:bg-card hover:shadow-md"
              }`}
            >
              {plan.featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground">
                    Más popular
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2.5">
                <div
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    plan.featured ? "bg-primary text-primary-foreground" : "bg-accent text-foreground"
                  }`}
                >
                  <plan.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold leading-tight">{plan.name}</h3>
                  <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                    {plan.description}
                  </p>
                </div>
              </div>

              <div className="mt-2">
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="text-2xl font-bold tracking-tight">{plan.price}</span>
                  <span className="text-xs text-muted-foreground">{plan.period}</span>
                </div>
                {plan.priceNote ? (
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground sm:text-[11px]">
                    {plan.priceNote}
                  </p>
                ) : null}
              </div>

              <ul className="mt-2 flex flex-col gap-1.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-1.5">
                    <Check
                      className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                        plan.featured ? "text-primary" : "text-emerald-500"
                      }`}
                    />
                    <span className="text-[11px] leading-tight text-muted-foreground sm:text-xs">
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>

              <Link
                href={plan.href}
                className={`mt-3 inline-flex h-9 w-full items-center justify-center rounded-lg px-2 text-xs font-medium transition-all duration-200 sm:text-sm ${
                  plan.featured
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-border bg-background text-foreground hover:bg-accent"
                }`}
              >
                {plan.cta}
              </Link>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
