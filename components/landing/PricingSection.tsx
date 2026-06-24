"use client"

import { motion } from "framer-motion"
import { ArrowRight, Check, Crown, MessageCircle, Rocket, ShieldCheck, Sparkles } from "lucide-react"
import Link from "next/link"

type Plan = {
  name: string
  eyebrow: string
  description: string
  price: string
  period: string
  icon: typeof Crown
  featured?: boolean
  cta: string
  href: string
  features: string[]
  note?: string
  external?: boolean
}

const enterpriseWhatsappMessage = encodeURIComponent(
  "Hola 👋, me interesa el plan Enterprise de SiraGPT. ¿Podrían ayudarme?",
)
const enterpriseWhatsappHref = `https://wa.me/${process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || ""}?text=${enterpriseWhatsappMessage}`

const plans: Plan[] = [
  {
    name: "Pro",
    eyebrow: "Acceso completo",
    description: "Todo lo esencial para trabajar con IA todos los días.",
    price: "$5",
    period: "/mes",
    icon: Crown,
    featured: true,
    cta: "Empezar con Pro",
    href: "/auth/register",
    features: [
      "Modelos líderes en una sola cuenta",
      "Chat, documentos, imágenes, código y agentes",
      "Herramientas creativas y productivas integradas",
      "Soporte prioritario para avanzar sin fricción",
    ],
  },
  {
    name: "Pro Extendido",
    eyebrow: "Más capacidad",
    description: "Más capacidad para profesionales con flujo constante.",
    price: "$10",
    period: "/mes",
    icon: Rocket,
    cta: "Elegir Pro Extendido",
    href: "/auth/register",
    note: "Mismas funciones completas, experiencia ampliada.",
    features: [
      "Todo lo incluido en Pro",
      "Mayor capacidad para proyectos frecuentes",
      "Texto, voz, imagen y video en una experiencia unificada",
      "Prioridad superior en soporte y acompañamiento",
    ],
  },
  {
    name: "Enterprise",
    eyebrow: "A medida",
    description: "Para equipos, empresas y operaciones con necesidades especiales.",
    price: "Enterprise",
    period: "",
    icon: ShieldCheck,
    cta: "Comunícate al WhatsApp",
    href: enterpriseWhatsappHref,
    external: true,
    note: "Atención personalizada por WhatsApp.",
    features: [
      "Acceso completo para equipos",
      "Configuración personalizada según operación",
      "Integraciones, seguridad y flujos internos",
      "Acompañamiento directo para implementación",
    ],
  },
]

export function PricingSection() {
  return (
    <section id="pricing" className="relative overflow-hidden border-y border-border/60 bg-background py-20 sm:py-28">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(124,58,237,0.07),transparent_38%)]" />
      <div className="relative mx-auto w-full max-w-6xl px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.45 }}
          className="mx-auto max-w-2xl text-center"
        >
          <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground shadow-sm backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
            Planes simples. Sin fricción.
          </div>
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-5xl">
            Una experiencia profesional para trabajar mejor con IA.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-pretty text-sm leading-6 text-muted-foreground sm:text-base">
            Modelos, agentes y herramientas en una interfaz limpia: clara para empezar, potente para producir.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {plans.map((plan, index) => {
            const Icon = plan.icon
            const cardClass = plan.featured
              ? "border-foreground/15 bg-card text-foreground shadow-xl shadow-foreground/5 ring-1 ring-foreground/10"
              : "border-border/70 bg-card/45 text-foreground shadow-sm hover:border-foreground/20 hover:bg-card/70"
            const mutedClass = "text-muted-foreground"
            const checkClass = plan.featured ? "text-foreground" : "text-violet-600 dark:text-violet-400"
            const buttonClass = plan.featured
              ? "bg-foreground text-background hover:bg-foreground/90"
              : "border border-border bg-background text-foreground hover:border-foreground/25 hover:bg-muted/40"

            return (
              <motion.article
                key={plan.name}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.45, delay: index * 0.06 }}
                className={`group relative flex min-h-[500px] flex-col rounded-[26px] p-6 transition-all duration-300 hover:-translate-y-1 ${cardClass}`}
              >
                {plan.featured ? (
                  <div className="absolute right-5 top-5 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                    Recomendado
                  </div>
                ) : null}

                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-current/10 bg-current/[0.04]">
                  <Icon className="h-5 w-5" />
                </div>

                <div className="mt-7">
                  <p className={`text-xs font-medium uppercase tracking-[0.16em] ${mutedClass}`}>{plan.eyebrow}</p>
                  <h3 className="mt-3 text-2xl font-semibold tracking-[-0.03em]">{plan.name}</h3>
                  <p className={`mt-3 min-h-[48px] text-sm leading-6 ${mutedClass}`}>{plan.description}</p>
                </div>

                <div className="mt-7 border-t border-current/10 pt-7">
                  <div className="flex items-end gap-1">
                    <span className="text-4xl font-semibold tracking-[-0.05em]">{plan.price}</span>
                    {plan.period ? <span className={`pb-1 text-sm ${mutedClass}`}>{plan.period}</span> : null}
                  </div>
                  {plan.note ? <p className={`mt-2 text-xs leading-5 ${mutedClass}`}>{plan.note}</p> : null}
                </div>

                <ul className="mt-7 flex-1 space-y-3.5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-3 text-sm leading-5">
                      <Check className={`mt-0.5 h-4 w-4 shrink-0 ${checkClass}`} />
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
