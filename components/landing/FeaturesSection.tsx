"use client"

import { motion } from "framer-motion"
import {
  MessageSquare,
  ImageIcon,
  FileText,
  BrainCircuit,
  PenTool,
  Search,
  Mic,
  Video,
  Shield,
  Zap,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

interface Feature {
  icon: LucideIcon
  title: string
  description: string
  gradient: string
  active: boolean
}

const features: Feature[] = [
  {
    icon: MessageSquare,
    title: "Multi-Modelo Chat",
    description: "GPT-4, Claude 3.5, Gemini Pro, Grok y más. Cambia de modelo sin perder contexto.",
    gradient: "from-blue-500/20 via-blue-400/10 to-transparent",
    active: true,
  },
  {
    icon: ImageIcon,
    title: "Generación de Imágenes",
    description: "Crea imágenes con DALL-E 3. Desde arte conceptual hasta mockups de producto.",
    gradient: "from-purple-500/20 via-purple-400/10 to-transparent",
    active: true,
  },
  {
    icon: FileText,
    title: "Análisis de Documentos",
    description: "Sube PDFs, Word, Excel y PowerPoint. La IA extrae insights y responde preguntas.",
    gradient: "from-amber-500/20 via-amber-400/10 to-transparent",
    active: true,
  },
  {
    icon: BrainCircuit,
    title: "GPTs Personalizados",
    description: "Crea asistentes especializados con instrucciones propias y base de conocimiento.",
    gradient: "from-emerald-500/20 via-emerald-400/10 to-transparent",
    active: true,
  },
  {
    icon: PenTool,
    title: "Design Studio",
    description: "Prototipos, presentaciones y páginas web con IA. Itera visualmente en tiempo real.",
    gradient: "from-rose-500/20 via-rose-400/10 to-transparent",
    active: true,
  },
  {
    icon: Search,
    title: "Búsqueda Inteligente",
    description: "RAG propio para tus documentos y búsqueda web académica con citas automáticas.",
    gradient: "from-cyan-500/20 via-cyan-400/10 to-transparent",
    active: true,
  },
  {
    icon: Mic,
    title: "Voz & Audio",
    description: "Dictado por voz, speech-to-text, y generación de audio con ElevenLabs.",
    gradient: "from-orange-500/20 via-orange-400/10 to-transparent",
    active: true,
  },
  {
    icon: Video,
    title: "Video & Multimedia",
    description: "Generación de video, presentaciones automáticas y contenido multimedia.",
    gradient: "from-pink-500/20 via-pink-400/10 to-transparent",
    active: false,
  },
]

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.08,
    },
  },
}

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  },
}

export function FeaturesSection() {
  return (
    <section className="relative overflow-hidden py-24 lg:py-32">
      {/* Background subtle grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(to right, hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "4rem 4rem",
        }}
      />

      <div className="relative mx-auto max-w-7xl px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="mx-auto max-w-2xl text-center"
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-accent/40 px-3 py-1 text-xs font-medium text-foreground/80 mb-6">
            <Zap className="h-3 w-3" />
            <span>Todo lo que necesitas en una sola plataforma</span>
          </div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            Herramientas de IA que realmente{" "}
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-violet-500 to-fuchsia-500">
              potencian tu trabajo
            </span>
          </h2>
          <p className="mt-5 text-lg text-muted-foreground leading-relaxed">
            Desde redactar un email hasta diseñar un prototipo completo. Sira GPT integra los mejores modelos de IA en una experiencia unificada.
          </p>
        </motion.div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="mx-auto mt-16 grid max-w-6xl gap-5 sm:grid-cols-2 lg:grid-cols-4"
        >
          {features.map((feature) => (
            <motion.div
              key={feature.title}
              variants={cardVariants}
              className="group relative flex flex-col rounded-2xl border border-border/50 bg-card/60 p-6 backdrop-blur-sm transition-all duration-300 hover:border-border hover:bg-card hover:shadow-lg hover:shadow-foreground/5"
            >
              {!feature.active && (
                <div className="absolute top-4 right-4">
                  <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    Pronto
                  </span>
                </div>
              )}
              <div
                className={`inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${feature.gradient} border border-border/40`}
              >
                <feature.icon className="h-5 w-5 text-foreground/80" />
              </div>
              <h3 className="mt-4 text-base font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </p>

              {/* Hover glow */}
              <div className="absolute inset-0 -z-10 rounded-2xl opacity-0 transition-opacity duration-500 group-hover:opacity-100">
                <div
                  className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${feature.gradient} blur-xl`}
                />
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
