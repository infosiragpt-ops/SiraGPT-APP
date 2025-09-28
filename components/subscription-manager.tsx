"use client"

import { useState, useEffect } from 'react'
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
  Settings
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context-integrated'
import { apiClient } from '@/lib/api'

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

  const planInfo: Record<string, { 
    color: string, 
    icon: any, 
    limit: string, 
    price: number,
    features: string[] 
  }> = {
    FREE: {
      color: 'from-gray-500 to-gray-600',
      icon: Users,
      limit: '3 calls/month',
      price: 0,
      features: ['Basic AI Chat', 'Community Support']
    },
    BASIC: {
      color: 'from-blue-500 to-cyan-500',
      icon: Crown,
      limit: '10,000 calls/month',
      price: 5,
      features: ['AI Chat', 'Text Generation', 'Email Support']
    },
    STANDARD: {
      color: 'from-purple-500 to-pink-500', 
      icon: Sparkles,
      limit: '30,000 calls/month',
      price: 15,
      features: ['Everything in Basic', 'Image Generation', 'Priority Support', 'Advanced Models']
    },
    ENTERPRISE: {
      color: 'from-amber-500 to-orange-500',
      icon: Zap,
      limit: '10M calls/month',
      price: 99,
      features: ['Everything in Standard', 'Audio Generation', 'Video Generation', 'Dedicated Support', 'Custom Integration']
    }
  }

  useEffect(() => {
    fetchSubscriptionData()
  }, [])

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
  const usagePercentage = user.monthlyLimit > 0 ? ((user.monthlyLimit - (user.monthlyCallLimit || 0)) / user.monthlyLimit) * 100 : 0

  return (
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
                  ${currentPlanInfo?.price}/month
                </p>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Usage Progress */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">API Usage This Month</span>
              <span className="text-sm text-muted-foreground">
                {user.monthlyLimit - (user.monthlyCallLimit || 0)}/{user.monthlyLimit}
              </span>
            </div>
            <Progress value={usagePercentage} className="h-2" />
            <p className="text-xs text-muted-foreground mt-1">
              {user.monthlyCallLimit || 0} calls remaining
            </p>
          </div>

          <Separator />

          {/* Plan Features */}
          <div>
            <h4 className="font-semibold mb-3 flex items-center">
              <CheckCircle className="h-4 w-4 mr-2" />
              Plan Features
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
                      <p className="text-sm font-medium">Next Billing</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(subscriptionData.currentPeriodEnd).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                )}
                
                <div className="flex items-center space-x-3 p-3 bg-muted/50 rounded-lg">
                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Payment Method</p>
                    <p className="text-xs text-muted-foreground">
                      {subscriptionData.paymentMethod || 'Stripe'}
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
              Subscription Management
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {subscriptionData?.cancelAtPeriodEnd ? (
              <div className="flex items-start space-x-3 p-4 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    Subscription Ending
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                    Your subscription will end on {subscriptionData.currentPeriodEnd ? new Date(subscriptionData.currentPeriodEnd).toLocaleDateString() : 'the next billing date'}. 
                    You can reactivate it anytime before then.
                  </p>
                  <Button 
                    size="sm" 
                    variant="outline" 
                    className="mt-3"
                    onClick={handleReactivateSubscription}
                    disabled={actionLoading === 'reactivate'}
                  >
                    {actionLoading === 'reactivate' && <RefreshCw className="h-3 w-3 mr-2 animate-spin" />}
                    Reactivate Subscription
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div>
                  <p className="font-medium">Cancel Subscription</p>
                  <p className="text-sm text-muted-foreground">
                    You'll keep access until your current period ends
                  </p>
                </div>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleCancelSubscription}
                  disabled={actionLoading === 'cancel'}
                >
                  {actionLoading === 'cancel' && <RefreshCw className="h-3 w-3 mr-2 animate-spin" />}
                  Cancel
                </Button>
              </div>
            )}

            <Separator />

            <div className="flex items-center justify-between p-4 border rounded-lg">
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
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upgrade Options (for FREE users) */}
      {currentPlan === 'FREE' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <TrendingUp className="h-5 w-5 mr-2" />
              Upgrade Your Plan
            </CardTitle>
            <CardDescription>
              Get more API calls and unlock advanced features
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
                  <p className="text-2xl font-bold mb-1">${info.price}<span className="text-sm font-normal">/mo</span></p>
                  <p className="text-sm text-muted-foreground mb-4">{info.limit}</p>
                  <Button size="sm" className="w-full">
                    Upgrade to {plan}
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
            Usage Analytics
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="text-center p-4 bg-muted/50 rounded-lg">
              <p className="text-2xl font-bold">{user.monthlyLimit - (user.monthlyCallLimit || 0)}</p>
              <p className="text-sm text-muted-foreground">Calls Used This Month</p>
            </div>
            <div className="text-center p-4 bg-muted/50 rounded-lg">
              <p className="text-2xl font-bold">{user.monthlyCallLimit || 0}</p>
              <p className="text-sm text-muted-foreground">Calls Remaining</p>
            </div>
            <div className="text-center p-4 bg-muted/50 rounded-lg">
              <p className="text-2xl font-bold">{Math.round(usagePercentage)}%</p>
              <p className="text-sm text-muted-foreground">Usage This Month</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}