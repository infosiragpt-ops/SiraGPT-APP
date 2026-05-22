"use client"

import * as React from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Eye, EyeOff} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { useAuth } from "@/lib/auth-context-integrated"
import { getNormalizedApiBaseUrl } from "@/lib/api"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
export default function LoginPage() {
  const t = useTranslations("auth")
  const [showPassword, setShowPassword] = React.useState(false)
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(false)

  const { login, user } = useAuth()
  const router = useRouter()

  // Surface the `?error=…` query the auth/callback page may pass on
  // a failed OAuth round-trip ("La sesión es inválida o expiró",
  // "Error de autenticación", etc.) so the user gets a clear toast
  // explaining why they're back on the login form instead of /chat.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const errorMsg = params.get("error")
    if (errorMsg) {
      toast.error(errorMsg)
      // Clean the URL so a refresh doesn't re-toast the same error
      params.delete("error")
      const cleaned = params.toString()
      const target = window.location.pathname + (cleaned ? `?${cleaned}` : "")
      window.history.replaceState(null, "", target)
    }
  }, [])

  const handleBack = () => {
    if (window.history.length > 1) {
      router.back()
      return
    }

    router.push("/auth")
  }

  // Redirect if already logged in
  React.useEffect(() => {
    if (user) {
      router.push("/chat")
    }
  }, [user, router])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      const success = await login(email, password)
      if (success) {
        toast.success(t("signIn"))
        // Explicit redirect — don't rely solely on the useEffect that
        // watches `user`. In dev mode, state updates can race with the
        // setIsLoading(false) and leave the user stuck on the login
        // screen even though the auth context has the user. A direct
        // push guarantees navigation immediately after a successful
        // login, regardless of when the AuthContext re-renders.
        router.push("/chat")
      } else {
        toast.error(t("invalidCreds"))
      }
    } catch (error) {
      toast.error(t("invalidCreds"))
    } finally {
      setIsLoading(false)
    }
  }

  const fieldClassName =
    "border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500 focus-visible:border-neutral-900 focus-visible:ring-neutral-900/15"

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-neutral-50 p-4 text-neutral-950" style={{ colorScheme: "light" }}>
      <Button
        type="button"
        variant="ghost"
        onClick={handleBack}
        className="absolute left-4 top-4 h-10 gap-2 rounded-full border border-neutral-200 bg-white/90 px-4 text-sm font-medium text-neutral-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-neutral-950 sm:left-6 sm:top-6"
        aria-label="Volver atras"
      >
        <ArrowLeft className="h-4 w-4" />
        Volver
      </Button>
      <Card className="w-full max-w-md border-neutral-200 bg-white text-neutral-950 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.18)]">
        <CardHeader className="text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-200 bg-white">
              <Image
                src="/sira-gpt.png"
                alt=""
                width={40}
                height={40}
                className="rounded-lg object-contain"
              />
            </div>
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight text-neutral-900">
            {t("welcomeBack")}
          </CardTitle>
          <CardDescription className="text-neutral-600">{t("tagline")}</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-neutral-900">
                {t("email")}
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
                className={fieldClassName}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-neutral-900">
                {t("password")}
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder={t("passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  className={`${fieldClassName} pr-11`}
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
            </div>

            <div className="flex items-center justify-between">
              <Link
                href="/auth/forgot-password"
                className="text-sm text-neutral-600 underline-offset-4 hover:text-neutral-900 hover:underline"
              >
                {t("forgotPassword")}
              </Link>
            </div>

            <Button
              type="submit"
              className="w-full bg-neutral-900 font-semibold text-white shadow-sm hover:bg-neutral-800"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <ThinkingIndicator size="sm" className="mr-2" />
                  {t("signingIn")}
                </>
              ) : (
                t("signIn")
              )}
            </Button>
          </form>

          <div className="mt-6">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <Separator className="w-full" />
              </div>
              <div className="relative flex justify-center text-xs uppercase tracking-wider">
                <span className="bg-white px-2 text-neutral-500">
                  {t("orContinueWith")}
                </span>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3">
              <Button
                variant="outline"
                disabled={isLoading}
                onClick={() => (window.location.href = `${getNormalizedApiBaseUrl()}/auth/google`)}
                className="w-full border-neutral-300 bg-white font-medium text-neutral-900 hover:bg-neutral-100"
              >

                <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                {t("continueWithGoogle")}
              </Button>

            </div>
          </div>
        </CardContent>

        <CardFooter className="justify-center text-center">
          <p className="text-sm text-neutral-600">
            {t("noAccount")}{" "}
            <Link
              href="/auth/register"
              className="font-semibold text-neutral-900 underline decoration-neutral-900/30 underline-offset-4 transition-colors hover:decoration-neutral-900"
            >
              {t("signUp")}
            </Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}
