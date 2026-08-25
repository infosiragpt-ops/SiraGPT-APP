"use client"

import { Building2, MessageSquareText } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"

import { cn } from "@/lib/utils"

export function ChatEmpresaFab({ className }: { className?: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const onEmpresa = pathname === "/code" || pathname.startsWith("/code/")
  const label = onEmpresa ? "Chat" : "Empresa"
  const href = onEmpresa ? "/agentes" : "/code"
  const Icon = onEmpresa ? MessageSquareText : Building2

  return (
    <button
      type="button"
      data-testid="chat-empresa-fab"
      aria-label={onEmpresa ? "Ir al chat" : "Ir a empresas"}
      onClick={() => router.push(href)}
      className={cn(
        "pointer-events-auto inline-flex h-12 items-center gap-2 rounded-full bg-zinc-950 px-4 text-[13px] font-semibold text-white shadow-[0_12px_28px_-12px_rgba(15,23,42,0.65)] ring-1 ring-black/10 transition-transform active:scale-[0.98] dark:bg-white dark:text-zinc-950",
        className,
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}
