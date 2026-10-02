export interface PaymentSessionInfo {
  sessionId: string
  paymentStatus: string
  status: string
  plan: string
  amount: number | string
}

export interface SubscriptionInfo {
  plan?: string
  status?: string | null
  endDate?: string | null
  stripeCustomerId?: string | null
  stripeSubscription?: {
    status?: string | null
    currentPeriodEnd?: string | null
    cancelAtPeriodEnd?: boolean
    nextInvoiceDate?: string | null
  } | null
}

/** A successful HTTP request is not proof that Checkout was paid. */
export function paymentIsConfirmed(payment: PaymentSessionInfo, sessionId: string): boolean {
  return payment?.sessionId === sessionId
    && payment.paymentStatus === 'COMPLETED'
    && ['paid', 'no_payment_required', 'demo_paid'].includes(payment.status)
}

function validDate(value?: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null
}

export function subscriptionView(info: SubscriptionInfo | null) {
  const status = info?.stripeSubscription?.status || info?.status || null
  const currentPeriodEnd = validDate(info?.stripeSubscription?.currentPeriodEnd) || validDate(info?.endDate)
  const cancelAtPeriodEnd = info?.stripeSubscription?.cancelAtPeriodEnd ?? status === 'canceling'
  return { status, currentPeriodEnd, cancelAtPeriodEnd, hasCustomer: Boolean(info?.stripeCustomerId) }
}

export function subscriptionIsActive(info: SubscriptionInfo | null, plan: string): boolean {
  if (!info || info.plan !== plan) return false
  const view = subscriptionView(info)
  if (!['active', 'trialing', 'canceling'].includes(view.status || '')) return false
  if (view.cancelAtPeriodEnd || view.status === 'canceling') {
    return Boolean(view.currentPeriodEnd && Date.parse(view.currentPeriodEnd) > Date.now())
  }
  return true
}

export function subscriptionStatusLabel(status: string | null, cancelAtPeriodEnd = false): string {
  if (cancelAtPeriodEnd) return 'Cancelación programada'
  return ({
    active: 'Activa', trialing: 'En prueba', canceling: 'Cancelación programada',
    canceled: 'Cancelada', past_due: 'Pago pendiente', unpaid: 'Pago pendiente',
    incomplete: 'Pendiente de activación', incomplete_expired: 'Activación vencida', paused: 'Pausada',
  } as Record<string, string>)[status || ''] || 'Sin confirmar'
}
