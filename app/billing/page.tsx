"use client"

import { useAuth } from "@/lib/auth-context-integrated"
import { AuthGuard } from "@/components/auth-guard"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArrowLeft, CreditCard, Receipt, History } from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import SubscriptionManager from "@/components/subscription-manager"
import PaymentMethods from "@/components/payment-methods"
import BillingHistory from "@/components/billing-history"

export default function BillingPage() {
  return (
    <AuthGuard>
      <BillingContent />
    </AuthGuard>
  )
}

function BillingContent() {
  const { user } = useAuth()
  const searchParams = useSearchParams()
  const defaultTab = searchParams.get('tab') || 'subscription'

  if (!user) return null

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Link href="/chat">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Chat
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Billing & Subscription</h1>
            <p className="text-muted-foreground">Manage your subscription, payment methods, and billing history</p>
          </div>
        </div>

        <Tabs defaultValue={defaultTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-1">
            <TabsTrigger value="subscription" className="flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Subscription
            </TabsTrigger>
            {/* <TabsTrigger value="payment-methods" className="flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Payment Methods
            </TabsTrigger> */}
              {/* <TabsTrigger value="billing-history" className="flex items-center gap-2">
                <Receipt className="h-4 w-4" />
                Billing History
              </TabsTrigger> */}
          </TabsList>

          <TabsContent value="subscription" className="space-y-6">
            <SubscriptionManager />
          </TabsContent>

          {/* <TabsContent value="payment-methods" className="space-y-6">
            <PaymentMethods />
          </TabsContent> */}

          {/* <TabsContent value="billing-history" className="space-y-6">
            <BillingHistory />
          </TabsContent> */}
        </Tabs>
      </div>
    </div>
  )
}