"use client"

import { motion } from "framer-motion"
import { Check, Crown, Rocket, Zap, Sparkles } from "lucide-react"
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
 * Planes de SiraGPT adaptados a los requerimientos:
 *   Free     USD   0/mes  → Para exploración inicial.
 *   Consumo  USD   2/mes  → Pago por consumo de acuerdo a lo que decidas usar.
 *   Go       USD   5/mes  → Plan destacado para profesionales y estudiantes.
 *   Plus     USD  10/mes  → Acceso total a todo en la plataforma sin límites.
 */
const plans: Plan[] = [
  {
    name: "Free",
    description: "Para explorar la plataforma",
    price: "$0",
    period: "/mes",
    icon: Sparkles,
    featured: false,
    cta: "Empezar gratis",
    href: "/auth/register",
    features: [
      "Acceso a modelos esenciales (GPT-3.5, Claude Haiku, Gemini Flash)",
      "Chat interactivo básico con memoria de contexto",
      "Hasta 3 proyectos activos y almacenamiento en la nube",
      "Análisis básico de documentos de texto y PDFs cortos",
      "Soporte a través de la comunidad global",
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
      "Acceso a modelos premium (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro)",
      "Generación de imágenes con DALL-E 3 y Midjourney",
      "Análisis avanzado de PDF, Excel y documentos de texto",
      "Acceso a la biblioteca de GPTs y asistentes personalizados",
      "Proyectos y chats ilimitados con guardado automático",
      "Soporte prioritario por correo electrónico",
    ],
  },
  {
    name: "Plus",
    description: "Uso intensivo profesional",
    price: "$10",
    period: "/mes",
    icon: Rocket,
    featured: false,
    cta: "Empezar Plus",
    href: "/auth/register",
    priceNote: "Mismas características con mayor capacidad.",
    features: [
      "Acceso a modelos premium (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro)",
      "Generación de imágenes con DALL-E 3 y Midjourney",
      "Análisis avanzado de PDF, Excel y documentos de texto",
      "Acceso a la biblioteca de GPTs y asistentes personalizados",
      "Proyectos y chats ilimitados con guardado automático",
      "Límites de uso y cuotas de consultas mucho más altos",
      "Soporte prioritario por correo electrónico",
    ],
  },
  {
    name: "Consumo",
    description: "Flexible bajo demanda",
    price: "$2",
    period: "/mes",
    icon: Zap,
    featured: false,
    cta: "Empezar Consumo",
    href: "/auth/register",
    priceNote: "Paga según lo que decidas usar.",
    features: [
      "Tarifa base mínima de mantenimiento y acceso",
      "Acceso completo a todos los modelos sin restricciones de tier",
      "Generación de imágenes y análisis avanzado bajo demanda",
      "Control total del presupuesto mensual en tiempo real",
      "Paga de manera flexible solo por los tokens que utilices",
      "Soporte estándar por correo electrónico",
    ],
  },
]

export function PricingSection() {
  return (
    <section className="relative overflow-hidden bg-background py-20 sm:py-32" id="pricing">
      {/* Premium Technical Grid Backdrop */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808008_1px,transparent_1px),linear-gradient(to_bottom,#80808008_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] dark:bg-[linear-gradient(to_right,#ffffff05_1px,transparent_1px),linear-gradient(to_bottom,#ffffff05_1px,transparent_1px)]" />

      {/* Dynamic Background Mesh Glowing Visual Lights */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/4 h-[600px] w-[600px] rounded-full bg-violet-500/10 dark:bg-violet-500/5 blur-[150px] animate-pulse" style={{ animationDuration: "10s" }} />
        <div className="absolute -bottom-40 right-1/4 h-[600px] w-[600px] rounded-full bg-fuchsia-500/10 dark:bg-fuchsia-500/5 blur-[150px] animate-pulse" style={{ animationDuration: "14s" }} />
      </div>

      <div className="relative mx-auto w-full max-w-7xl px-6 lg:px-8">
        {/* Animated Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="mx-auto max-w-3xl text-center"
        >
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-500/20 dark:border-violet-500/30 bg-violet-500/5 dark:bg-violet-500/10 px-4 py-1.5 text-xs font-semibold text-violet-600 dark:text-violet-300 backdrop-blur-md shadow-sm">
            <Sparkles className="h-3.5 w-3.5 text-violet-500 animate-pulse" />
            <span>Precios Simples e Inteligentes</span>
          </div>
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl md:text-5xl bg-gradient-to-b from-foreground via-foreground/90 to-foreground/85 bg-clip-text text-transparent leading-[1.1] md:leading-[1.05]">
            Elige tu plan
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Empieza gratis y escala según necesites. Sin compromisos, cancela cuando quieras.
          </p>
        </motion.div>

        {/* Pricing Cards Grid */}
        <div className="mx-auto mt-16 grid w-full grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4 items-stretch">
          {plans.map((plan, i) => {
            const isFeatured = plan.featured;
            
            // Icon color customization based on the tier
            let iconBgClass = "bg-blue-500/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400"
            let accentBorderHover = "hover:border-blue-500/30 dark:hover:border-blue-500/20"
            let buttonHoverStyles = "group-hover:border-blue-500/30 group-hover:bg-blue-500/5 group-hover:text-blue-600 dark:group-hover:text-blue-400"
            let cardHoverShadow = "hover:shadow-[0_20px_50px_rgba(59,130,246,0.06)]"
            
            if (plan.name === "Go") {
              iconBgClass = "bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/20"
              accentBorderHover = "hover:border-violet-500/40"
              buttonHoverStyles = "bg-gradient-to-r from-violet-600 via-fuchsia-600 to-pink-500 hover:from-violet-500 hover:via-fuchsia-500 hover:to-pink-500 text-white shadow-lg shadow-violet-500/20"
              cardHoverShadow = "hover:shadow-[0_25px_60px_rgba(124,58,237,0.25)]"
            } else if (plan.name === "Consumo") {
              iconBgClass = "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400"
              accentBorderHover = "hover:border-emerald-500/30 dark:hover:border-emerald-500/20"
              buttonHoverStyles = "group-hover:border-emerald-500/30 group-hover:bg-emerald-500/5 group-hover:text-emerald-600 dark:group-hover:text-emerald-400"
              cardHoverShadow = "hover:shadow-[0_20px_50px_rgba(16,185,129,0.06)]"
            } else if (plan.name === "Plus") {
              iconBgClass = "bg-pink-500/10 text-pink-600 dark:bg-pink-500/20 dark:text-pink-400"
              accentBorderHover = "hover:border-pink-500/30 dark:hover:border-pink-500/20"
              buttonHoverStyles = "group-hover:border-pink-500/30 group-hover:bg-pink-500/5 group-hover:text-pink-600 dark:group-hover:text-pink-400"
              cardHoverShadow = "hover:shadow-[0_20px_50px_rgba(236,72,153,0.06)]"
            }

            if (isFeatured) {
              return (
                <motion.div
                  key={plan.name}
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }}
                  className="group relative flex flex-col rounded-3xl bg-gradient-to-br from-violet-600 via-fuchsia-600 to-pink-500 p-[1.5px] shadow-[0_20px_50px_rgba(124,58,237,0.12)] scale-[1.03] z-10 transition-all duration-300 hover:scale-[1.05]"
                >
                  {/* Ambient Pulsing Back-glow behind Featured Card */}
                  <div className="absolute inset-0 -z-10 rounded-3xl bg-gradient-to-r from-violet-600/30 via-fuchsia-600/30 to-pink-500/30 blur-2xl opacity-75 group-hover:opacity-100 transition-opacity duration-300" />

                  {/* Inner Card Container */}
                  <div className="flex h-full w-full flex-col rounded-[22.5px] bg-[#FFFFFF] dark:bg-[#07090D] p-6 sm:p-7 relative overflow-hidden transition-colors duration-300">
                    
                    {/* Background Radial Glow */}
                    <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-violet-500/10 blur-2xl pointer-events-none" />

                    {/* Popularity Badge */}
                    <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-violet-600 via-fuchsia-600 to-pink-600 px-4 py-1 text-xs font-bold text-white shadow-md shadow-violet-500/30">
                        <Crown className="h-3.5 w-3.5 text-white" />
                        Más Popular
                      </span>
                    </div>

                    {/* Plan Header */}
                    <div className="flex items-center gap-4 mt-2">
                      <motion.div 
                        whileHover={{ scale: 1.1, rotate: 5 }}
                        className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${iconBgClass}`}
                      >
                        <plan.icon className="h-6 w-6" />
                      </motion.div>
                      <div className="min-w-0">
                        <h3 className="text-xl font-bold leading-tight text-foreground">{plan.name}</h3>
                        <p className="text-xs text-muted-foreground/90 leading-normal font-medium">
                          {plan.description}
                        </p>
                      </div>
                    </div>

                    {/* Price Display */}
                    <div className="mt-6 border-b border-border/40 pb-6">
                      <div className="flex items-baseline gap-1">
                        <span className="text-5xl font-extrabold tracking-tight text-foreground">{plan.price}</span>
                        <span className="text-base font-semibold text-muted-foreground">{plan.period}</span>
                      </div>
                      {plan.priceNote ? (
                        <p className="mt-2 text-xs leading-normal text-muted-foreground/90 font-semibold bg-violet-500/5 border border-violet-500/10 px-2.5 py-1.5 rounded-lg">
                          {plan.priceNote}
                        </p>
                      ) : null}
                    </div>

                    {/* Features List */}
                    <ul className="mt-6 flex-1 space-y-4">
                      {plan.features.map((feature) => (
                        <li key={feature} className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-full bg-emerald-500/10 p-0.5 dark:bg-emerald-500/20 flex shrink-0 items-center justify-center">
                            <Check className="h-3.5 w-3.5 text-emerald-500 stroke-[3px]" />
                          </div>
                          <span className="text-xs sm:text-sm leading-normal text-muted-foreground/90 font-medium">
                            {feature}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {/* Action CTA Link */}
                    <Link
                      href={plan.href}
                      className={`mt-8 inline-flex h-12 w-full items-center justify-center rounded-2xl font-bold tracking-wide transition-all duration-300 active:scale-[0.98] ${buttonHoverStyles}`}
                    >
                      {plan.cta}
                    </Link>
                  </div>
                </motion.div>
              )
            }

            return (
              <motion.div
                key={plan.name}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] }}
                className={`group relative flex flex-col rounded-3xl border border-gray-200/40 dark:border-white/5 bg-white/40 dark:bg-card/10 p-6 sm:p-7 backdrop-blur-xl transition-all duration-300 hover:-translate-y-2 ${accentBorderHover} ${cardHoverShadow}`}
              >
                {/* Ambient glow behind individual card */}
                <div className="absolute inset-0 -z-10 rounded-3xl bg-transparent opacity-0 group-hover:opacity-10 transition-opacity duration-300" />

                {/* Plan Header */}
                <div className="flex items-center gap-4">
                  <motion.div 
                    whileHover={{ scale: 1.1, rotate: -5 }}
                    className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-transform duration-300 ${iconBgClass}`}
                  >
                    <plan.icon className="h-6 w-6" />
                  </motion.div>
                  <div className="min-w-0">
                    <h3 className="text-xl font-bold leading-tight text-foreground transition-colors group-hover:text-violet-600 dark:group-hover:text-violet-400">{plan.name}</h3>
                    <p className="text-xs text-muted-foreground/80 leading-normal">
                      {plan.description}
                    </p>
                  </div>
                </div>

                {/* Price Display */}
                <div className="mt-6 border-b border-border/40 pb-6">
                  <div className="flex items-baseline gap-1">
                    <span className="text-5xl font-extrabold tracking-tight text-foreground">{plan.price}</span>
                    <span className="text-base font-semibold text-muted-foreground">{plan.period}</span>
                  </div>
                  {plan.priceNote ? (
                    <p className="mt-2 text-xs leading-normal text-muted-foreground/90 font-medium">
                      {plan.priceNote}
                    </p>
                  ) : null}
                </div>

                {/* Features List */}
                <ul className="mt-6 flex-1 space-y-4">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <div className="mt-0.5 rounded-full bg-emerald-500/10 p-0.5 dark:bg-emerald-500/20 flex shrink-0 items-center justify-center">
                        <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 stroke-[3px]" />
                      </div>
                      <span className="text-xs sm:text-sm leading-normal text-muted-foreground/95 font-normal">
                        {feature}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* Action CTA Link */}
                <Link
                  href={plan.href}
                  className={`mt-8 inline-flex h-12 w-full items-center justify-center rounded-2xl border border-black/10 dark:border-white/10 bg-white/50 dark:bg-white/5 text-foreground font-semibold tracking-wide transition-all duration-300 active:scale-[0.98] shadow-sm hover:shadow ${buttonHoverStyles}`}
                >
                  {plan.cta}
                </Link>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
