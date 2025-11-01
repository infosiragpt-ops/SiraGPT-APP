"use client"

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from "@/lib/auth-context-integrated"
import { AuthGuard } from "@/components/auth-guard"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ArrowLeft, Camera, CreditCard, Shield, Eye, EyeOff } from "lucide-react"
import Link from "next/link"
import { toast } from 'sonner'
import { apiClient } from '@/lib/api'

export default function ProfilePage() {
  return (
    <AuthGuard>
      <ProfileContent />
    </AuthGuard>
  )
}

function ProfileContent() {
  const { user, refreshUser } = useAuth()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [profileData, setProfileData] = useState({
    name: user?.name || ''
  })
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  })
  const [showPassword, setShowPassword] = useState({
    current: false,
    new: false,
    confirm: false
  })
  const [subscriptionData, setSubscriptionData] = useState<any>(null)

  // Fetch subscription data
  useEffect(() => {
    if (user) {
      fetchSubscriptionData()
    }
  }, [user])

  const fetchSubscriptionData = async () => {
    try {
      const data = await apiClient.getSubscriptionInfo()
      setSubscriptionData(data)
    } catch (error) {
      console.error('Error fetching subscription data:', error)
      // Set fallback data for free users
      setSubscriptionData({
        plan: user?.plan || 'FREE',
        status: 'active',
        endDate: null
      })
    }
  }

  if (!user) return null

  // Calculate real usage stats based on plan type
  let usedCalls, remainingCalls, totalLimit

  if (user.plan === 'FREE') {
    // For free users: monthlyCallLimit is remaining calls (countdown)
    totalLimit = 3 // Free users get 3 calls per month
    remainingCalls = user.monthlyLimit || 0
    usedCalls = totalLimit - remainingCalls
  } else {
    // For paid users: apiUsage is tokens used, monthlyLimit is total tokens allowed
    totalLimit = user.monthlyLimit || 0
    usedCalls = user.apiUsage || 0
    remainingCalls = Math.max(0, totalLimit - usedCalls)
  }

  const handleSaveProfile = async () => {
    if (!profileData.name.trim()) {
      toast.error('Name is required')
      return
    }

    if (profileData.name === user.name) {
      toast.info('No changes to save')
      return
    }

    setLoading(true)
    try {
      const response = await apiClient.updateUserProfile({
        name: profileData.name.trim()
      })
      console.log('Profile update response:', response)
      if (response) {
        toast.success('Profile updated successfully!')
        // Refresh user data to get updated info
        await refreshUser()
      } else {
        toast.error(response.message || 'Failed to update profile')
      }
    } catch (error) {
      console.error('Profile update error:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleChangePassword = async () => {
    if (!passwordData.currentPassword || !passwordData.newPassword || !passwordData.confirmPassword) {
      toast.error('Please fill in all password fields')
      return
    }

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast.error('New passwords do not match')
      return
    }

    if (passwordData.newPassword.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }

    setLoading(true)
    try {
      const response = await apiClient.changePassword({
        currentPassword: passwordData.currentPassword,
        newPassword: passwordData.newPassword
      })
      if (response.success) {
        setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' })
        toast.success('Password updated successfully!')
      } else {
        toast.error(response.message || 'Failed to update password')
      }
    } catch (error: any) {
      console.error('Password update error:', error.message || error)

      toast.error(error.message || 'Failed to update password')
    } finally {
      setLoading(false)
    }
  }

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
            <h1 className="text-2xl font-bold">Profile Settings</h1>
            <p className="text-muted-foreground">Manage your account settings and preferences</p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Profile Info */}
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Personal Information</CardTitle>
                <CardDescription>Update your personal details</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Avatar className="h-20 w-20">
                      <AvatarImage src={user.avatar || "/placeholder.svg"} />
                      <AvatarFallback className="text-lg">
                        {user.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </AvatarFallback>
                    </Avatar>
                    <Button size="sm" className="absolute -bottom-2 -right-2 h-8 w-8 rounded-full p-0">
                      <Camera className="h-4 w-4" />
                    </Button>
                  </div>
                  <div>
                    <h3 className="font-semibold">{user.name}</h3>
                    <p className="text-sm text-muted-foreground">{user.email}</p>
                    <Badge
                      variant={user.plan === "Enterprise" ? "default" : user.plan === "Pro" ? "secondary" : "outline"}
                    >
                      {user.plan} Plan
                    </Badge>
                  </div>
                </div>

                <Separator />

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="name">Full Name</Label>
                    <Input
                      id="name"
                      value={profileData.name}
                      onChange={(e) => setProfileData(prev => ({ ...prev, name: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={user.email}
                      disabled
                      className="bg-muted"
                    />
                    <p className="text-xs text-muted-foreground">Email cannot be changed for security reasons</p>
                  </div>
                </div>

                <Button onClick={handleSaveProfile} disabled={loading}>
                  {loading ? 'Saving...' : 'Save Changes'}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Security</CardTitle>
                <CardDescription>Manage your account security</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="current-password">Current Password</Label>
                  <div className="relative">
                    <Input
                      id="current-password"
                      type={showPassword.current ? "text" : "password"}
                      value={passwordData.currentPassword}
                      onChange={(e) => setPasswordData(prev => ({ ...prev, currentPassword: e.target.value }))}
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                      onClick={() => setShowPassword(prev => ({ ...prev, current: !prev.current }))}
                    >
                      {showPassword.current ? (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-password">New Password</Label>
                  <div className="relative">
                    <Input
                      id="new-password"
                      type={showPassword.new ? "text" : "password"}
                      value={passwordData.newPassword}
                      onChange={(e) => setPasswordData(prev => ({ ...prev, newPassword: e.target.value }))}
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                      onClick={() => setShowPassword(prev => ({ ...prev, new: !prev.new }))}
                    >
                      {showPassword.new ? (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirm New Password</Label>
                  <div className="relative">
                    <Input
                      id="confirm-password"
                      type={showPassword.confirm ? "text" : "password"}
                      value={passwordData.confirmPassword}
                      onChange={(e) => setPasswordData(prev => ({ ...prev, confirmPassword: e.target.value }))}
                      className="pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                      onClick={() => setShowPassword(prev => ({ ...prev, confirm: !prev.confirm }))}
                    >
                      {showPassword.confirm ? (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>
                <Button onClick={handleChangePassword} disabled={loading}>
                  {loading ? 'Updating...' : 'Update Password'}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CreditCard className="h-5 w-5" />
                  Subscription
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm">Current Plan</span>
                    <Badge
                      variant={user.plan === "ENTERPRISE" ? "default" : user.plan === "PRO_MAX" ? "secondary" : "outline"}
                    >
                      {user.plan || 'FREE'}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm">Status</span>
                    <span className={`text-sm ${subscriptionData?.stripeSubscription?.status === 'active' ? 'text-green-600' :
                      subscriptionData?.status === 'active' ? 'text-green-600' :
                        'text-yellow-600'
                      }`}>
                      {subscriptionData?.stripeSubscription?.status?.toUpperCase()
                        || subscriptionData?.status?.toUpperCase()
                        || 'ACTIVE'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm">Next Billing</span>
                    <span className="text-sm">
                      {subscriptionData?.stripeSubscription?.currentPeriodEnd
                        ? new Date(subscriptionData.stripeSubscription.currentPeriodEnd).toLocaleDateString()
                        : subscriptionData?.endDate
                          ? new Date(subscriptionData.endDate).toLocaleDateString()
                          : user.plan === 'FREE' ? 'N/A' : 'Loading...'
                      }
                    </span>
                  </div>
                </div>
                <Separator className="my-4" />
                <Button className="w-full" variant="outline" onClick={() => router.push('/billing')}>
                  Manage Subscription
                </Button>
              </CardContent>
            </Card>

            {user.isAdmin && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Shield className="h-5 w-5" />
                    Admin Access
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-4">You have administrator privileges</p>
                  <Link href="/admin">
                    <Button className="w-full">Admin Panel</Button>
                  </Link>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Usage Stats</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm">{user.plan === 'FREE' ? 'API calls used' : 'Tokens used'}</span>
                    <span className="text-sm font-medium">{usedCalls.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm">{user.plan === 'FREE' ? 'Calls remaining' : 'Tokens remaining'}</span>
                    <span className="text-sm font-medium">{remainingCalls.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm">{user.plan === 'FREE' ? 'Monthly calls limit' : 'Monthly tokens limit'}</span>
                    <span className="text-sm font-medium">{totalLimit.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm">Usage percentage</span>
                    <span className="text-sm font-medium">
                      {totalLimit > 0 ? Math.round((usedCalls / totalLimit) * 100) : 0}%
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>



      </div>
    </div>
  )
}
