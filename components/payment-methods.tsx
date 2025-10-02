"use client"

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { 
  CreditCard, 
  Plus,
  Trash2,
  CheckCircle,
  ExternalLink,
  Shield
} from 'lucide-react'
import { useAuth } from '@/lib/auth-context-integrated'
import { toast } from 'sonner'

interface PaymentMethod {
  id: string
  type: 'card'
  brand?: string
  last4?: string
  expiryMonth?: number
  expiryYear?: number
  isDefault: boolean
}

export default function PaymentMethods() {
  const { user } = useAuth()
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddPayment, setShowAddPayment] = useState(false)

  useEffect(() => {
    fetchPaymentMethods()
  }, [])

  const fetchPaymentMethods = async () => {
    try {
      // Mock data - replace with actual API call
      const mockPaymentMethods: PaymentMethod[] = [
        {
          id: '1',
          type: 'card',
          brand: 'visa',
          last4: '4242',
          expiryMonth: 12,
          expiryYear: 2025,
          isDefault: true
        }
      ]

      setPaymentMethods(mockPaymentMethods)
    } catch (error) {
      console.error('Failed to fetch payment methods:', error)
      toast.error('Failed to load payment methods')
    } finally {
      setLoading(false)
    }
  }

  const handleSetDefault = async (paymentMethodId: string) => {
    try {
      setPaymentMethods(prev => 
        prev.map(pm => ({
          ...pm,
          isDefault: pm.id === paymentMethodId
        }))
      )
      toast.success('Default payment method updated')
    } catch (error) {
      toast.error('Failed to update default payment method')
    }
  }

  const handleRemovePaymentMethod = async (paymentMethodId: string) => {
    if (!confirm('Are you sure you want to remove this payment method?')) {
      return
    }

    try {
      setPaymentMethods(prev => prev.filter(pm => pm.id !== paymentMethodId))
      toast.success('Payment method removed')
    } catch (error) {
      toast.error('Failed to remove payment method')
    }
  }

  const handleUpdateBillingAddress = async () => {
    if (!billingAddress) return

    try {
      // API call to update billing address
      setShowEditBilling(false)
      toast.success('Billing address updated')
    } catch (error) {
      toast.error('Failed to update billing address')
    }
  }

  const getPaymentMethodIcon = (brand?: string) => {
    switch (brand?.toLowerCase()) {
      case 'visa':
        return '💳'
      case 'mastercard':
        return '💳'
      case 'amex':
        return '💳'
      default:
        return '💳'
    }
  }

  const formatCardBrand = (brand?: string) => {
    if (!brand) return 'Card'
    return brand.charAt(0).toUpperCase() + brand.slice(1)
  }

  if (!user) return null

  return (
    <div className="space-y-6">
      {/* Payment Methods */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                Payment Methods
              </CardTitle>
              <CardDescription>
                Manage your saved payment methods
              </CardDescription>
            </div>
            <Button onClick={() => setShowAddPayment(true)} className="flex items-center gap-2">
              <Plus className="h-4 w-4" />
              Add Method
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center p-8">
              <div className="animate-pulse">Loading payment methods...</div>
            </div>
          ) : paymentMethods.length === 0 ? (
            <div className="text-center py-8">
              <CreditCard className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">No payment methods found</p>
              <p className="text-sm text-muted-foreground mt-1">
                Add a payment method to manage your subscription
              </p>
              <Button 
                onClick={() => setShowAddPayment(true)} 
                className="mt-4 flex items-center gap-2"
              >
                <Plus className="h-4 w-4" />
                Add Payment Method
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {paymentMethods.map((method) => (
                <div key={method.id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center gap-4">
                    <div className="text-2xl">
                      {getPaymentMethodIcon(method.brand)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {`${formatCardBrand(method.brand)} •••• ${method.last4}`}
                        </span>
                        {method.isDefault && (
                          <Badge variant="default" className="text-xs">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Default
                          </Badge>
                        )}
                      </div>
                      {method.expiryMonth && method.expiryYear && (
                        <p className="text-sm text-muted-foreground">
                          Expires {method.expiryMonth.toString().padStart(2, '0')}/{method.expiryYear}
                        </p>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {!method.isDefault && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSetDefault(method.id)}
                      >
                        Set Default
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemovePaymentMethod(method.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment Information */}
      <Card>
        <CardHeader>
          <CardTitle>Payment Information</CardTitle>
          <CardDescription>
            Billing details are managed through Stripe during checkout
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 dark:border-blue-800">
              <p className="text-sm text-blue-800 dark:text-blue-200">
                💳 <strong>Stripe Checkout:</strong> When you subscribe, you'll enter your billing information securely through Stripe's payment form.
              </p>
            </div>
            <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg border border-green-200 dark:border-green-800">
              <p className="text-sm text-green-800 dark:text-green-200">
                🔒 <strong>Secure & Easy:</strong> No need to manage billing addresses here - everything is handled during the secure checkout process.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Security & Compliance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Payment Security
          </CardTitle>
          <CardDescription>
            Your payment information is secure and encrypted
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex items-start gap-3 p-4 bg-green-50 dark:bg-green-950/20 rounded-lg border border-green-200 dark:border-green-800">
              <Shield className="h-5 w-5 text-green-600 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-green-800 dark:text-green-200">
                  PCI DSS Compliant
                </p>
                <p className="text-xs text-green-700 dark:text-green-300 mt-1">
                  Your payment data is processed securely according to industry standards
                </p>
              </div>
            </div>
            
            <div className="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 dark:border-blue-800">
              <CheckCircle className="h-5 w-5 text-blue-600 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                  SSL Encrypted
                </p>
                <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                  All transactions are protected with 256-bit SSL encryption
                </p>
              </div>
            </div>
          </div>
          
          <Separator className="my-4" />
          
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Billing Portal</p>
              <p className="text-sm text-muted-foreground">
                Manage your billing through our secure partner portal
              </p>
            </div>
            <Button variant="outline" className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4" />
              Open Portal
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Add Payment Method Modal Placeholder */}
      {showAddPayment && (
        <Card className="border-blue-200 bg-blue-50/50 dark:bg-blue-950/20">
          <CardHeader>
            <CardTitle>Add Payment Method</CardTitle>
            <CardDescription>
              Payment methods are added during subscription checkout
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8">
              <CreditCard className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground mb-4">
                New payment methods are added when you upgrade or change your subscription through Stripe checkout.
              </p>
              <div className="flex gap-2 justify-center">
                <Button onClick={() => setShowAddPayment(false)}>
                  Close
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}