"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Eye, EyeOff} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { useAuth } from "@/lib/auth-context-integrated"
import { useBackendReady } from "@/lib/use-backend-ready"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
export default function RegisterPage() {
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = React.useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)
  const [formData, setFormData] = React.useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    agreeToTerms: false,
  })

  const { register, user } = useAuth()
  const router = useRouter()

  // Right after a publish the backend is still booting (~90s) while the
  // frontend is already live, so the registration request would hit a 500 and
  // show a misleading "could not create account" error. Track backend
  // readiness and queue the submit until the backend answers.
  const backendState = useBackendReady()
  const [pendingRegister, setPendingRegister] = React.useState(false)

  // Redirect if already logged in
  React.useEffect(() => {
    if (user) {
      router.push("/chat")
    }
  }, [user, router])

  const runRegister = React.useCallback(async () => {
    setIsLoading(true)

    try {
      const success = await register(formData.name, formData.email, formData.password)
      if (success) {
        toast.success("Cuenta creada con éxito")
        router.push("/chat")
      } else {
        toast.error("No se pudo crear la cuenta. Inténtalo de nuevo.")
      }
    } catch (error) {
      toast.error("No se pudo crear la cuenta. Inténtalo de nuevo.")
    } finally {
      setIsLoading(false)
    }
  }, [formData.name, formData.email, formData.password, register, router])

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault()

    if (formData.password !== formData.confirmPassword) {
      toast.error("Las contraseñas no coinciden")
      return
    }

    if (formData.password.length < 6) {
      toast.error("La contraseña debe tener al menos 6 caracteres")
      return
    }

    // Backend still warming up after a publish: queue and run once ready.
    if (backendState !== "ready") {
      setPendingRegister(true)
      return
    }

    void runRegister()
  }

  // Flush the queued registration once the backend reports ready.
  React.useEffect(() => {
    if (backendState !== "ready" || !pendingRegister) return
    setPendingRegister(false)
    void runRegister()
  }, [backendState, pendingRegister, runRegister])

  const isWarming = backendState === "warming" || (backendState !== "ready" && pendingRegister)

  const handleInputChange = (field: string, value: string | boolean) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const fieldClassName =
    "border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500 focus-visible:border-neutral-900 focus-visible:ring-neutral-900/15 dark:border-white/20 dark:bg-black dark:text-white dark:placeholder:text-zinc-500 dark:focus-visible:border-white/45 dark:focus-visible:ring-white/20"

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-4 dark:bg-black">
      <Card className="w-full max-w-md border-neutral-200 bg-white text-neutral-950 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.18)] dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-50 dark:shadow-[0_28px_70px_-18px_rgba(0,0,0,0.75)]">
        <CardHeader className="text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-200 bg-white dark:border-white/15 dark:bg-white">
              <Image
                src="/sira-gpt.png"
                alt=""
                width={40}
                height={40}
                className="rounded-lg object-contain"
              />
            </div>
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-white">
            {t("createYourAccount")}
          </CardTitle>
          <CardDescription className="text-neutral-600 dark:text-zinc-400">{t("registerTagline")}</CardDescription>
        </CardHeader>

        <CardContent>
          {isWarming && (
            <div
              role="status"
              aria-live="polite"
              data-testid="register-server-warming"
              className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <ThinkingIndicator size="sm" />
              <span>{t("serverWarming")}</span>
            </div>
          )}
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-neutral-900 dark:text-zinc-100">
                {t("name")}
              </Label>
              <Input
                id="name"
                type="text"
                autoComplete="name"
                placeholder={t("namePlaceholder")}
                value={formData.name}
                onChange={(e) => handleInputChange("name", e.target.value)}
                required
                disabled={isLoading}
                className={fieldClassName}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-neutral-900 dark:text-zinc-100">
                {t("email")}
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder={t("emailPlaceholder")}
                value={formData.email}
                onChange={(e) => handleInputChange("email", e.target.value)}
                required
                disabled={isLoading}
                className={fieldClassName}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-neutral-900 dark:text-zinc-100">
                {t("password")}
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder={t("passwordPlaceholder")}
                  value={formData.password}
                  onChange={(e) => handleInputChange("password", e.target.value)}
                  required
                  disabled={isLoading}
                  className={`${fieldClassName} pr-11`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 text-neutral-600 hover:bg-transparent hover:text-neutral-900 dark:text-zinc-400 dark:hover:text-white"
                  onClick={() => setShowPassword(!showPassword)}
                  disabled={isLoading}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className="text-neutral-900 dark:text-zinc-100">
                {t("confirmPassword")}
              </Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder={t("passwordPlaceholder")}
                  value={formData.confirmPassword}
                  onChange={(e) => handleInputChange("confirmPassword", e.target.value)}
                  required
                  disabled={isLoading}
                  className={`${fieldClassName} pr-11`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 text-neutral-600 hover:bg-transparent hover:text-neutral-900 dark:text-zinc-400 dark:hover:text-white"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  disabled={isLoading}
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="terms"
                checked={formData.agreeToTerms}
                onCheckedChange={(checked) => handleInputChange("agreeToTerms", checked as boolean)}
                disabled={isLoading}
                className="border-neutral-900 data-[state=checked]:bg-neutral-900 data-[state=checked]:text-white dark:border-white dark:data-[state=checked]:bg-white dark:data-[state=checked]:text-black"
              />
              <Label htmlFor="terms" className="text-sm text-neutral-700 dark:text-zinc-300">
                {t("agreeTerms")}
              </Label>
            </div>

            <Button
              type="submit"
              className="w-full bg-neutral-900 font-semibold text-white shadow-sm hover:bg-neutral-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              disabled={!formData.agreeToTerms || isLoading}
            >
              {isLoading ? (
                <>
                  <ThinkingIndicator size="sm" className="mr-2" />
                  {t("signingIn")}
                </>
              ) : (
                t("signUp")
              )}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="justify-center text-center">
          <p className="text-sm text-neutral-600 dark:text-zinc-400">
            {t("haveAccount")}{" "}
            <Link
              href="/auth/login"
              className="font-semibold text-neutral-900 underline decoration-neutral-900/30 underline-offset-4 transition-colors hover:decoration-neutral-900 dark:text-white dark:decoration-white/40 dark:hover:decoration-white"
            >
              {t("signIn")}
            </Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}
