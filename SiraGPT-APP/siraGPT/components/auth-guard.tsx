"use client"
import { useAuth } from "@/lib/auth-context-integrated"
import { getAuthRedirect } from "@/lib/auth/auth-guard-rules"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
interface AuthGuardProps {
  children: React.ReactNode
  requireAdmin?: boolean
  requireSuperAdmin?: boolean
}

export function AuthGuard({ children, requireAdmin = false, requireSuperAdmin = false }: AuthGuardProps) {
  const { user, isLoading } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (isLoading) return

    const redirect = getAuthRedirect(user, { requireAdmin, requireSuperAdmin })
    if (redirect) router.push(redirect)
  }, [user, isLoading, requireAdmin, requireSuperAdmin, router])

  const redirect = getAuthRedirect(user, { requireAdmin, requireSuperAdmin })

  if (isLoading) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-4 px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-card shadow-sm">
            <ThinkingIndicator size="md" className="text-primary" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Cargando Sira GPT</p>
            <p className="text-xs text-muted-foreground">Preparando tu espacio de trabajo...</p>
          </div>
        </div>
      </div>
    )
  }

  if (redirect) {
    return null
  }

  return <>{children}</>
}
