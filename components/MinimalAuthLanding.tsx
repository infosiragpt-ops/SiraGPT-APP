"use client"

import Link from "next/link"
import { AudioLines, Mic, Plus } from "lucide-react"
import { BottomGlowBar } from "@/components/BottomGlowBar"
import { ThemeToggle } from "@/components/theme-toggle"

function PrimumMark() {
  return (
    <div className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-white shadow-[0_18px_45px_-18px_rgba(124,58,237,0.75)] ring-1 ring-purple-200">
      <div className="absolute inset-[3px] rounded-[14px] bg-[linear-gradient(135deg,#7c3aed_0%,#fff_48%,#f97316_100%)] opacity-95" />
      <div className="relative flex h-7 w-7 items-center justify-center rounded-xl bg-white/90 text-[16px] font-black text-slate-950 shadow-inner">
        P
      </div>
    </div>
  )
}

function AuthActions() {
  return (
    <div className="flex items-center gap-3">
      <Link
        href="/auth/login"
        className="inline-flex h-11 items-center justify-center rounded-full border border-purple-200 bg-white px-5 text-[13.5px] font-semibold text-slate-900 shadow-[0_18px_50px_-34px_rgba(15,23,42,0.8)] transition hover:border-purple-300"
      >
        Login
      </Link>
      <Link
        href="/auth/register"
        className="group relative inline-flex h-11 items-center justify-center overflow-hidden rounded-full bg-slate-950 px-6 text-[13.5px] font-semibold text-white shadow-[0_20px_45px_-18px_rgba(124,58,237,0.9)] transition hover:-translate-y-0.5"
      >
        <span className="absolute inset-0 bg-[linear-gradient(135deg,#7c3aed_0%,#f97316_100%)]" />
        <span className="absolute inset-y-0 left-0 w-1/2 -translate-x-full bg-white/25 blur-xl transition duration-700 group-hover:translate-x-[240%]" />
        <span className="relative">Sign Up</span>
      </Link>
    </div>
  )
}

function HeroChatBar() {
  return (
    <form
      action="/auth/login"
      className="mx-auto flex h-[74px] w-full max-w-[1180px] items-center gap-3 rounded-full border border-slate-200 bg-white px-5 shadow-[0_18px_52px_-30px_rgba(15,23,42,0.78)] ring-1 ring-black/5 sm:h-[86px] sm:px-7"
    >
      <button
        type="button"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-950 transition hover:bg-slate-100 sm:h-12 sm:w-12"
        aria-label="Adjuntar archivo"
      >
        <Plus className="h-6 w-6 stroke-[2.2]" />
      </button>

      <input
        name="prompt"
        autoComplete="off"
        className="h-full min-w-0 flex-1 bg-transparent text-[22px] font-normal text-slate-900 outline-none placeholder:text-slate-400 sm:text-[28px]"
        placeholder="Escribe un mensaje"
      />

      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        <button
          type="button"
          className="hidden h-11 w-11 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 sm:flex"
          aria-label="Dictar con micrófono"
        >
          <Mic className="h-6 w-6 stroke-[2.2]" />
        </button>
        <button
          type="submit"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-black text-white shadow-[0_14px_34px_-14px_rgba(0,0,0,0.72)] transition hover:scale-[1.03] active:scale-95 sm:h-16 sm:w-16"
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
      <main className="relative min-h-screen overflow-x-hidden bg-white text-slate-950">
        <header className="fixed inset-x-0 top-0 z-50 border-b border-slate-200/80 bg-white/88 backdrop-blur-2xl">
          <div className="mx-auto flex h-[76px] max-w-[1420px] items-center justify-between px-5 sm:px-8">
            <Link href="/auth" className="flex items-center gap-3">
              <PrimumMark />
              <div>
                <span className="block text-[21px] font-black tracking-tight text-slate-950">Primum</span>
                <span className="block text-[10px] font-bold uppercase tracking-[0.26em] text-purple-950/72">AI Platform</span>
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
