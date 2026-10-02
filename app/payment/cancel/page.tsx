'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { ArrowRight, Check, Loader2, ShieldCheck, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api'
import { PAID_PLAN, describeCheckoutError } from '@/lib/plans-catalog'
import styles from './payment-cancel.module.css'

const PLAN_LABELS: Record<string, string> = {
  PRO: 'Pro',
  PRO_MAX: 'Pro',
}

const REASSURANCE = [
  'Esta página no cambia tu suscripción actual.',
  'Puedes consultar el estado de tu cuenta en facturación.',
  'Si ya pagaste, verifica el cobro antes de iniciar otro pago.',
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
      router.push('/planes')
      return
    }
    try {
      setRetrying(true)
      const response = await apiClient.createStripePayment({ plan: PAID_PLAN.code })
      if (!response?.url) throw new Error('No checkout URL received')
      window.location.href = response.url
    } catch (err: any) {
      const status = err?.status ?? err?.statusCode
      if (status === 401) {
        toast.error('Tu sesión expiró — inicia sesión de nuevo.')
        router.push('/auth/login?next=%2Fplanes')
      } else {
        toast.error(describeCheckoutError(err).message)
        router.push('/planes')
      }
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className={`relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10 ${styles.shell}`}>
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-px ${styles.topRule}`} />
      <div className={`pointer-events-none absolute inset-0 ${styles.glow}`} />
      <div className={`pointer-events-none absolute inset-0 ${styles.veil}`} />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className={`relative w-full max-w-md overflow-hidden rounded-lg p-7 sm:p-8 ${styles.card}`}
      >
        <div className={`absolute inset-x-0 top-0 h-1 ${styles.cardRule}`} />

        <div className={`mb-5 inline-flex items-center gap-2 rounded-md px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${styles.planPill}`}>
          <Sparkles className="h-3.5 w-3.5" />
          SiraGPT {planLabel ?? 'Planes'}
        </div>

        <h1 className={`text-balance text-2xl font-semibold sm:text-[26px] ${styles.title}`}>
          No completaste el pago
        </h1>
        <p className={`mt-3 text-sm leading-6 ${styles.copy}`}>
          Volviste del proceso de pago. Consulta facturación si necesitas comprobar el estado de un cobro o de tu suscripción.
        </p>

        <div className={`mt-6 rounded-lg p-4 ${styles.panel}`}>
          <div className={`text-xs font-medium uppercase tracking-[0.14em] ${styles.panelLabel}`}>
            ¿Qué pasa ahora?
          </div>
          <ul className="mt-3 space-y-2.5">
            {REASSURANCE.map((item) => (
              <li key={item} className={`flex gap-2.5 text-sm leading-5 ${styles.reassuranceItem}`}>
                <Check className={`mt-0.5 h-4 w-4 shrink-0 ${styles.checkIcon}`} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-7 space-y-2.5">
          <Button
            onClick={handleRetry}
            disabled={retrying}
            className={`group h-11 w-full rounded-md ${styles.primaryButton}`}
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
            onClick={() => router.push('/agentes')}
            className={`h-11 w-full rounded-md ${styles.secondaryButton}`}
          >
            Volver al chat
          </Button>
          <button
            type="button"
            onClick={() => router.push('/')}
            className={`w-full pt-1 text-center text-xs transition-colors ${styles.homeButton}`}
          >
            Volver al inicio
          </button>
        </div>

        <div className={`mt-6 flex items-center justify-center gap-2 text-[11px] ${styles.footer}`}>
          <ShieldCheck className={`h-3.5 w-3.5 ${styles.footerIcon}`} />
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
