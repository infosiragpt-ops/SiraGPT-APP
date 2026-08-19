"use client"

import { motion } from "framer-motion"
import { Star, Quote } from "lucide-react"

const testimonials = [
  {
    name: "Dr. Ana Martínez",
    role: "Investigadora, Universidad de Barcelona",
    content:
      "Sira GPT transformó mi flujo de investigación. El marco teórico automático y las citas APA me ahorran semanas de trabajo documental.",
    rating: 5,
    avatar: "AM",
    avatarColor: "from-blue-500 to-cyan-400",
  },
  {
    name: "Carlos Ruiz",
    role: "CTO, TechStart Lima",
    content:
      "Integramos Sira GPT en nuestro pipeline de desarrollo. El agente de código es sorprendentemente preciso y la generación de documentación es automática.",
    rating: 5,
    avatar: "CR",
    avatarColor: "from-emerald-500 to-teal-400",
  },
  {
    name: "María González",
    role: "Diseñadora UX Freelance",
    content:
      "El Design Studio es una maravilla. Puedo pasar de una descripción textual a un prototipo interactivo en minutos. Mis clientes quedan impresionados.",
    rating: 5,
    avatar: "MG",
    avatarColor: "from-purple-500 to-violet-400",
  },
  {
    name: "Prof. Javier López",
    role: "Departamento de IA, UNAM",
    content:
      "La calidad de las respuestas con Claude 3.5 Sonnet es excepcional. La capacidad de cambiar entre modelos manteniendo contexto es única en el mercado.",
    rating: 5,
    avatar: "JL",
    avatarColor: "from-amber-500 to-orange-400",
  },
  {
    name: "Sofía Mendoza",
    role: "Directora de Marketing, NovaMedia",
    content:
      "Generamos contenido para 5 plataformas con un solo prompt. El scheduler automático y la generación de imágenes son un game-changer para nuestro equipo.",
    rating: 5,
    avatar: "SM",
    avatarColor: "from-rose-500 to-pink-400",
  },
  {
    name: "Diego Hernández",
    role: "Estudiante de Posgrado, ITESO",
    content:
      "De todos los asistentes de IA que he probado, Sira GPT entiende mejor el español técnico y académico. Es mi herramienta principal para la tesis.",
    rating: 5,
    avatar: "DH",
    avatarColor: "from-cyan-500 to-blue-400",
  },
]

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.1,
    },
  },
}

const cardVariants = {
  hidden: { opacity: 0, y: 30, scale: 0.97 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  },
}

export function TestimonialsSection() {
  return (
    <section className="relative overflow-hidden py-24 lg:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
          className="mx-auto max-w-2xl text-center"
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-accent/40 px-3 py-1 text-xs font-medium text-foreground/80 mb-6">
            <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
            <span>Lo que dicen nuestros usuarios</span>
          </div>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            Usado por investigadores, desarrolladores y creativos
          </h2>
          <p className="mt-5 text-lg text-muted-foreground leading-relaxed">
            Miles de profesionales confían en Sira GPT para acelerar su trabajo diario.
          </p>
        </motion.div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="mt-16 columns-1 gap-5 space-y-5 sm:columns-2 lg:columns-3"
        >
          {testimonials.map((t) => (
            <motion.div
              key={t.name}
              variants={cardVariants}
              className="break-inside-avoid rounded-2xl border border-border/50 bg-card/60 p-6 backdrop-blur-sm transition-all duration-300 hover:border-border hover:bg-card hover:shadow-lg hover:shadow-foreground/5"
            >
              <div className="flex items-center gap-1 mb-4">
                {Array.from({ length: t.rating }).map((_, i) => (
                  <Star key={i} className="h-3.5 w-3.5 fill-amber-500 text-amber-500" />
                ))}
              </div>

              <div className="relative">
                <Quote className="absolute -left-1 -top-2 h-6 w-6 text-muted-foreground/20" />
                <p className="text-sm leading-relaxed text-muted-foreground pl-4">
                  {t.content}
                </p>
              </div>

              <div className="mt-5 flex items-center gap-3 border-t border-border/40 pt-4">
                <div
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br ${t.avatarColor} text-xs font-bold text-white`}
                >
                  {t.avatar}
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{t.name}</span>
                  <span className="text-xs text-muted-foreground">{t.role}</span>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
