import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), push: vi.fn(), refreshUser: vi.fn(), search: new URLSearchParams(),
  verify: vi.fn(), subscription: vi.fn(), checkout: vi.fn(), portal: vi.fn(),
  cancel: vi.fn(), reactivate: vi.fn(), authenticatedFetch: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(), config: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => mocks.search }))
vi.mock('@/lib/auth-context-integrated', () => ({ useAuth: mocks.auth }))
vi.mock('@/lib/api', () => ({ apiClient: {
  verifyPaymentSession: mocks.verify, getSubscriptionInfo: mocks.subscription,
  createStripePayment: mocks.checkout, createBillingPortal: mocks.portal,
  cancelSubscription: mocks.cancel, reactivateSubscription: mocks.reactivate,
} }))
vi.mock('@/lib/authenticated-fetch', () => ({ authenticatedFetch: mocks.authenticatedFetch }))
vi.mock('@/lib/plans-service', () => ({ getPaymentsConfig: mocks.config }))
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))
vi.mock('@/components/analytics-dashboard', () => ({ default: () => null }))
vi.mock('@/components/plan-change-manager', () => ({ default: () => null }))

import PaymentSuccessPage from '@/app/payment/success/page'
import PaymentCancelPage from '@/app/payment/cancel/page'
import SubscriptionManager from '@/components/subscription-manager'
import PlanesPage from '@/app/planes/page'

const user = { id: 'user-1', plan: 'PRO_MAX', monthlyLimit: 100, apiUsage: 2 }
const paid = { sessionId: 'cs_example', paymentStatus: 'COMPLETED', status: 'paid', plan: 'PRO_MAX', amount: 10 }
const subscription = {
  plan: 'PRO_MAX', status: 'active', stripeCustomerId: 'cus_example',
  stripeSubscription: { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: '2030-10-01T00:00:00Z' },
}
function setAuth(overrides = {}) {
  mocks.auth.mockReturnValue({ user, isLoading: false, refreshUser: mocks.refreshUser, ...overrides })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.search = new URLSearchParams('session_id=cs_example')
  setAuth()
  mocks.refreshUser.mockResolvedValue(undefined)
  mocks.config.mockResolvedValue({ whatsappNumber: null, checkoutAvailable: true })
  mocks.verify.mockResolvedValue(paid)
  mocks.subscription.mockResolvedValue(subscription)
  mocks.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => subscription })
})
afterEach(cleanup)

describe('payment return confirmation', () => {
  it('does not confirm an unpaid session returned with HTTP success', async () => {
    mocks.verify.mockResolvedValue({ ...paid, status: 'unpaid', paymentStatus: 'PENDING' })
    render(<PaymentSuccessPage />)
    expect(await screen.findByText('Pago pendiente de confirmación')).toBeInTheDocument()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.refreshUser).not.toHaveBeenCalled()
    expect(screen.queryByText(/se activó correctamente/)).not.toBeInTheDocument()
  })
  it('waits for auth hydration before verification and refreshes the account after payment', async () => {
    setAuth({ user: null, isLoading: true })
    const page = render(<PaymentSuccessPage />)
    expect(mocks.verify).not.toHaveBeenCalled()
    setAuth()
    page.rerender(<PaymentSuccessPage />)
    expect(await screen.findByRole('heading', { name: 'Pago confirmado' })).toBeInTheDocument()
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith('cs_example')
    expect(mocks.refreshUser).toHaveBeenCalledOnce()
  })
  it('keeps the session in the login return path and does not verify without a user', async () => {
    setAuth({ user: null })
    render(<PaymentSuccessPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar sesión' }))
    expect(mocks.push).toHaveBeenCalledWith('/auth/login?next=%2Fpayment%2Fsuccess%3Fsession_id%3Dcs_example')
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it('offers a manual verification retry without claiming no charge or creating another checkout', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('Network unavailable'))
    render(<PaymentSuccessPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Volver a verificar' }))
    expect(await screen.findByRole('heading', { name: 'Pago confirmado' })).toBeInTheDocument()
    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(mocks.checkout).not.toHaveBeenCalled()
    expect(screen.queryByText(/no se realizó ningún cargo/i)).not.toBeInTheDocument()
  })
  it('does not claim an old paid session reactivated an ended subscription', async () => {
    mocks.subscription.mockResolvedValue({ plan: 'FREE', status: 'canceled' })
    render(<PaymentSuccessPage />)
    expect(await screen.findByRole('heading', { name: 'Pago confirmado' })).toBeInTheDocument()
    expect(screen.queryByText(/se activó correctamente/)).not.toBeInTheDocument()
    expect(screen.getByText(/Consulta en facturación el estado actual/)).toBeInTheDocument()
  })
  it.each(['REFUNDED', 'FAILED', 'CANCELLED'])('does not confirm a %s payment', async paymentStatus => {
    mocks.verify.mockResolvedValue({ ...paid, paymentStatus })
    render(<PaymentSuccessPage />)
    expect(await screen.findByText('No pudimos confirmar el pago')).toBeInTheDocument()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
  it('retains the confirmation reference when verification returns 401', async () => {
    mocks.verify.mockRejectedValue({ status: 401 })
    render(<PaymentSuccessPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar sesión' }))
    expect(mocks.push).toHaveBeenCalledWith('/auth/login?next=%2Fpayment%2Fsuccess%3Fsession_id%3Dcs_example')
  })
})

describe('existing subscription management', () => {
  it('reads the nested cancellation and date, and reactivates through the authenticated API', async () => {
    const canceling = { ...subscription, stripeSubscription: { ...subscription.stripeSubscription, cancelAtPeriodEnd: true } }
    mocks.subscription.mockResolvedValue(canceling)
    mocks.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => canceling })
    mocks.reactivate.mockResolvedValue({ subscription: { status: 'active' } })
    render(<SubscriptionManager />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivar suscripción' }))
    await waitFor(() => expect(mocks.reactivate).toHaveBeenCalledOnce())
    expect(screen.getByText(/Tu suscripción terminará el/).textContent).toContain(new Date('2030-10-01T00:00:00Z').toLocaleDateString())
  })
  it('offers the hosted portal and reports failure without a false navigation', async () => {
    mocks.portal.mockRejectedValue({ status: 503 })
    render(<SubscriptionManager />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gestionar facturación' }))
    await waitFor(() => expect(mocks.portal).toHaveBeenCalledExactlyOnceWith())
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/facturación/i))
  })
  it('shows unavailable subscription details rather than an invented active state', async () => {
    mocks.subscription.mockRejectedValue(new Error('offline'))
    mocks.authenticatedFetch.mockResolvedValue({ ok: false })
    render(<SubscriptionManager />)
    expect(await screen.findByText(/No pudimos consultar tu suscripción/)).toBeInTheDocument()
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
  })
  it('keeps billing portal available to a former subscriber on the free plan', async () => {
    setAuth({ user: { ...user, plan: 'FREE' } })
    mocks.subscription.mockResolvedValue({ plan: 'FREE', status: 'canceled', stripeCustomerId: 'cus_example' })
    render(<SubscriptionManager />)
    expect(await screen.findByRole('button', { name: 'Gestionar facturación' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
  })
  it('rejects a non-Stripe portal URL instead of navigating', async () => {
    mocks.portal.mockResolvedValue({ url: 'https://example.invalid/portal' })
    render(<SubscriptionManager />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gestionar facturación' }))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/facturación/i)))
  })
})

describe('two-plan checkout availability', () => {
  beforeEach(() => setAuth({ user: { ...user, plan: 'FREE' } }))
  it('opens checkout for the canonical ten-dollar plan and preserves the support offer', async () => {
    mocks.checkout.mockRejectedValue({ status: 409, errorData: { code: 'SUBSCRIPTION_EXISTS' } })
    render(<PlanesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir Pro' }))
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledWith({ plan: 'PRO_MAX' }))
    expect(screen.getByRole('heading', { name: 'Hablemos' })).toBeInTheDocument()
    expect(screen.getByText('10 $')).toBeInTheDocument()
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/Facturación/))
  })
  it('shows honest support fallback when the runtime says checkout is unavailable', async () => {
    mocks.config.mockResolvedValue({ whatsappNumber: null, checkoutAvailable: false })
    render(<PlanesPage />)
    expect(await screen.findByRole('link', { name: 'Activar Pro con soporte' })).toHaveAttribute('href', '/support')
    expect(screen.queryByText(/Te activamos Pro en minutos/)).not.toBeInTheDocument()
    expect(mocks.checkout).not.toHaveBeenCalled()
  })
})

describe('cancel return', () => {
  it('uses the only sold paid plan for a legacy retry and preserves login destination', async () => {
    mocks.search = new URLSearchParams('plan=PRO')
    mocks.checkout.mockRejectedValue({ status: 401 })
    render(<PaymentCancelPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar con Pro' }))
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledWith({ plan: 'PRO_MAX' }))
    expect(mocks.push).toHaveBeenCalledWith('/auth/login?next=%2Fplanes')
    expect(screen.queryByText(/Tu cuenta sigue en el plan gratuito/)).not.toBeInTheDocument()
    expect(screen.queryByText(/no se realizó ningún cargo/i)).not.toBeInTheDocument()
  })
})
