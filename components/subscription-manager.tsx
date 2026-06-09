"use client"

import { useState, useEffect } from 'react'
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Progress } from '@/components/ui/progress'
import { 
  Crown, 
  Sparkles, 
  Calendar, 
  CreditCard, 
  AlertTriangle, 
  CheckCircle,
  ExternalLink,
  RefreshCw,
  Zap,
  TrendingUp,
  Users,
  Settings,
  ArrowUpDown,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context-integrated'
import { apiClient } from '@/lib/api'
import PlanChangeManager from './plan-change-manager'
import AnalyticsDashboard from './analytics-dashboard'

interface SubscriptionData {
  status: string
  plan: string
  currentPeriodEnd?: string
  cancelAtPeriodEnd?: boolean
  nextBillingAmount?: number
  paymentMethod?: string
}

export default function SubscriptionManager() {
  const { user, refreshUser } = useAuth()
  const [subscriptionData, setSubscriptionData] = useState<SubscriptionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [showPlanChange, setShowPlanChange] = useState(false)
  const [activeTab, setActiveTab] = useState('overview')

  const planInfo: Record<string, {
    color: string,
    icon: any,
    limit: string,
    price: number,
    priceLabel: string,
    billingLabel: string,
    features: string[]
  }> = {
    FREE: {
      color: 'from-gray-500 to-gray-600',
      icon: Users,
      limit: 'Acceso inicial',
      price: 0,
      priceLabel: 'Gratis',
      billingLabel: '',
      features: ['Chat IA básico', 'Soporte de la comunidad']
    },
    PRO: {
      color: 'from-blue-500 to-cyan-500',
      icon: Crown,
      limit: 'Acceso completo a SiraGPT',
      price: 5,
      priceLabel: '$5',
      billingLabel: '/mes',
      features: ['Todos los modelos líderes', 'Documentos, imágenes, código y agentes', 'Soporte prioritario']
    },
    PRO_MAX: {
      color: 'from-purple-500 to-pink-500',
      icon: Sparkles,
      limit: 'Todo Pro con experiencia ampliada',
      price: 10,
      priceLabel: '$10',
      billingLabel: '/mes',
      features: ['Todo lo de Pro', 'Más capacidad para trabajo frecuente', 'Prioridad superior']
    },
    ENTERPRISE: {
      color: 'from-amber-500 to-orange-500',
      icon: Zap,
      limit: 'Solución personalizada para equipos',
      price: Number.POSITIVE_INFINITY,
      priceLabel: 'Enterprise',
      billingLabel: 'WhatsApp',
      features: ['Acceso completo para equipos', 'Integraciones y seguridad', 'Acompañamiento directo']
    }
  }

  useEffect(() => {
    fetchSubscriptionData()
    
    // No need for expiration checking with normal Stripe billing
  }, [refreshUser])

  const fetchSubscriptionData = async () => {
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/payments/subscription`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        }
      })
      
      if (response.ok) {
        const data = await response.json()
        setSubscriptionData(data)
      }
    } catch (error) {
      console.error('Failed to fetch subscription data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleCancelSubscription = async () => {
    if (!confirm('Are you sure you want to cancel your subscription? You will still have access until the end of your current billing period.')) {
      return
    }

    setActionLoading('cancel')
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/payments/subscription/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        }
      })

      if (response.ok) {
        toast.success('Subscription canceled successfully')
        await fetchSubscriptionData()
       refreshUser()
      } else {
        toast.error('Failed to cancel subscription')
      }
    } catch (error) {
      toast.error('Error canceling subscription')
    } finally {
      setActionLoading(null)
    }
  }

  const handleReactivateSubscription = async () => {
    setActionLoading('reactivate')
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/payments/subscription/reactivate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('auth-token')}`
        }
      })

      if (response.ok) {
        toast.success('Subscription reactivated successfully')
        await fetchSubscriptionData()
        refreshUser()
      } else {
        toast.error('Failed to reactivate subscription')
      }
    } catch (error) {
      toast.error('Error reactivating subscription')
    } finally {
      setActionLoading(null)
    }
  }

  if (!user) return null

  const currentPlan = user.plan || 'FREE'
  const currentPlanInfo = planInfo[currentPlan]
  
  // Calculate usage correctly based on plan type
  let usedAmount, totalLimit, remainingAmount, usagePercentage
  
  if (currentPlan === 'FREE') {
    // For free users: monthlyCallLimit is remaining calls (countdown)
    totalLimit = 3
    remainingAmount = user.monthlyLimit || 0
    usedAmount = totalLimit - remainingAmount
    usagePercentage = totalLimit > 0 ? (usedAmount / totalLimit) * 100 : 0
  } else {
    // For paid users: apiUsage tracks internal monthly activity units.
    totalLimit = user.monthlyLimit || 0
    usedAmount = user.apiUsage || 0
    remainingAmount = Math.max(0, totalLimit - usedAmount)
    usagePercentage = totalLimit > 0 ? (usedAmount / totalLimit) * 100 : 0
  }

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="border-b">
        <nav className="flex space-x-8">
          <button
            onClick={() => setActiveTab('overview')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'overview'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Overview
          </button>
          {/* {user?.isAdmin && (
            <button
              onClick={() => setActiveTab('analytics')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'analytics'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Analytics
            </button>
          )} */}
        </nav>
      </div>

      {activeTab === 'analytics' ? (
        <AnalyticsDashboard isAdmin={user?.isAdmin || false} />
      ) : (
        <div className="space-y-6">
          {/* Current Plan Overview */}
          <Card className="relative overflow-hidden">
        <div className={`absolute inset-0 bg-gradient-to-br ${currentPlanInfo?.color} opacity-5`} />
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {currentPlanInfo?.icon && <currentPlanInfo.icon className="h-8 w-8" />}
              <div>
                <CardTitle className="text-2xl">{currentPlan} Plan</CardTitle>
                <CardDescription>
                  {subscriptionData?.status === 'active' ? 'Active subscription' : 
                   subscriptionData?.cancelAtPeriodEnd ? 'Canceling at period end' :
                   'Current plan'}
                </CardDescription>
              </div>
            </div>
            <div className="text-right">
              <Badge 
                variant={subscriptionData?.status === 'active' ? 'default' : 'secondary'}
                className={subscriptionData?.status === 'active' ? 'bg-green-500' : ''}
              >
                {subscriptionData?.status || 'Active'}
              </Badge>
              {currentPlan !== 'FREE' && (
                <p className="text-sm text-muted-foreground mt-1">
                  {currentPlanInfo?.priceLabel}{currentPlanInfo?.billingLabel ? currentPlanInfo.billingLabel : ''}
                </p>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Usage Progress */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">{currentPlan === 'FREE' ? 'Actividad gratuita este mes' : 'Actividad del mes'}</span>
              <span className="text-sm text-muted-foreground">
                {currentPlan === 'FREE' ? `${usedAmount.toLocaleString()}/${totalLimit.toLocaleString()}` : `${Math.round(usagePercentage)}%`}
              </span>
            </div>
            <Progress value={usagePercentage} className="h-2" />
            <p className="text-xs text-muted-foreground mt-1">
              {currentPlan === 'FREE'
                ? `Quedan ${remainingAmount.toLocaleString()} accesos gratuitos`
                : 'Tu plan sigue activo para continuar trabajando'}
            </p>
          </div>

          <Separator />

          {/* Plan Features */}
          <div>
            <h4 className="font-semibold mb-3 flex items-center">
              <CheckCircle className="h-4 w-4 mr-2" />
              Funciones del plan
            </h4>
            <div className="grid gap-2">
              {currentPlanInfo?.features.map((feature, index) => (
                <div key={index} className="flex items-center text-sm">
                  <CheckCircle className="h-3 w-3 text-green-500 mr-2 flex-shrink-0" />
                  <span>{feature}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Billing Information */}
          {subscriptionData && currentPlan !== 'FREE' && (
            <>
              <Separator />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {subscriptionData.currentPeriodEnd && (
                  <div className="flex items-center space-x-3 p-3 bg-muted/50 rounded-lg">
                    <Calendar className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">Próximo cobro</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(subscriptionData.currentPeriodEnd).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                )}
                
                <div className="flex items-center space-x-3 p-3 bg-muted/50 rounded-lg">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Método de pago</p>
                    <p className="text-xs text-muted-foreground">
                      Stripe
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Subscription Actions */}
      {currentPlan !== 'FREE' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Settings className="h-5 w-5 mr-2" />
              Gestión de suscripción
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {subscriptionData?.cancelAtPeriodEnd ? (
              <div className="flex items-start space-x-3 p-4 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    Suscripción por terminar
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                    Tu suscripción terminará el {subscriptionData.currentPeriodEnd ? new Date(subscriptionData.currentPeriodEnd).toLocaleDateString() : 'próximo cobro'}.
                    Puedes reactivarla en cualquier momento antes de esa fecha.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={handleReactivateSubscription}
                    disabled={actionLoading === 'reactivate'}
                  >
                    {actionLoading === 'reactivate' && <ThinkingIndicator size="xs" className="mr-2" />}
                    Reactivar suscripción
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div>
                  <p className="font-medium">Cancelar suscripción</p>
                  <p className="text-sm text-muted-foreground">
                    Mantendrás el acceso hasta que termine el periodo actual
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancelSubscription}
                  disabled={actionLoading === 'cancel'}
                >
                  {actionLoading === 'cancel' && <ThinkingIndicator size="xs" className="mr-2" />}
                  Cancelar
                </Button>
              </div>
            )}

            {/* <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Change Plan</p>
                <p className="text-sm text-muted-foreground">
                  Upgrade or downgrade with added limits (preserves current usage)
                </p>
              </div>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setShowPlanChange(true)}
              >
                <ArrowUpDown className="h-3 w-3 mr-2" />
                Change Plan
              </Button>
            </div> */}

            <Separator />

            {/* <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <p className="font-medium">Billing Portal</p>
                <p className="text-sm text-muted-foreground">
                  View invoices, update payment method, and download receipts
                </p>
              </div>
              <Button variant="outline" size="sm">
                <ExternalLink className="h-3 w-3 mr-2" />
                Open Portal
              </Button>
            </div> */}
          </CardContent>
        </Card>
      )}

      {/* Upgrade Options (for FREE users) */}
      {currentPlan === 'FREE' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <TrendingUp className="h-5 w-5 mr-2" />
              Mejora tu plan
            </CardTitle>
            <CardDescription>
              Accede a todo SiraGPT con una experiencia profesional y simple
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              {Object.entries(planInfo).filter(([plan]) => plan !== 'FREE').map(([plan, info]) => (
                <div key={plan} className="border rounded-lg p-4 relative">
                  <div className="flex items-center space-x-2 mb-2">
                    <info.icon className="h-5 w-5" />
                    <span className="font-semibold">{plan}</span>
                  </div>
                  <p className="text-2xl font-bold mb-1">{info.priceLabel}<span className="text-sm font-normal">{info.billingLabel ? ` ${info.billingLabel}` : ''}</span></p>
                  <p className="text-sm text-muted-foreground mb-4">{info.limit}</p>
                  <Button size="sm" className="w-full">
                    {plan === 'ENTERPRISE' ? 'Comunícate al WhatsApp' : `Elegir ${info.priceLabel}`}
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Usage Analytics */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <TrendingUp className="h-5 w-5 mr-2" />
            Métricas de uso
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="text-center p-4 bg-muted/50 rounded-lg">
              <p className="text-2xl font-bold">{currentPlan === 'FREE' ? usedAmount.toLocaleString() : `${Math.round(usagePercentage)}%`}</p>
              <p className="text-sm text-muted-foreground">Actividad este mes</p>
            </div>
            <div className="text-center p-4 bg-muted/50 rounded-lg">
              <p className="text-2xl font-bold">{currentPlan === 'FREE' ? remainingAmount.toLocaleString() : 'Activo'}</p>
              <p className="text-sm text-muted-foreground">Disponibilidad del plan</p>
            </div>
            <div className="text-center p-4 bg-muted/50 rounded-lg">
              <p className="text-2xl font-bold">{Math.round(usagePercentage)}%</p>
              <p className="text-sm text-muted-foreground">Uso este mes</p>
            </div>
          </div>
        </CardContent>
      </Card>
        </div>
      )}

      {/* Plan Change Modal - Large and Beautiful */}
      {showPlanChange && currentPlan !== 'FREE' && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-background border rounded-2xl shadow-2xl w-full max-w-6xl max-h-[95vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="sticky top-0 bg-background/95 backdrop-blur-md border-b px-8 py-6 rounded-t-2xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className="h-12 w-12 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                    <ArrowUpDown className="h-6 w-6 text-white" />
                  </div>
                  <div>
                    <h2 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                      Cambia tu plan
                    </h2>
                    <p className="text-muted-foreground mt-1">
                      Mejora o reduce tu plan con cálculos de prorrateo al instante
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="lg"
                  onClick={() => setShowPlanChange(false)}
                  className="rounded-full h-12 w-12 p-0"
                >
                  <X className="h-5 w-5" />
                </Button>
              </div>
            </div>
            
            {/* Modal Content */}
            <div className="p-8">
              <PlanChangeManager
                currentPlan={currentPlan}
                onPlanChanged={() => {
                  setShowPlanChange(false)
                  fetchSubscriptionData()
                  refreshUser()
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
