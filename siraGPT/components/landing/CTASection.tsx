"use client"

import { motion } from "framer-motion"
import { ArrowRight, Sparkles } from "lucide-react"
import Link from "next/link"

export function CTASection() {
  return (
    <section className="relative overflow-hidden py-24 lg:py-32">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-[600px] w-[600px] rounded-full bg-primary/5 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-4xl px-6 text-center lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6 }}
        >
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-accent/40 px-3 py-1 text-xs font-medium text-foreground/80 mb-6">
            <Sparkles className="h-3 w-3" />
            <span>Empieza gratis hoy</span>
          </div>

          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            ¿Listo para potenciar tu{" "}
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-violet-500 to-fuchsia-500">
              productividad con IA?
            </span>
          </h2>

          <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground leading-relaxed">
            Únete a miles de profesionales que ya usan Sira GPT. Regístrate en segundos y empieza a crear.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/auth/register"
              className="group inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-6 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90"
            >
              Crear cuenta gratis
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/auth/login"
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-background px-6 text-sm font-medium text-foreground transition-all hover:bg-accent"
            >
              Ya tengo cuenta
            </Link>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            No se requiere tarjeta de crédito. Cancela cuando quieras.
          </p>
        </motion.div>
      </div>
    </section>
  )
}
