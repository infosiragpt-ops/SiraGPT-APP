"use client"

import { motion } from "framer-motion"
import { Check, Crown, Zap, Building2 } from "lucide-react"
import Link from "next/link"

const plans = [
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
      "1,000 tokens/mes",
      "Acceso a GPT-3.5",
      "Chat básico",
      "3 proyectos",
      "Soporte por comunidad",
    ],
  },
  {
    name: "Pro",
    description: "Para profesionales y estudiantes",
    price: "$5",
    period: "/mes",
    icon: Crown,
    featured: true,
    cta: "Empezar Pro",
    href: "/auth/register",
    features: [
      "500,000 tokens/mes",
      "GPT-4, Claude 3.5, Gemini",
      "Generación de imágenes",
      "Proyectos ilimitados",
      "Análisis de documentos",
      "GPTs personalizados",
      "Soporte prioritario",
    ],
  },
  {
    name: "Enterprise",
    description: "Para equipos y organizaciones",
    price: "$200",
    period: "/mes",
    icon: Building2,
    featured: false,
    cta: "Contactar ventas",
    href: "#",
    features: [
      "10,000,000 tokens/mes",
      "Todos los modelos + API",
      "Usuarios ilimitados",
      "Infraestructura dedicada",
      "SSO & SAML",
      "SLA garantizado",
      "Onboarding personalizado",
    ],
  },
]

export function PricingSection() {
  return (
    <section className="relative overflow-hidden py-24 lg:py-32 bg-muted/30">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="mx-auto max-w-2xl text-center"
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background px-3 py-1 text-xs font-medium text-foreground/80 mb-6">
            <Crown className="h-3 w-3" />
            <span>Precios transparentes</span>
          </div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            Elige tu plan
          </h2>
          <p className="mt-5 text-lg text-muted-foreground leading-relaxed">
            Empieza gratis y escala según necesites. Sin compromisos, cancela cuando quieras.
          </p>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="mx-auto mt-16 grid max-w-5xl gap-6 lg:grid-cols-3"
        >
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }}
              className={`relative flex flex-col rounded-2xl border p-6 lg:p-8 transition-all duration-300 ${
                plan.featured
                  ? "border-primary/40 bg-card shadow-xl shadow-primary/5 scale-[1.02] lg:scale-105"
                  : "border-border/50 bg-card/60 hover:border-border hover:bg-card hover:shadow-lg"
              }`}
            >
              {plan.featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground">
                    Más popular
                  </span>
                </div>
              )}

              <div className="flex items-center gap-3">
                <div
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${
                    plan.featured
                      ? "bg-primary text-primary-foreground"
                      : "bg-accent text-foreground"
                  }`}
                >
                  <plan.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="text-xs text-muted-foreground">{plan.description}</p>
                </div>
              </div>

              <div className="mt-6 flex items-baseline gap-1">
                <span className="text-4xl font-bold tracking-tight">{plan.price}</span>
                <span className="text-sm text-muted-foreground">{plan.period}</span>
              </div>

              <ul className="mt-6 flex flex-col gap-3 flex-1">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5">
                    <Check
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        plan.featured ? "text-primary" : "text-emerald-500"
                      }`}
                    />
                    <span className="text-sm text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={plan.href}
                className={`mt-8 inline-flex h-10 w-full items-center justify-center rounded-lg text-sm font-medium transition-all duration-200 ${
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
