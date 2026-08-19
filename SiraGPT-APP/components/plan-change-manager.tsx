"use client"

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { 
  ArrowUpDown, 
  Calculator, 
  Calendar, 
  DollarSign,
  Info,
  AlertTriangle,
  CheckCircle,
  Sparkles
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context-integrated'
import { apiClient } from '@/lib/api'

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
interface PlanChangeModalProps {
  currentPlan: string
  onPlanChanged?: () => void
}

interface ProrationPreview {
  currentPlan: string
  newPlan: string
  currentPlanPrice: number
  newPlanPrice: number
  totalPeriodDays: number
  remainingDays: number
  unusedAmount: number
  newPlanProrated: number
  netAmount: number
  isUpgrade: boolean
  isDowngrade: boolean
  changeDate: string
  currentPeriodEnd: string
}

interface PlanInfo {
  name: string
  price: number
  priceLabel: string
  billingLabel: string
  limit: string
  features: string[]
  contactOnly?: boolean
}

export default function PlanChangeManager({ currentPlan, onPlanChanged }: PlanChangeModalProps) {
  const { user, refreshUser } = useAuth()
  const [selectedPlan, setSelectedPlan] = useState<string>('')
  const [preview, setPreview] = useState<ProrationPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [immediate, setImmediate] = useState(true)

  const planInfo: Record<'PRO' | 'PRO_MAX' | 'ENTERPRISE', PlanInfo> = {
    PRO: {
      name: 'Pro',
      price: 5,
      priceLabel: '$5',
      billingLabel: 'Facturación mensual',
      limit: 'Acceso completo a SiraGPT',
      features: ['Todos los modelos líderes', 'Documentos, imágenes, código y agentes', 'Soporte prioritario']
    },
    PRO_MAX: {
      name: 'Pro Extendido',
      price: 10,
      priceLabel: '$10',
      billingLabel: 'Facturación mensual',
      limit: 'Todo Pro con experiencia ampliada',
      features: ['Todo lo de Pro', 'Más capacidad para trabajo frecuente', 'Prioridad superior']
    },
    ENTERPRISE: {
      name: 'Enterprise',
      price: Number.POSITIVE_INFINITY,
      priceLabel: 'Enterprise',
      billingLabel: 'Por WhatsApp',
      limit: 'Solución personalizada para equipos',
      features: ['Acceso completo para equipos', 'Integraciones y seguridad', 'Acompañamiento directo'],
      contactOnly: true
    }
  }

  const availablePlans = Object.keys(planInfo).filter(plan => plan !== currentPlan)

  const previewPlanChange = async (newPlan: string) => {
    if (!newPlan) return

    setLoading(true)
    try {
      const response = await apiClient.previewPlanChange({ newPlan })

      if (response.proration) {
        setPreview(response.proration)
      } else {
        toast.error('Could not calculate plan change')
      }
    } catch (error: any) {
      console.error('Error previewing plan change:', error)
      toast.error(error.message || 'Failed to preview plan change')
    } finally {
      setLoading(false)
    }
  }

  const executePlanChange = async () => {
    if (!selectedPlan || !preview) return

    setExecuting(true)
    try {
      const response = await apiClient.executePlanChange({ 
        newPlan: selectedPlan, 
        immediate 
      })

      if (response.success) {
        toast.success(immediate 
          ? `Plan changed to ${selectedPlan} successfully!`
          : `Plan change to ${selectedPlan} scheduled for next billing cycle`
        )
        
        // Refresh user data and notify parent
        await refreshUser()
        onPlanChanged?.()
        
        // Reset state
        setSelectedPlan('')
        setPreview(null)
      } else {
        toast.error('Failed to change plan')
      }
    } catch (error: any) {
      console.error('Error executing plan change:', error)
      toast.error(error.message || 'Failed to change plan')
    } finally {
      setExecuting(false)
    }
  }

  const handlePlanSelect = (plan: string) => {
    const info = planInfo[plan as keyof typeof planInfo]
    if (info?.contactOnly) {
      const whatsappNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || ''
      const message = encodeURIComponent('Hola 👋, me interesa el plan Enterprise de SiraGPT. ¿Podrían ayudarme?')
      window.open(`https://wa.me/${whatsappNumber}?text=${message}`, '_blank', 'noopener,noreferrer')
      return
    }

    setSelectedPlan(plan)
    previewPlanChange(plan)
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount)
  }

  return (
    <div className="space-y-8">
      {/* Plan Selection */}
      <div>
        <div className="text-center mb-8">
          <h3 className="text-2xl font-bold mb-2">Elige tu nuevo plan</h3>
          <p className="text-muted-foreground">
            Selecciona Pro o Pro Extendido para revisar el cambio. Enterprise se coordina por WhatsApp.
          </p>
        </div>
        
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {availablePlans.map((plan) => {
            const info = planInfo[plan as keyof typeof planInfo]
            const isSelected = selectedPlan === plan
            const isUpgrade = info.price > (planInfo[currentPlan as keyof typeof planInfo]?.price || 0)
            
            return (
              <div
                key={plan}
                className={`relative border-2 rounded-2xl p-6 cursor-pointer transition-all duration-300 transform hover:scale-105 ${
                  isSelected 
                    ? 'border-blue-500 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 shadow-lg' 
                    : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 bg-background'
                }`}
                onClick={() => handlePlanSelect(plan)}
              >
                {/* Selection Indicator */}
                {isSelected && (
                  <div className="absolute -top-3 -right-3 h-8 w-8 bg-blue-500 rounded-full flex items-center justify-center shadow-lg">
                    <CheckCircle className="h-5 w-5 text-white" />
                  </div>
                )}

                {/* Plan Type Badge */}
                <div className="flex items-center justify-between mb-4">
                  <Badge 
                    variant={isUpgrade ? 'default' : 'secondary'}
                    className={`${isUpgrade 
                      ? 'bg-green-500 hover:bg-green-600' 
                      : 'bg-orange-500 hover:bg-orange-600'
                    } text-white font-medium px-3 py-1`}
                  >
                    {info.contactOnly ? 'Contactar' : isUpgrade ? '⬆ Upgrade' : '⬇ Downgrade'}
                  </Badge>
                </div>

                {/* Plan Name */}
                <h4 className="text-xl font-bold mb-2">{info.name} Plan</h4>
                
                {/* Price */}
                <div className="mb-4">
                  <div className="flex items-baseline">
                    <span className="text-3xl font-bold">
                      {info.priceLabel}
                    </span>
                    <span className="text-sm text-muted-foreground ml-1">{info.billingLabel}</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{info.limit}</p>
                </div>
                
                {/* Features */}
                <div className="space-y-2">
                  {info.features.slice(0, 3).map((feature, idx) => (
                    <div key={idx} className="flex items-center text-sm">
                      <CheckCircle className="h-4 w-4 text-green-500 mr-2 flex-shrink-0" />
                      <span className="text-muted-foreground">{feature}</span>
                    </div>
                  ))}
                </div>

                {/* Hover Effect Overlay */}
                <div className={`absolute inset-0 rounded-2xl bg-gradient-to-br from-blue-500/5 to-purple-500/5 opacity-0 transition-opacity duration-300 ${
                  !isSelected ? 'group-hover:opacity-100' : ''
                }`} />
              </div>
            )
          })}
        </div>
      </div>

      {/* Proration Preview */}
      {selectedPlan && (
        <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 rounded-2xl p-8 border border-gray-200 dark:border-gray-700">
          <div className="text-center mb-6">
            <div className="inline-flex items-center gap-2 bg-white dark:bg-gray-800 px-4 py-2 rounded-full border shadow-sm mb-4">
              <Calculator className="h-5 w-5 text-blue-500" />
              <span className="font-semibold">Vista previa de cobro</span>
              {loading && <ThinkingIndicator size="sm" className="text-blue-500" />}
            </div>
            <p className="text-muted-foreground">
              See exactly how this change affects your billing
            </p>
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <div className="relative">
                <ThinkingIndicator size="xl" className="text-blue-500" />
                <div className="absolute inset-0 h-12 w-12 rounded-full bg-blue-500/20 animate-pulse" />
              </div>
              <span className="text-lg font-medium">Calculando el prorrateo…</span>
              <span className="text-sm text-muted-foreground">Esto tardará solo un momento</span>
            </div>
          ) : preview ? (
            <div className="space-y-6">
              {/* Current vs New Comparison */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border shadow-sm">
                  <div className="text-center">
                    <div className="w-12 h-12 bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Calendar className="h-6 w-6 text-gray-600" />
                    </div>
                    <p className="text-sm text-muted-foreground mb-1">Plan actual</p>
                    <p className="text-xl font-bold">{preview.currentPlan}</p>
                    <p className="text-lg text-muted-foreground">{formatCurrency(preview.currentPlanPrice)}/month</p>
                  </div>
                </div>
                
                <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-xl p-6 border border-blue-200 dark:border-blue-700 shadow-sm">
                  <div className="text-center">
                    <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Sparkles className="h-6 w-6 text-blue-600" />
                    </div>
                    <p className="text-sm text-muted-foreground mb-1">Nuevo plan</p>
                    <p className="text-xl font-bold text-blue-600">{preview.newPlan}</p>
                    <p className="text-lg text-blue-600">{formatCurrency(preview.newPlanPrice)}/month</p>
                  </div>
                </div>
              </div>

              {/* Proration Breakdown */}
              <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border shadow-sm">
                <h4 className="font-semibold mb-4 flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-green-600" />
                  Proration Breakdown
                </h4>

                
                <div className="space-y-4">
                  <div className="flex justify-between items-center py-2">
                    <span className="text-muted-foreground">Días restantes del periodo</span>
                    <span className="font-semibold">{preview.remainingDays} of {preview.totalPeriodDays} days</span>
                  </div>
                  
                  <div className="flex justify-between items-center py-2 border-t">
                    <span className="text-muted-foreground">Monto no usado (plan actual)</span>
                    <span className="font-semibold text-green-600">-{formatCurrency(preview.unusedAmount)}</span>
                  </div>
                  
                  <div className="flex justify-between items-center py-2 border-t">
                    <span className="text-muted-foreground">Monto prorrateado (nuevo plan)</span>
                    <span className="font-semibold text-blue-600">+{formatCurrency(preview.newPlanProrated)}</span>
                  </div>

                  <div className="flex justify-between items-center py-3 border-t-2 border-gray-300 dark:border-gray-600">
                    <span className="text-lg font-bold">Monto a cobrar hoy</span>
                    <span className={`text-xl font-bold ${preview.netAmount >= 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {preview.netAmount >= 0 ? '+' : ''}{formatCurrency(preview.netAmount)}
                    </span>
                  </div>

                  {preview.netAmount < 0 && (
                    <div className="bg-green-50 dark:bg-green-950/20 p-4 rounded-lg border border-green-200 dark:border-green-800">
                      <div className="flex items-start gap-3">
                        <Info className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                        <div className="text-sm text-green-700 dark:text-green-300">
                          <p className="font-medium">Crédito aplicado</p>
                          <p>Recibirás un crédito de {formatCurrency(Math.abs(preview.netAmount))} que se aplicará a futuras facturas.</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Timing Options */}
              <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border shadow-sm">
                <h4 className="font-semibold mb-4 flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-purple-600" />
                  When should this change take effect?
                </h4>
                
                <div className="space-y-4">
                  <label className="flex items-start space-x-4 cursor-pointer p-4 rounded-lg border transition-colors hover:bg-gray-50 dark:hover:bg-gray-700">
                    <input
                      type="radio"
                      checked={immediate}
                      onChange={() => setImmediate(true)}
                      className="form-radio mt-1 h-4 w-4 text-blue-600"
                    />
                    <div>
                      <p className="font-semibold">Inmediato</p>
                      <p className="text-sm text-muted-foreground">
                        Change plan now with prorated billing calculated above
                      </p>
                    </div>
                  </label>
                  
                  <label className="flex items-start space-x-4 cursor-pointer p-4 rounded-lg border transition-colors hover:bg-gray-50 dark:hover:bg-gray-700">
                    <input
                      type="radio"
                      checked={!immediate}
                      onChange={() => setImmediate(false)}
                      className="form-radio mt-1 h-4 w-4 text-blue-600"
                    />
                    <div>
                      <p className="font-semibold">Próximo ciclo de cobro</p>
                      <p className="text-sm text-muted-foreground">
                        Change on {new Date(preview.currentPeriodEnd).toLocaleDateString()} - no immediate charges
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-4 pt-4">
                <Button
                  onClick={executePlanChange}
                  disabled={executing}
                  size="lg"
                  className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
                >
                  {executing && <ThinkingIndicator size="sm" className="mr-2" />}
                  {immediate ? 'Change Plan Now' : 'Schedule Change'}
                </Button>
                
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => {
                    setSelectedPlan('')
                    setPreview(null)
                  }}
                  className="px-8"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mx-auto mb-4">
                <Calculator className="h-8 w-8 text-blue-600" />
              </div>
              <p className="text-lg font-medium mb-2">Select a plan above</p>
              <p className="text-muted-foreground">Choose a new plan to see instant proration calculations</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
