'use client'

import { useRouter } from 'next/navigation'
import { XCircle, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function PaymentCancelPage() {
  const router = useRouter()

  const handleTryAgain = () => {
    // Redirect back to subscription page
    router.push('/chat')
  }

  const handleGoHome = () => {
    router.push('/')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-950/20 dark:to-orange-950/20">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <XCircle className="h-16 w-16 text-orange-600" />
          </div>
          <CardTitle className="text-2xl">
            Payment Cancelled
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center space-y-2">
            <p className="text-muted-foreground">
              Your payment was cancelled. No charges have been made to your account.
            </p>
            <p className="text-sm text-muted-foreground">
              You can try again anytime or continue using the free plan.
            </p>
          </div>
          
          <div className="bg-orange-50 dark:bg-orange-950/20 p-4 rounded-lg">
            <h3 className="font-semibold mb-2">What happens now?</h3>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• Your account remains on the free plan</li>
              <li>• You can still use all free features</li>
              <li>• Upgrade anytime to unlock premium features</li>
            </ul>
          </div>

          <div className="space-y-2">
            <Button onClick={handleTryAgain} className="w-full">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to App
            </Button>
            <Button 
              variant="outline" 
              onClick={handleGoHome}
              className="w-full"
            >
              Go to Homepage
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}