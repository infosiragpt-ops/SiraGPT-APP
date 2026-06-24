'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowRight, Check, Loader2, ShieldCheck, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api'

const PLAN_LABELS: Record<string, string> = {
  PRO: 'Pro',
  PRO_MAX: 'Pro Extendido',
}

const REASSURANCE = [
  'Tu cuenta sigue en el plan gratuito.',
  'Conservas todas las funciones gratis.',
  'Puedes mejorar de plan en segundos, sin permanencia.',
]

function PaymentCancelContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const planParam = (searchParams.get('plan') || '').toUpperCase()
  const plan = planParam === 'PRO' || planParam === 'PRO_MAX' ? planParam : null
  const planLabel = plan ? PLAN_LABELS[plan] : null
  const [retrying, setRetrying] = useState(false)

  // Si sabemos qué plan intentaba comprar, lo devolvemos directo al checkout de
  // Stripe en vez de dejarlo en un callejón sin salida. Si no, a los planes.
  const handleRetry = async () => {
    if (!plan) {
      router.push('/chat')
      return
    }
    try {
      setRetrying(true)
      const response = await apiClient.createStripePayment({ plan })
      if (!response?.url) throw new Error('No checkout URL received')
      window.location.href = response.url
    } catch (err: any) {
      const status = err?.status ?? err?.statusCode
      if (status === 401) {
        toast.error('Tu sesión expiró — inicia sesión de nuevo.')
        router.push('/auth/login')
      } else {
        toast.error('No pudimos reabrir el pago. Vuelve a intentarlo desde la app.')
        router.push('/chat')
      }
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* Glow violeta de marca (futurista, en vez de la alarma roja/naranja) */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(124,58,237,0.12),transparent_45%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(124,58,237,0.06),transparent_42%)]" />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="relative w-full max-w-md rounded-[28px] border border-border/70 bg-card/80 p-7 shadow-2xl shadow-foreground/5 backdrop-blur sm:p-8"
      >
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-violet-600 dark:text-violet-300">
          <Sparkles className="h-3.5 w-3.5" />
          SiraGPT Pro
        </div>

        <h1 className="text-balance text-2xl font-semibold tracking-[-0.035em] text-foreground sm:text-[26px]">
          No completaste el pago
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Cancelaste el proceso y{' '}
          <span className="font-medium text-foreground">no se realizó ningún cargo</span>.{' '}
          Tu cuenta sigue en el plan gratuito — puedes mejorar cuando quieras.
        </p>

        <div className="mt-6 rounded-2xl border border-border/60 bg-muted/20 p-4">
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            ¿Qué pasa ahora?
          </div>
          <ul className="mt-3 space-y-2.5">
            {REASSURANCE.map((item) => (
              <li key={item} className="flex gap-2.5 text-sm leading-5 text-muted-foreground">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-7 space-y-2.5">
          <Button
            onClick={handleRetry}
            disabled={retrying}
            className="group h-11 w-full rounded-full bg-foreground text-background hover:bg-foreground/90 hover:text-background"
          >
            {retrying ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Abriendo pago…
              </>
            ) : (
              <>
                {planLabel ? `Reintentar con ${planLabel}` : 'Ver planes'}
                <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => router.push('/chat')}
            className="h-11 w-full rounded-full"
          >
            Seguir en el plan gratis
          </Button>
          <button
            type="button"
            onClick={() => router.push('/')}
            className="w-full pt-1 text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Volver al inicio
          </button>
        </div>

        <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          Pago seguro con Stripe · Cancela cuando quieras
        </div>
      </motion.div>
    </div>
  )
}

export default function PaymentCancelPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <PaymentCancelContent />
    </Suspense>
  )
}
