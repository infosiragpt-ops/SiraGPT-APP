"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { ArrowLeft, Eye, EyeOff, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getNormalizedApiBaseUrl } from "@/lib/api"
import { useBackendReady } from "@/lib/use-backend-ready"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

function ResetPasswordPageContent() {
  const t = useTranslations("auth")
  const searchParams = useSearchParams()
  const token = searchParams.get("token") || ""

  const [password, setPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const [tokenError, setTokenError] = React.useState<string | null>(null)
  const [passwordError, setPasswordError] = React.useState<string | null>(null)
  const [confirmError, setConfirmError] = React.useState<string | null>(null)

  const backendState = useBackendReady()

  React.useEffect(() => {
    if (!token) setTokenError(t("resetTokenMissing"))
  }, [token, t])

  const validateForm = React.useCallback(() => {
    let ok = true
    if (password.length < 6) {
      setPasswordError(t("passwordTooShort"))
      ok = false
    } else {
      setPasswordError(null)
    }
    if (confirmPassword !== password) {
      setConfirmError(t("passwordsNoMatch"))
      ok = false
    } else {
      setConfirmError(null)
    }
    return ok
  }, [password, confirmPassword, t])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) {
      toast.error(t("resetTokenMissing"))
      return
    }
    if (!validateForm()) return
    if (backendState === "warming") return

    setIsLoading(true)
    try {
      const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      }, { bearerToken: null })
      if (res.ok) {
        setDone(true)
        toast.success(t("passwordResetSuccess"))
      } else {
        const data = await res.json().catch(() => ({}))
        if (res.status === 404) toast.error(t("resetTokenNotFound"))
        else if (res.status === 410) toast.error(t("resetTokenExpired"))
        else if (res.status === 409) toast.error(t("resetTokenUsed"))
        else toast.error(data?.error || t("resetFailed"))
      }
    } catch {
      toast.error(t("resetFailed"))
    } finally {
      setIsLoading(false)
    }
  }

  const handleBack = () => {
    window.location.href = "/auth/login"
  }

  const fieldClassName =
    "border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500 focus-visible:border-neutral-900 focus-visible:ring-neutral-900/15"

  return (
    <div className="flex min-h-[100svh] bg-neutral-50 text-neutral-950 sm:min-h-screen" style={{ colorScheme: "light" }}>
      <aside
        className="relative hidden w-[45%] flex-col justify-between overflow-hidden p-12 text-white lg:flex xl:p-14"
        style={{ backgroundColor: "#0a0a0a", colorScheme: "dark" }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(55% 45% at 12% 12%, rgba(124,58,237,0.28), transparent 70%), radial-gradient(50% 45% at 100% 100%, rgba(79,70,229,0.20), transparent 70%)",
          }}
        />
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
            <Image src="/sira-gpt.png" alt="" width={28} height={28} className="rounded-md object-contain" />
          </div>
          <span className="text-lg font-semibold tracking-tight">SiraGPT</span>
        </div>
        <div className="relative">
          <h2 className="max-w-md text-4xl font-semibold leading-[1.15] tracking-tight">
            {t("resetPasswordTitle")}
          </h2>
        </div>
        <div className="relative text-sm text-white/50">{t("brandFooter")}</div>
      </aside>

      <main className="flex w-full flex-col items-center justify-center overflow-y-auto px-4 py-6 sm:py-10 lg:w-[55%]">
        <Card className="w-full max-w-md border-neutral-200 bg-white text-neutral-950 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.18)]">
          <CardHeader className="px-6 pt-7 text-center sm:px-8 sm:pt-8">
            <div className="mb-5 grid grid-cols-[1fr_auto_1fr] items-center">
              <Button
                type="button"
                variant="ghost"
                onClick={handleBack}
                className="h-9 w-fit gap-1.5 justify-self-start rounded-full border border-neutral-200 bg-white/90 px-3 text-sm font-medium text-neutral-700 shadow-sm backdrop-blur transition hover:bg-neutral-50 hover:text-neutral-950"
                aria-label="Volver atras"
              >
                <ArrowLeft className="h-4 w-4" />
                {t("back")}
              </Button>
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-200 bg-white">
                <Image src="/sira-gpt.png" alt="" width={40} height={40} className="rounded-lg object-contain" />
              </div>
              <div aria-hidden="true" />
            </div>
            <CardTitle className="text-2xl font-semibold tracking-tight text-neutral-900">
              {t("resetPassword")}
            </CardTitle>
            <CardDescription className="text-neutral-600">{t("resetPasswordSubtitle")}</CardDescription>
          </CardHeader>

          <CardContent>
            {done ? (
              <div className="flex flex-col items-center gap-4 py-6 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-50 ring-1 ring-green-200">
                  <Check className="h-7 w-7 text-green-600" />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-neutral-900">{t("passwordResetSuccess")}</p>
                  <p className="text-sm text-neutral-600">{t("passwordResetSuccessDescription")}</p>
                </div>
                <Button
                  type="button"
                  onClick={() => { window.location.href = "/auth/login" }}
                  className="bg-neutral-900 font-semibold text-white shadow-sm hover:bg-neutral-800"
                >
                  {t("backToLogin")}
                </Button>
              </div>
            ) : tokenError ? (
              <div className="flex flex-col items-center gap-4 py-6 text-center">
                <p className="text-sm text-red-600">{tokenError}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { window.location.href = "/auth/forgot-password" }}
                  className="border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100"
                >
                  {t("requestNewResetLink")}
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} noValidate className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-neutral-900">
                    {t("password")}
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder={t("passwordPlaceholder")}
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); if (passwordError) setPasswordError(null) }}
                      required
                      disabled={isLoading}
                      aria-invalid={passwordError ? true : undefined}
                      aria-describedby={passwordError ? "password-error" : undefined}
                      className={`${fieldClassName} pr-11${passwordError ? " border-red-400" : ""}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 py-2 text-neutral-600 hover:bg-transparent hover:text-neutral-900"
                      onClick={() => setShowPassword(!showPassword)}
                      disabled={isLoading}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                  {passwordError ? (
                    <p id="password-error" role="alert" className="text-sm text-red-600">
                      {passwordError}
                    </p>
                  ) : (
                    <p className="text-xs text-neutral-500">{t("passwordMinHint")}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword" className="text-neutral-900">
                    {t("confirmPassword")}
                  </Label>
                  <Input
                    id="confirmPassword"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder={t("passwordPlaceholder")}
                    value={confirmPassword}
                    onChange={(e) => { setConfirmPassword(e.target.value); if (confirmError) setConfirmError(null) }}
                    required
                    disabled={isLoading}
                    aria-invalid={confirmError ? true : undefined}
                    aria-describedby={confirmError ? "confirm-error" : undefined}
                    className={`${fieldClassName}${confirmError ? " border-red-400" : ""}`}
                  />
                  {confirmError && (
                    <p id="confirm-error" role="alert" className="text-sm text-red-600">
                      {confirmError}
                    </p>
                  )}
                </div>

                <Button
                  type="submit"
                  className="w-full bg-neutral-900 font-semibold text-white shadow-sm hover:bg-neutral-800"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <ThinkingIndicator size="sm" className="mr-2" />
                      {t("resetting")}
                    </>
                  ) : (
                    t("resetPassword")
                  )}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <React.Suspense fallback={null}>
      <ResetPasswordPageContent />
    </React.Suspense>
  )
}
