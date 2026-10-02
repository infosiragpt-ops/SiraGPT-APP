import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { paymentIsConfirmed, subscriptionView, subscriptionIsActive } from '@/lib/payment-status'
import { describeCheckoutError } from '@/lib/plans-catalog'

describe('payment status boundaries', () => {
  const paid = { sessionId: 'cs_test', paymentStatus: 'COMPLETED', status: 'paid', plan: 'PRO_MAX', amount: 10 }
  it('requires the owned session response and both confirmation states', () => {
    assert.equal(paymentIsConfirmed(paid, 'cs_test'), true)
    assert.equal(paymentIsConfirmed(paid, 'another_session'), false)
    assert.equal(paymentIsConfirmed({ ...paid, paymentStatus: 'PENDING' }, 'cs_test'), false)
    assert.equal(paymentIsConfirmed({ ...paid, status: 'unpaid' }, 'cs_test'), false)
  })
  it('uses the canonical nested subscription and local cancellation fallback', () => {
    const date = '2030-10-01T00:00:00Z'
    assert.deepEqual(subscriptionView({ status: 'canceling', endDate: date }), {
      status: 'canceling', currentPeriodEnd: date, cancelAtPeriodEnd: true, hasCustomer: false,
    })
    const current = { plan: 'PRO_MAX', status: 'canceling', endDate: 'invalid', stripeSubscription: { status: 'active', currentPeriodEnd: date, cancelAtPeriodEnd: false } }
    assert.equal(subscriptionView(current).cancelAtPeriodEnd, false)
    assert.equal(subscriptionView(current).currentPeriodEnd, date)
    assert.equal(subscriptionIsActive(current, 'PRO_MAX'), true)
    assert.equal(subscriptionIsActive(current, 'PRO'), false)
  })
  it('does not claim active access after the scheduled end or a canceled status', () => {
    assert.equal(subscriptionIsActive({ plan: 'PRO_MAX', status: 'canceling', endDate: '2000-01-01' }, 'PRO_MAX'), false)
    assert.equal(subscriptionIsActive({ plan: 'PRO_MAX', status: 'canceled' }, 'PRO_MAX'), false)
    assert.equal(subscriptionView({ status: null, endDate: 'invalid' }).currentPeriodEnd, null)
  })
  it('does not disable checkout permanently on a transient 503', () => {
    assert.equal(describeCheckoutError({ status: 503, errorData: { code: 'STRIPE_UNAVAILABLE' } }).kind, 'generic')
    assert.equal(describeCheckoutError({ status: 503, errorData: { code: 'STRIPE_NOT_CONFIGURED' } }).kind, 'unavailable')
  })
  it('explains duplicate or uncertain checkouts without encouraging a second payment', () => {
    assert.match(describeCheckoutError({ status: 409, errorData: { code: 'SUBSCRIPTION_EXISTS' } }).message, /Facturación/)
    assert.match(describeCheckoutError({ status: 409, errorData: { code: 'CHECKOUT_ALREADY_COMPLETED' } }).message, /se está verificando/)
    assert.match(describeCheckoutError({ status: 409, errorData: { code: 'CHECKOUT_REQUIRES_REVIEW' } }).message, /soporte antes/)
  })
})
