"use client"

import { motion } from "framer-motion"
import { ArrowRight, MessageSquare, Cpu, FileUp, Sparkles } from "lucide-react"

const steps = [
  {
    step: "01",
    icon: MessageSquare,
    title: "Inicia la conversación",
    description:
      "Escribe o habla con Sira GPT. La plataforma detecta automáticamente tu intención y selecciona el mejor modelo de IA para la tarea.",
  },
  {
    step: "02",
    icon: FileUp,
    title: "Aporta contexto",
    description:
      "Sube documentos, imágenes, hojas de cálculo o conecta tus servicios. La IA procesa todo el contexto para respuestas precisas.",
  },
  {
    step: "03",
    icon: Cpu,
    title: "IA avanzada actúa",
    description:
      "Múltiples agentes especializados trabajan en paralelo: búsqueda, análisis, síntesis y generación. Todo coordinado por el núcleo Sira.",
  },
  {
    step: "04",
    icon: Sparkles,
    title: "Obtén resultados",
    description:
      "Recibe respuestas, documentos, código, imágenes o prototipos completos. Exporta en cualquier formato o continúa iterando.",
  },
]

export function HowItWorks() {
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
            <Sparkles className="h-3 w-3" />
            <span>Simple y poderoso</span>
          </div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            Cómo funciona
          </h2>
          <p className="mt-5 text-lg text-muted-foreground leading-relaxed">
            De idea a resultado en minutos, no en horas. Nuestros agentes de IA manejan la complejidad por ti.
          </p>
        </motion.div>

        <div className="mt-16 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((item, index) => (
            <motion.div
              key={item.step}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.5, delay: index * 0.1, ease: [0.22, 1, 0.36, 1] }}
              className="relative flex flex-col items-center text-center"
            >
              {/* Connector line */}
              {index < steps.length - 1 && (
                <div className="hidden lg:block absolute top-8 left-[60%] w-[80%]">
                  <div className="h-px w-full bg-gradient-to-r from-border via-border to-transparent" />
                  <ArrowRight className="absolute right-0 -top-2 h-4 w-4 text-border" />
                </div>
              )}

              <div className="relative">
                <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-card border border-border shadow-sm">
                  <item.icon className="h-7 w-7 text-foreground/80" />
                </div>
                <span className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                  {item.step}
                </span>
              </div>

              <h3 className="mt-6 text-base font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground max-w-xs">
                {item.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
