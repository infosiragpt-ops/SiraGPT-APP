"use client"

import { useEffect, Suspense } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useAuth } from "@/lib/auth-context-integrated"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
function AuthCallbackContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { loginWithToken, isLoading } = useAuth()

  useEffect(() => {

    const handleCallback = async () => {
      const token = searchParams.get('token')
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
        // try {
        //   // Verify token by getting user info
        //   const apiUrl = `${process.env.NEXT_PUBLIC_API_URL}/auth/me`;
        //   const response = await fetch(apiUrl, {
        //     headers: {
        //       'Authorization': `Bearer ${token}`
        //     }
        //   })


        //   if (response.ok) {
        //     console.log("OK ", token);

        //     router.push('/chat')
        //   } else {
        //     router.push('/auth/login?error=Invalid token')
        //   }
        // } catch (error) {
        //   router.push('/auth/login?error=Authentication failed')
        // }
      } else {
        router.push('/auth/login')
      }
    }

    handleCallback()
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