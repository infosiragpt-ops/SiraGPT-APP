"use client"
import { useAuth } from "@/lib/auth-context-integrated"
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
     if (!user) {
        router.push("/auth/login")
        return
      }
      
    if (requireSuperAdmin && !user.isSuperAdmin) {
        router.push("/chat")
        return
      }
      
    if (requireAdmin && !user.isAdmin && !user.isSuperAdmin) {
        router.push("/chat")
        return
      }
  }, [user, isLoading, requireAdmin, requireSuperAdmin, router])

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center w-full">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  if (!user || (requireSuperAdmin && !user.isSuperAdmin) || (requireAdmin && !user.isAdmin && !user.isSuperAdmin)) {
    return null
  }

  return <>{children}</>
}