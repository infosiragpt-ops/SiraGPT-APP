"use client"

import * as React from "react"
import Image from "next/image"
import { useParams, useRouter } from "next/navigation"
import { Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getNormalizedApiBaseUrl } from "@/lib/api"
import { toast } from "sonner"

// Target of the password-recovery email link (`/auth/reset/<token>` — see
// backend email service sendPasswordReset). Posts the new password to
// POST /api/auth/reset-password { token, password }.
function ResetPasswordPageContent() {
  const params = useParams<{ token: string }>()
  const router = useRouter()
  const token = String(params?.token || "")

  const [password, setPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [isLoading, setIsLoading] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) {
      setError("La contraseña debe tener al menos 8 caracteres.")
      return
    }
    setError(null)
    setIsLoading(true)
    try {
      const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      }, { bearerToken: null })
      if (res.ok) {
        setDone(true)
        toast.success("Contraseña actualizada. Ya puedes iniciar sesión.")
        return
      }
      if (res.status === 410) setError("El enlace expiró. Solicita uno nuevo desde “¿Olvidaste tu contraseña?”.")
      else if (res.status === 409) setError("Este enlace ya fue usado. Solicita uno nuevo si aún lo necesitas.")
      else if (res.status === 404) setError("El enlace no es válido. Solicita uno nuevo desde “¿Olvidaste tu contraseña?”.")
      else setError("No se pudo actualizar la contraseña. Inténtalo de nuevo.")
    } catch {
      setError("No se pudo actualizar la contraseña. Inténtalo de nuevo.")
    } finally {
      setIsLoading(false)
    }
  }

  const fieldClassName =
    "border-neutral-300 bg-white text-neutral-900 placeholder:text-neutral-500 focus-visible:border-neutral-900 focus-visible:ring-neutral-900/15"

  return (
    <div className="flex min-h-[100svh] bg-neutral-50 text-neutral-950 sm:min-h-screen" style={{ colorScheme: "light" }}>
      <main className="flex w-full flex-col items-center justify-center overflow-y-auto px-4 py-6 sm:py-10">
        <Card
          data-testid="reset-password-card"
          className="w-full max-w-md border-neutral-200 bg-white text-neutral-950 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.18)]"
        >
          <CardHeader className="px-6 pt-7 text-center sm:px-8 sm:pt-8">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-200 bg-white">
              <Image src="/sira-gpt.png" alt="" width={40} height={40} className="rounded-lg object-contain" />
            </div>
            <CardTitle className="text-2xl font-semibold tracking-tight text-neutral-900">
              Nueva contraseña
            </CardTitle>
            <CardDescription className="text-neutral-600">
              Elige una contraseña nueva para tu cuenta.
            </CardDescription>
          </CardHeader>

          <CardContent>
            {done ? (
              <div className="space-y-4 text-center">
                <p className="text-sm text-neutral-700">
                  Tu contraseña quedó actualizada.
                </p>
                <Button
                  type="button"
                  className="w-full bg-neutral-900 font-semibold text-white shadow-sm hover:bg-neutral-800"
                  onClick={() => router.push("/auth/login")}
                >
                  Iniciar sesión
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} noValidate className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="new-password" className="text-neutral-900">
                    Nueva contraseña
                  </Label>
                  <div className="relative">
                    <Input
                      id="new-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="Mínimo 8 caracteres"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); if (error) setError(null) }}
                      required
                      minLength={8}
                      disabled={isLoading}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? "reset-error" : undefined}
                      className={`${fieldClassName} pr-10${error ? " border-red-400" : ""}`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-neutral-500 hover:text-neutral-800"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {error && (
                    <p id="reset-error" role="alert" className="text-sm text-red-600">
                      {error}
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
                      Guardando…
                    </>
                  ) : (
                    "Guardar contraseña"
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
