'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CheckCircle, XCircle, Crown, Sparkles, ArrowRight, Settings, CreditCard, Calendar, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context-integrated'
import { apiClient } from '@/lib/api'

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
function PaymentSuccessContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, refreshUser } = useAuth()
  const [loading, setLoading] = useState(true)
  const [success, setSuccess] = useState(false)
  const [sessionInfo, setSessionInfo] = useState<any>(null)
  const [subscriptionInfo, setSubscriptionInfo] = useState<any>(null)

  const sessionId = searchParams.get('session_id')

  // Plan features mapping
  const planFeatures: Record<string, {
    color: string,
    badge: string,
    icon: any,
    limit: string,
    features: string[]
  }> = {
    PRO: {
      color: 'from-blue-500 to-cyan-500',
      badge: 'bg-blue-500',
      icon: Crown,
      limit: '500,000 tokens/month',
      features: ['500,000 tokens per month', 'All AI models', 'Priority support', 'Advanced features']
    },
    PRO_MAX: {
      color: 'from-purple-500 to-pink-500',
      badge: 'bg-purple-500',
      icon: Sparkles,
      limit: '1,000,000 tokens/month',
      features: ['1,000,000 tokens per month', 'All AI models', 'Priority support', 'Advanced features', 'Enhanced rate limits']
    },
    ENTERPRISE: {
      color: 'from-amber-500 to-orange-500',
      badge: 'bg-amber-500',
      icon: Crown,
      limit: '10,000,000 tokens/month',
      features: ['10,000,000 tokens per month', 'All features', 'Dedicated support', 'Custom integrations', 'SLA guaranteed']
    }
  }

  useEffect(() => {
    if (!sessionId) {
      setLoading(false)
      return
    }

    // Verify payment success with backend
    const verifyPayment = async () => {
      try {
        const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'
        const response = await fetch(`${apiBaseUrl}/payments/verify-session?session_id=${sessionId}`, {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
          }
        })

        if (response.ok) {
          const data = await response.json()
          setSuccess(true)
          setSessionInfo(data)

          // Fetch updated user data and update context
          try {
            refreshUser();
            // Fetch subscription details
            try {
              const subResponse = await fetch(`${apiBaseUrl}/payments/subscription`, {
                headers: {
                  'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
                }
              })
              if (subResponse.ok) {
                const subData = await subResponse.json()
                setSubscriptionInfo(subData)
              }
            } catch (subError) {
              console.warn('Failed to fetch subscription details:', subError)
            }
          } catch (userError) {
            console.warn('Failed to update user context:', userError)
          }

          toast.success('Payment successful! Your subscription has been activated.')
        } else {
          setSuccess(false)
          toast.error('Payment verification failed. Please contact support.')
        }
      } catch (error) {
        console.error('Payment verification error:', error)
        setSuccess(false)
        toast.error('Error verifying payment. Please contact support.')
      } finally {
        setLoading(false)
      }
    }

    verifyPayment()
    // refreshUser comes from useAuth() and is intentionally NOT in deps —
    // verifyPayment fires once per session and only needs the latest
    // refresh closure, not a re-fire on identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, toast])

  const handleContinue = () => {
    // Redirect to chat or profile page
    router.push('/chat')
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center space-y-4">
              <ThinkingIndicator size="lg" className="text-blue-600" />
              <h2 className="text-xl font-semibold">Verificando pago…</h2>
              <p className="text-sm text-muted-foreground text-center">
                Espera mientras confirmamos tu pago.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const currentPlanInfo = sessionInfo?.plan ? planFeatures[sessionInfo.plan] : null

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-blue-50 to-purple-50 dark:from-emerald-950/20 dark:via-blue-950/20 dark:to-purple-950/20">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          {success && sessionInfo ? (
            <>
              {/* Success Header */}
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 mb-6 animate-pulse">
                  <CheckCircle className="h-12 w-12 text-white" />
                </div>
                <h1 className="text-4xl font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent mb-2">
                  ¡Te damos la bienvenida a {sessionInfo.plan}!
                </h1>
                <p className="text-lg text-muted-foreground">
                  Tu suscripción se activó correctamente
                </p>
              </div>

              <div className="grid lg:grid-cols-2 gap-8">
                {/* Plan Details Card */}
                <Card className="relative overflow-hidden">
                  <div className={`absolute inset-0 bg-gradient-to-br ${currentPlanInfo?.color} opacity-5`} />
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        {currentPlanInfo?.icon && <currentPlanInfo.icon className="h-8 w-8" />}
                        <div>
                          <CardTitle className="text-2xl">Plan {sessionInfo.plan}</CardTitle>
                          <p className="text-muted-foreground">Suscripción activa</p>
                        </div>
                      </div>
                      <Badge className={`${currentPlanInfo?.badge} text-white`}>
                        Activa
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
                      <span className="font-medium">Límite mensual</span>
                      <span className="text-lg font-bold">{currentPlanInfo?.limit}</span>
                    </div>

                    <div>
                      <h4 className="font-semibold mb-3 flex items-center">
                        <Sparkles className="h-4 w-4 mr-2" />
                        Qué incluye
                      </h4>
                      <div className="space-y-2">
                        {currentPlanInfo?.features.map((feature, index) => (
                          <div key={index} className="flex items-center">
                            <CheckCircle className="h-4 w-4 text-green-500 mr-2 flex-shrink-0" />
                            <span className="text-sm">{feature}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <Separator />

                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Importe pagado</p>
                        <p className="font-semibold">${sessionInfo.amount}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Próximo cobro</p>
                        <p className="font-semibold">
                          {subscriptionInfo?.nextBilling ?
                            new Date(subscriptionInfo.nextBilling).toLocaleDateString() :
                            'Mensual'
                          }
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Quick Actions Card */}
                <div className="space-y-6">
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center">
                        <ArrowRight className="h-5 w-5 mr-2" />
                        Empezar
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <Button onClick={handleContinue} className="w-full" size="lg">
                        <Sparkles className="h-4 w-4 mr-2" />
                        Empezar a crear con IA
                      </Button>

                      <div className="grid grid-cols-2 gap-3">
                        <Button
                          variant="outline"
                          onClick={() => router.push('/profile')}
                          className="flex-col h-auto py-4"
                        >
                          <Users className="h-5 w-5 mb-1" />
                          <span className="text-xs">Ver perfil</span>
                        </Button>

                        <Button
                          variant="outline"
                          onClick={() => router.push('/gpts')}
                          className="flex-col h-auto py-4"
                        >
                          <Crown className="h-5 w-5 mb-1" />
                          <span className="text-xs">Explorar GPTs</span>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Subscription Management */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center">
                        <Settings className="h-5 w-5 mr-2" />
                        Gestionar suscripción
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                        <div className="flex items-center">
                          <Calendar className="h-4 w-4 mr-2 text-muted-foreground" />
                          <span className="text-sm">Estado</span>
                        </div>
                        <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                          Activa
                        </Badge>
                      </div>

                      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                        <div className="flex items-center">
                          <CreditCard className="h-4 w-4 mr-2 text-muted-foreground" />
                          <span className="text-sm">Facturación</span>
                        </div>
                        <span className="text-sm font-medium">Mensual</span>
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => router.push('/profile?tab=subscription')}
                      >
                        Gestionar facturación y uso
                      </Button>
                    </CardContent>
                  </Card>

                  {/* Payment Receipt */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Comprobante de pago</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-xs text-muted-foreground">
                      <div className="flex justify-between">
                        <span>ID de transacción:</span>
                        <span className="font-mono">{sessionInfo.sessionId.slice(-8)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Fecha de pago:</span>
                        <span>{new Date().toLocaleDateString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Método:</span>
                        <span>Stripe</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </>
          ) : success === false ? (
            /* Failure State */
            <div className="text-center max-w-md mx-auto">
              <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-gradient-to-br from-red-400 to-red-500 mb-6">
                <XCircle className="h-12 w-12 text-white" />
              </div>
              <h1 className="text-3xl font-bold text-red-600 mb-4">Pago fallido</h1>
              <Card>
                <CardContent className="pt-6">
                  <p className="text-muted-foreground mb-6">
                    Hubo un problema al procesar tu pago. Tranquilo, no se realizó ningún cargo.
                  </p>
                  {!sessionId && (
                    <p className="text-sm text-red-600 mb-6">
                      No se encontró el ID de sesión. Puede que el enlace de pago no sea válido.
                    </p>
                  )}
                  <div className="space-y-3">
                    <Button onClick={() => router.push('/chat')} className="w-full">
                      Reintentar
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => router.push('/profile')}
                      className="w-full"
                    >
                      Ir al perfil
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default function PaymentSuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center space-y-4">
              <ThinkingIndicator size="lg" className="text-blue-600" />
              <h2 className="text-xl font-semibold">Loading...</h2>
              <p className="text-sm text-muted-foreground text-center">
                Please wait while we load your payment details.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    }>
      <PaymentSuccessContent />
    </Suspense>
  )
}
