"use client"

import Link from "next/link"
import { AudioLines, FileText, Mic, Plus } from "lucide-react"
import { BottomGlowBar } from "@/components/BottomGlowBar"
import { ThemeToggle } from "@/components/theme-toggle"

function PrimumMark() {
  return (
    <div className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-white dark:bg-zinc-800 shadow-[0_18px_45px_-18px_rgba(124,58,237,0.75)] ring-1 ring-purple-200 dark:ring-purple-900">
      <div className="absolute inset-[3px] rounded-[14px] bg-[linear-gradient(135deg,#7c3aed_0%,#fff_48%,#f97316_100%)] dark:bg-[linear-gradient(135deg,#7c3aed_0%,#27272a_48%,#f97316_100%)] opacity-95" />
      <div className="relative flex h-7 w-7 items-center justify-center rounded-xl bg-white/90 dark:bg-zinc-700/90 text-[16px] font-black text-slate-950 dark:text-zinc-100 shadow-inner">
        S
      </div>
    </div>
  )
}

function AuthActions() {
  return (
    <div className="flex items-center gap-3">
      <Link
        href="/auth/login"
        className="inline-flex h-11 items-center justify-center rounded-full border border-purple-200 dark:border-purple-800 bg-white dark:bg-zinc-800 px-5 text-[13.5px] font-semibold text-slate-900 dark:text-zinc-100 shadow-[0_18px_50px_-34px_rgba(15,23,42,0.8)] transition hover:border-purple-300 dark:hover:border-purple-700"
      >
        Iniciar sesión
      </Link>
      <Link
        href="/auth/register"
        className="group relative inline-flex h-11 items-center justify-center overflow-hidden rounded-full bg-slate-950 px-6 text-[13.5px] font-semibold text-white shadow-[0_20px_45px_-18px_rgba(124,58,237,0.9)] transition hover:-translate-y-0.5"
      >
        <span className="absolute inset-0 bg-[linear-gradient(135deg,#7c3aed_0%,#f97316_100%)]" />
        <span className="absolute inset-y-0 left-0 w-1/2 -translate-x-full bg-white/25 blur-xl transition duration-700 group-hover:translate-x-[240%]" />
        <span className="relative">Registrarse</span>
      </Link>
    </div>
  )
}

function HeroChatBar() {
  const loadAntiBriberyContext = () => {
    const input = document.getElementById("landing-anti-bribery-prompt") as HTMLInputElement | null
    if (!input) return
    input.value = "Sistema de Gestion Antisoborno ISO 37001 como herramienta anticorrupcion en Corporacion de Seguridad Integral Profesional SAC: desarrolla un titulo y enfoque juridico para Derecho, compliance penal, Ley N. 30424 y legislacion anticorrupcion peruana."
    input.focus()
  }

  return (
    <form
      action="/auth/login"
      className="composer-liquid-surface relative mx-auto flex h-[74px] w-full max-w-[1180px] items-center gap-3 overflow-hidden rounded-full border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-5 shadow-[0_18px_52px_-30px_rgba(15,23,42,0.78)] ring-1 ring-black/5 dark:ring-white/5 sm:h-[86px] sm:px-7"
    >
      <button
        type="button"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-950 dark:text-zinc-100 transition hover:bg-slate-100 dark:hover:bg-zinc-800 sm:h-12 sm:w-12"
        aria-label="Adjuntar archivo"
      >
        <Plus className="h-6 w-6 stroke-[2.2]" />
      </button>

      <div className="composer-context-field relative flex h-full min-w-0 flex-1 items-center" data-context-chip="true">
        <button
          type="button"
          className="anti-bribery-context-chip"
          onClick={loadAntiBriberyContext}
          aria-label="Cargar contexto ISO 37001 antisoborno"
          title="Cargar contexto ISO 37001 antisoborno"
        >
          <FileText className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          <span className="anti-bribery-context-chip__label">ISO 37001 antisoborno</span>
        </button>
        <input
          id="landing-anti-bribery-prompt"
          name="prompt"
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-[22px] font-normal text-slate-900 dark:text-zinc-100 outline-none placeholder:text-slate-400 dark:placeholder:text-zinc-500 sm:text-[28px]"
          placeholder="Escribe un mensaje"
        />
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        <button
          type="button"
          className="hidden h-11 w-11 items-center justify-center rounded-full text-slate-500 dark:text-zinc-400 transition hover:bg-slate-100 dark:hover:bg-zinc-800 hover:text-slate-900 dark:hover:text-zinc-200 sm:flex"
          aria-label="Dictar con micrófono"
        >
          <Mic className="h-6 w-6 stroke-[2.2]" />
        </button>
        <button
          type="submit"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-black dark:bg-white text-white dark:text-black shadow-[0_14px_34px_-14px_rgba(0,0,0,0.72)] transition hover:scale-[1.03] active:scale-95 sm:h-16 sm:w-16"
          aria-label="Iniciar chat"
        >
          <AudioLines className="h-7 w-7 stroke-[2.2]" />
        </button>
      </div>
    </form>
  )
}

export function MinimalAuthLanding() {
  return (
    <>
      <BottomGlowBar />
      <main className="relative min-h-screen overflow-x-hidden bg-white dark:bg-zinc-950 text-slate-950 dark:text-zinc-100">
        <header className="fixed inset-x-0 top-0 z-50 border-b border-slate-200/80 dark:border-zinc-800/80 bg-white/88 dark:bg-zinc-950/88 backdrop-blur-2xl">
          <div className="mx-auto flex h-[76px] max-w-[1420px] items-center justify-between px-5 sm:px-8">
            <Link href="/auth" className="flex items-center gap-3">
              <PrimumMark />
              <div>
                <span className="block text-[21px] font-black tracking-tight text-slate-950 dark:text-zinc-100">Sira GPT</span>
                <span className="block text-[10px] font-bold uppercase tracking-[0.26em] text-purple-950/72 dark:text-purple-300/72">Plataforma IA</span>
              </div>
            </Link>

            <div className="flex items-center gap-2 sm:gap-3">
              <ThemeToggle />
              <div className="hidden sm:block">
                <AuthActions />
              </div>
            </div>
          </div>
        </header>

        <section className="flex min-h-screen items-center justify-center px-5 pt-[76px] sm:px-8 lg:px-10">
          <HeroChatBar />
        </section>
      </main>
    </>
  )
}
