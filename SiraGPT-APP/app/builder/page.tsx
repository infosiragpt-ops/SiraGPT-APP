"use client"

import { Boxes } from "lucide-react"
import { BuilderIntake } from "@/components/builder/BuilderIntake"

const accent = "hsl(var(--accent-violet))"

export default function BuilderPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      {/* Atmosphere: violet glow + faint grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60rem 32rem at 50% -8%, hsl(var(--accent-violet) / 0.16), transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.035]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(70rem 40rem at 50% 0%, black, transparent 75%)",
        }}
      />

      <div className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
        {/* Header */}
        <header className="mb-12 text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1">
            <Boxes className="h-3.5 w-3.5" style={{ color: accent }} />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              siraGPT Builder
            </span>
          </div>
          <h1 className="text-balance text-4xl font-bold leading-[1.05] tracking-tight text-foreground sm:text-5xl">
            Describe tu idea.{" "}
            <span style={{ color: accent }}>La construimos contigo.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-balance text-base leading-relaxed text-muted-foreground">
            Responde unas preguntas y el builder arma el brief, el plan técnico y los
            primeros archivos de tu proyecto —{" "}
            <span className="text-foreground">web, móvil o desktop.</span>
          </p>
        </header>

        {/* Interactive panel */}
        <BuilderIntake />
      </div>
    </main>
  )
}
