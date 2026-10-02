'use strict';

function billingError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode, isBillingRequestError: true });
}

function billingOrigin(env = process.env) {
  const url = new URL(env.FRONTEND_URL || 'http://localhost:3000');
  if (url.username || url.password || (env.NODE_ENV === 'production' && url.origin !== 'https://siragpt.com')) {
    throw billingError('BILLING_ORIGIN_INVALID', 'El pago con tarjeta no está disponible. Contacta con soporte.', 503);
  }
  return url.origin;
}

function assertHostedUrl(value, hostname) {
  const url = new URL(value);
  if (url.origin !== `https://${hostname}` || url.username || url.password) {
    throw billingError('BILLING_REDIRECT_INVALID', 'No se pudo abrir la página segura de facturación.', 502);
  }
  return url.href;
}

async function createCustomerCheckout({ prisma, stripeService, getPriceIdForPlan, userId, env = process.env }) {
  const plan = 'PRO_MAX';
  const origin = billingOrigin(env);
  let user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw billingError('BILLING_USER_NOT_FOUND', 'No se encontró tu cuenta.', 404);

  if (!user.stripeCustomerId) {
    const customer = await stripeService.createCustomer(user.email, user.name, user.id);
    user = await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customer.id } });
  }
  // Stripe is authoritative even if its webhook has not reached us yet.
  const subscriptions = await stripeService.callStripe('listCustomerSubscriptions', () =>
    stripeService.stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'all', limit: 100 }));
  if (subscriptions.has_more || subscriptions.data.some(sub => !['canceled', 'incomplete_expired'].includes(sub.status))) {
    throw billingError('SUBSCRIPTION_EXISTS', 'Ya tienes una suscripción. Gestiona tus pagos desde Facturación.');
  }
  const priceId = await getPriceIdForPlan(plan);
  // Claim one durable attempt under the same user-row lock as fulfillment.
  // Stripe calls stay outside the transaction; concurrent requests reuse the
  // payment ID and therefore the same provider idempotency key.
  const payment = await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT "id" FROM "users" WHERE "id" = $1 FOR NO KEY UPDATE', userId);
    const current = await tx.user.findUnique({ where: { id: userId } });
    if (current.stripeSubscriptionId && !['canceled', 'incomplete_expired'].includes(current.subscriptionStatus)) {
      throw billingError('SUBSCRIPTION_EXISTS', 'Ya tienes una suscripción. Gestiona tus pagos desde Facturación.');
    }
    const pending = await tx.payment.findFirst({
      where: { userId, provider: 'STRIPE', status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (pending) return pending;
    return tx.payment.create({ data: {
      userId, amount: 10, currency: 'USD', plan, provider: 'STRIPE', status: 'PENDING',
      stripeCustomerId: user.stripeCustomerId, stripePriceId: priceId,
      metadata: { billingOrigin: origin },
    } });
  });

  if (payment.amount !== 10 || payment.currency !== 'USD' || payment.stripePriceId !== priceId
    || payment.stripeCustomerId !== user.stripeCustomerId || payment.plan !== plan) {
    throw billingError('CHECKOUT_REQUIRES_REVIEW', 'El intento de pago anterior no coincide con Pro de 10 USD al mes. Contacta con soporte antes de volver a pagar.');
  }
  let session;
  if (payment.stripeSessionId) {
    session = await stripeService.retrieveCheckoutSession(payment.stripeSessionId);
  } else {
    if (Date.now() - new Date(payment.createdAt).getTime() > 23 * 60 * 60 * 1000) {
      throw billingError('CHECKOUT_REQUIRES_REVIEW', 'Hay un intento de pago pendiente de revisión. Contacta con soporte antes de volver a pagar.');
    }
    const checkoutOrigin = payment.metadata?.billingOrigin || origin;
    if (checkoutOrigin !== origin) throw billingError('CHECKOUT_REQUIRES_REVIEW', 'La configuración del pago cambió. Contacta con soporte antes de volver a pagar.');
    session = await stripeService.createCheckoutSession(
      payment.stripePriceId, payment.stripeCustomerId, userId, plan,
      `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      `${origin}/payment/cancel?plan=${plan}`,
      { idempotencyKey: `sira-checkout-${payment.id}` },
    );
    await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: {
      stripeSessionId: session.id, providerId: session.id,
    } });
  }
  if (session.status === 'complete') {
    throw billingError('CHECKOUT_ALREADY_COMPLETED', 'Tu pago ya se está verificando. Revisa tu suscripción en Facturación.');
  }
  if (session.status === 'expired') {
    await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    throw billingError('CHECKOUT_EXPIRED', 'La sesión de pago venció. Pulsa de nuevo para abrir una nueva.');
  }
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (customerId !== user.stripeCustomerId || session.mode !== 'subscription'
    || session.currency !== 'usd' || session.amount_subtotal !== 1000
    || session.metadata?.userId !== userId || session.metadata?.plan !== plan) {
    throw billingError('CHECKOUT_REQUIRES_REVIEW', 'No se pudo verificar el importe o el titular del pago. Contacta con soporte.');
  }
  return { sessionId: session.id, url: assertHostedUrl(session.url, 'checkout.stripe.com') };
}

const PORTAL_FEATURES = Object.freeze({
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
  subscription_update: { enabled: false },
});

async function createCustomerPortal({ prisma, stripeService, userId, env = process.env }) {
  const returnUrl = `${billingOrigin(env)}/billing`;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.stripeCustomerId) {
    throw billingError('BILLING_CUSTOMER_NOT_FOUND', 'Aún no tienes una cuenta de facturación. Puedes activar Pro desde Planes.', 404);
  }
  const portalSession = await stripeService.callStripe('createCustomerPortal', async () => {
    const configurations = await stripeService.stripe.billingPortal.configurations.list({ active: true, limit: 100 });
    let config = configurations.data.find(item => item.metadata?.siragpt_billing === 'v1'
      && item.features?.subscription_update?.enabled === false
      && item.features?.subscription_cancel?.enabled === true
      && item.features?.subscription_cancel?.mode === 'at_period_end'
      && item.features?.payment_method_update?.enabled === true
      && item.features?.invoice_history?.enabled === true);
    if (!config) config = await stripeService.stripe.billingPortal.configurations.create({
      business_profile: { headline: 'Gestiona tu suscripción a SiraGPT' },
      features: PORTAL_FEATURES, default_return_url: returnUrl,
      metadata: { siragpt_billing: 'v1' },
    }, { idempotencyKey: 'sira-billing-portal-v1' });
    const session = await stripeService.stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId, configuration: config.id, return_url: returnUrl, locale: 'es',
    });
    return session;
  });
  return { url: assertHostedUrl(portalSession.url, 'billing.stripe.com') };
}

module.exports = { billingOrigin, createCustomerCheckout, createCustomerPortal };
