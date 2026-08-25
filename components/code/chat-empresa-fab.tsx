"use client"

import { Building2 } from "lucide-react"
import { useRouter } from "next/navigation"

import { cn } from "@/lib/utils"

export function ChatEmpresaFab({ className }: { className?: string }) {
  const router = useRouter()

  return (
    <button
      type="button"
      data-testid="chat-empresa-fab"
      aria-label="Ir a empresas"
      onClick={() => router.push("/agentes")}
      className={cn(
        "pointer-events-auto inline-flex h-12 items-center gap-2 rounded-full bg-zinc-950 px-4 text-[13px] font-semibold text-white shadow-[0_12px_28px_-12px_rgba(15,23,42,0.65)] ring-1 ring-black/10 transition-transform active:scale-[0.98] dark:bg-white dark:text-zinc-950",
        className,
      )}
    >
      <Building2 className="h-4 w-4" />
      Empresa
    </button>
  )
}
