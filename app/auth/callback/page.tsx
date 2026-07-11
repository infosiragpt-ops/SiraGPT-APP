"use client"

import { useEffect, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useAuth } from "@/lib/auth-context-integrated"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
function AuthCallbackContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { loginWithToken, hydrateSession } = useAuth()

  useEffect(() => {

    const handleCallback = async () => {
      const token = searchParams.get('token')
      const sso = searchParams.get('sso')
      const error = searchParams.get('error')

      if (error) {
        router.push('/auth/login?error=' + encodeURIComponent('Error de autenticación'))
        return
      }

      if (token) {
        // Store token and redirect
        localStorage.setItem('auth-token', token)

        const loginSuccess = await loginWithToken(token);

        if (loginSuccess) {
          router.replace('/chat');
        } else {
          router.replace('/auth/login?error=' + encodeURIComponent('La sesión es inválida o expiró'));
        }
      } else if (sso === 'success') {
        const hydration = await hydrateSession()
        if (hydration.status === 'authenticated') {
          router.replace('/chat')
        } else if (hydration.status === 'unauthenticated') {
          router.replace('/auth/login?error=' + encodeURIComponent('La sesión es inválida o expiró'))
        } else {
          router.replace('/auth/login?error=' + encodeURIComponent('Error de autenticación'))
        }
      } else {
        router.push('/auth/login')
      }
    }

    handleCallback()
    // Auth methods come from useAuth() and are intentionally NOT in
    // deps — the callback fires exactly once per searchParams/router
    // change (i.e. once per auth-callback navigation). Re-firing on
    // a context function identity change would re-run the redirect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <ThinkingIndicator size="lg" className="mx-auto mb-4" />
        <p>Completando autenticación…</p>
      </div>
    </div>
  )
}


export default function AuthCallback() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <ThinkingIndicator size="lg" className="mx-auto mb-4" />
          <p>Cargando…</p>
        </div>
      </div>
    }>
      <AuthCallbackContent />
    </Suspense>
  )
}