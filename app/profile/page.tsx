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
import { Progress } from "@/components/ui/progress"
import {
  ArrowLeft, Camera, CreditCard, Shield, Eye, EyeOff,
  User as UserIcon, Lock, Crown, Sparkles, CheckCircle2,
  AlertCircle, Zap, Activity, Calendar, Mail, KeyRound,
} from "lucide-react"
import Link from "next/link"
import { toast } from 'sonner'
import { apiClient } from '@/lib/api'
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export default function ProfilePage() {
  return (
    <AuthGuard>
      <ProfileContent />
    </AuthGuard>
  )
}

// Plan visual identity — keeps the page consistent with the rest of the
// product's ENTERPRISE > PRO_MAX > PRO > FREE tier hierarchy without
// hard-coding colors per location.
const PLAN_META: Record<string, { label: string; icon: typeof Crown; accent: string; ring: string; chip: string }> = {
  ENTERPRISE: { label: 'Enterprise', icon: Crown,     accent: 'from-amber-500/20 to-orange-500/10', ring: 'ring-amber-500/30',  chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20' },
  PRO_MAX:    { label: 'Pro Max',    icon: Sparkles,  accent: 'from-violet-500/20 to-fuchsia-500/10', ring: 'ring-violet-500/30', chip: 'bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20' },
  PRO:        { label: 'Pro',        icon: Zap,       accent: 'from-blue-500/20 to-sky-500/10',     ring: 'ring-blue-500/30',   chip: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20' },
  FREE:       { label: 'Free',       icon: UserIcon,  accent: 'from-zinc-500/10 to-zinc-500/5',     ring: 'ring-zinc-500/20',   chip: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 border-zinc-500/20' },
}

function ProfileContent() {
  const t = useTranslations("profile")
  const tc = useTranslations("common")
  const tset = useTranslations("settings")
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
      setSubscriptionData({
        plan: user?.plan || 'FREE',
        status: 'active',
        endDate: null
      })
    }
  }

  if (!user) return null

  // Usage math — FREE users track calls remaining (count-down), paid
  // users track tokens used against a monthly quota.
  let usedCalls: number, remainingCalls: number, totalLimit: number
  if (user.plan === 'FREE') {
    totalLimit = 3
    remainingCalls = Number(user.monthlyLimit ?? 0)
    usedCalls = Math.max(0, totalLimit - remainingCalls)
  } else {
    totalLimit = Number(user.monthlyLimit ?? 0)
    usedCalls = Number(user.apiUsage ?? 0)
    remainingCalls = Math.max(0, totalLimit - usedCalls)
  }
  const usagePct = totalLimit > 0 ? Math.min(100, Math.round((usedCalls / totalLimit) * 100)) : 0
  const usageTone = usagePct >= 90 ? 'danger' : usagePct >= 70 ? 'warn' : 'ok'

  const plan = PLAN_META[user.plan || 'FREE'] || PLAN_META.FREE
  const PlanIcon = plan.icon

  const statusLabel = (subscriptionData?.stripeSubscription?.status
    || subscriptionData?.status
    || 'active').toString().toUpperCase()
  const statusActive = statusLabel === 'ACTIVE'

  const nextBilling = subscriptionData?.stripeSubscription?.currentPeriodEnd
    ? new Date(subscriptionData.stripeSubscription.currentPeriodEnd).toLocaleDateString()
    : subscriptionData?.endDate
      ? new Date(subscriptionData.endDate).toLocaleDateString()
      : user.plan === 'FREE' ? '—' : 'Loading…'

  const initials = (user.name || user.email || 'U')
    .split(/\s+/)
    .filter(Boolean)
    .map(s => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  const handleSaveProfile = async () => {
    if (!profileData.name.trim()) {
      toast.error('El nombre es obligatorio')
      return
    }
    if (profileData.name === user.name) {
      toast.info('No hay cambios por guardar')
      return
    }
    setLoading(true)
    try {
      const response = await apiClient.updateUserProfile({ name: profileData.name.trim() })
      if (response) {
        toast.success('Perfil actualizado')
        await refreshUser()
      } else {
        toast.error('No se pudo actualizar el perfil')
      }
    } catch (error) {
      console.error('Profile update error:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleChangePassword = async () => {
    if (!passwordData.currentPassword || !passwordData.newPassword || !passwordData.confirmPassword) {
      toast.error('Completa todos los campos de contraseña')
      return
    }
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast.error('Las contraseñas no coinciden')
      return
    }
    if (passwordData.newPassword.length < 8) {
      toast.error('La contraseña debe tener al menos 8 caracteres')
      return
    }
    setLoading(true)
    try {
      const response = await apiClient.changePassword({
        currentPassword: passwordData.currentPassword,
        newPassword: passwordData.newPassword,
      })
      if (response.success) {
        setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' })
        toast.success('Contraseña actualizada')
      } else {
        toast.error(response.message || 'No se pudo actualizar la contraseña')
      }
    } catch (error: any) {
      console.error('Password update error:', error?.message || error)
      toast.error(error?.message || 'No se pudo actualizar la contraseña')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/30">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        {/* Top nav */}
        <div className="flex items-center justify-between">
          <Link href="/chat">
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              {tset("backToChat")}
            </Button>
          </Link>
          <div className="text-xs text-muted-foreground hidden sm:flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {t("synced")}
          </div>
        </div>

        {/* Hero card — plan-tinted gradient + avatar with plan-coloured ring */}
        <div className={cn(
          "relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 sm:p-8",
          plan.accent,
        )}>
          <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" aria-hidden />
          <div className="relative flex flex-col sm:flex-row items-start sm:items-center gap-6">
            <div className="relative">
              <Avatar className={cn("h-24 w-24 ring-4 ring-offset-2 ring-offset-background", plan.ring)}>
                <AvatarImage src={user.avatar || undefined} />
                <AvatarFallback className="text-2xl font-semibold bg-background">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <button
                type="button"
                title="Cambiar foto"
                aria-label="Cambiar foto"
                className="absolute -bottom-1 -right-1 h-8 w-8 rounded-full bg-foreground text-background grid place-items-center shadow-lg hover:scale-105 transition-transform"
              >
                <Camera className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{user.name}</h1>
                <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium", plan.chip)}>
                  <PlanIcon className="h-3 w-3" />
                  {plan.label}
                </span>
                {user.isAdmin && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/20 bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-700 dark:text-rose-400">
                    <Shield className="h-3 w-3" />
                    Admin
                  </span>
                )}
              </div>
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Mail className="h-3.5 w-3.5" />
                {user.email}
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                {t("subtitle")}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Main column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Personal information */}
            <Card className="border-border/60 shadow-sm">
              <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary grid place-items-center shrink-0">
                  <UserIcon className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>{t("personalInfo.title")}</CardTitle>
                  <CardDescription>{t("personalInfo.desc")}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="name">{t("fullName")}</Label>
                    <Input
                      id="name"
                      value={profileData.name}
                      onChange={(e) => setProfileData(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="Tu nombre"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email" className="flex items-center gap-1.5">
                      Email
                      <Lock className="h-3 w-3 text-muted-foreground" />
                    </Label>
                    <Input id="email" type="email" value={user.email} disabled className="bg-muted/50" />
                    <p className="text-xs text-muted-foreground">El email no se puede modificar por seguridad.</p>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
                  <Button variant="ghost" onClick={() => setProfileData({ name: user.name })} disabled={loading || profileData.name === user.name}>
                    Descartar
                  </Button>
                  <Button onClick={handleSaveProfile} disabled={loading || profileData.name === user.name}>
                    {loading ? t("saving") : t("save")}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Security */}
            <Card className="border-border/60 shadow-sm">
              <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                <div className="h-10 w-10 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 grid place-items-center shrink-0">
                  <KeyRound className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>Seguridad</CardTitle>
                  <CardDescription>Actualiza tu contraseña periódicamente</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <PasswordField
                  id="current-password"
                  label="Contraseña actual"
                  value={passwordData.currentPassword}
                  onChange={(v) => setPasswordData(prev => ({ ...prev, currentPassword: v }))}
                  visible={showPassword.current}
                  onToggle={() => setShowPassword(prev => ({ ...prev, current: !prev.current }))}
                />
                <div className="grid gap-4 md:grid-cols-2">
                  <PasswordField
                    id="new-password"
                    label="Nueva contraseña"
                    value={passwordData.newPassword}
                    onChange={(v) => setPasswordData(prev => ({ ...prev, newPassword: v }))}
                    visible={showPassword.new}
                    onToggle={() => setShowPassword(prev => ({ ...prev, new: !prev.new }))}
                    hint="Mínimo 8 caracteres"
                  />
                  <PasswordField
                    id="confirm-password"
                    label="Confirmar contraseña"
                    value={passwordData.confirmPassword}
                    onChange={(v) => setPasswordData(prev => ({ ...prev, confirmPassword: v }))}
                    visible={showPassword.confirm}
                    onToggle={() => setShowPassword(prev => ({ ...prev, confirm: !prev.confirm }))}
                  />
                </div>
                <div className="flex items-center justify-end pt-2 border-t border-border/60">
                  <Button onClick={handleChangePassword} disabled={loading}>
                    {loading ? 'Actualizando…' : 'Actualizar contraseña'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Sidebar column */}
          <div className="space-y-6">
            {/* Subscription */}
            <Card className="border-border/60 shadow-sm overflow-hidden">
              <CardHeader className="flex flex-row items-start gap-3 space-y-0 pb-4">
                <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary grid place-items-center shrink-0">
                  <CreditCard className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <CardTitle>Suscripción</CardTitle>
                  <CardDescription>Plan y facturación</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className={cn("rounded-lg border p-4 bg-gradient-to-br", plan.accent)}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <PlanIcon className="h-5 w-5" />
                      <span className="font-semibold">{plan.label}</span>
                    </div>
                    <span className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                      statusActive ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                    )}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", statusActive ? "bg-emerald-500" : "bg-amber-500")} />
                      {statusLabel}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Calendar className="h-3 w-3" />
                    Próxima facturación: <span className="font-medium text-foreground">{nextBilling}</span>
                  </div>
                </div>

                <Button className="w-full" variant="outline" onClick={() => router.push('/billing')}>
                  Gestionar suscripción
                </Button>
              </CardContent>
            </Card>

            {/* Usage stats */}
            <Card className="border-border/60 shadow-sm">
              <CardHeader className="flex flex-row items-start gap-3 space-y-0 pb-4">
                <div className="h-10 w-10 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 grid place-items-center shrink-0">
                  <Activity className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>Uso mensual</CardTitle>
                  <CardDescription>{user.plan === 'FREE' ? 'Llamadas consumidas' : 'Tokens consumidos'}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-3xl font-bold tracking-tight tabular-nums">{usedCalls.toLocaleString()}</span>
                    <span className="text-sm text-muted-foreground">
                      / {totalLimit.toLocaleString()} {user.plan === 'FREE' ? 'llamadas' : 'tokens'}
                    </span>
                  </div>
                  <Progress
                    value={usagePct}
                    className={cn(
                      "h-2",
                      usageTone === 'danger' && "[&>div]:bg-rose-500",
                      usageTone === 'warn' && "[&>div]:bg-amber-500",
                      usageTone === 'ok' && "[&>div]:bg-emerald-500",
                    )}
                  />
                  <div className="mt-1.5 flex justify-between text-xs text-muted-foreground tabular-nums">
                    <span>{usagePct}% usado</span>
                    <span>{remainingCalls.toLocaleString()} restantes</span>
                  </div>
                </div>

                {usageTone !== 'ok' && (
                  <div className={cn(
                    "flex items-start gap-2 rounded-md border p-3 text-xs",
                    usageTone === 'danger' ? "border-rose-500/20 bg-rose-500/5 text-rose-700 dark:text-rose-400" : "border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400",
                  )}>
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      {usageTone === 'danger'
                        ? 'Te queda muy poco cupo este mes. Considera actualizar tu plan para no interrumpir tu flujo.'
                        : 'Ya superaste el 70% de tu cupo mensual.'}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Admin access */}
            {user.isAdmin && (
              <Card className="border-rose-500/20 bg-rose-500/5 shadow-sm">
                <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                  <div className="h-10 w-10 rounded-lg bg-rose-500/15 text-rose-600 dark:text-rose-400 grid place-items-center shrink-0">
                    <Shield className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>Acceso de administrador</CardTitle>
                    <CardDescription className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      Privilegios activos
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <Link href="/admin">
                    <Button className="w-full" variant="default">
                      Abrir panel de admin
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function PasswordField({ id, label, value, onChange, visible, onToggle, hint }: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  visible: boolean
  onToggle: () => void
  hint?: string
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent text-muted-foreground"
          onClick={onToggle}
          aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
