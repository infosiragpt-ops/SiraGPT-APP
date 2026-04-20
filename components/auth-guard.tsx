"use client"
import { useAuth } from "@/lib/auth-context-integrated"
import { getAuthRedirect } from "@/lib/auth/auth-guard-rules"
import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { Loader2 } from "lucide-react"

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
      <div className="flex h-screen items-center justify-center w-full">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  if (redirect) {
    return null
  }

  return <>{children}</>
}
