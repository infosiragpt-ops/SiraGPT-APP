const express = require('express');
const { randomUUID } = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { parsePositiveInt } = require('../services/chat-scope');
const prisma = require('../config/database');
const stripeService = require('../services/stripe');
const { logger } = require('../middleware/logger');
const { redactErrorMessage } = require('../utils/secret-redactor');
const { getPriceIdForPlan } = require('../utils/stripe-setup');
const usageMonitor = require('../services/usage-monitor');
const emailService = require('../services/email');
const { writeAuditLog } = require('../utils/audit-log');
const triggers = require('../services/trigger-registry');
const { monthlyLimitForStripePlan, gemaTokenGrant } = require('../services/plan-credits-catalog');
const {
  stripeInvoiceSubscriptionId,
  syncInvoiceFromStripe,
} = require('../services/invoice-sync');
const {
  resolveStripeWebhookRecoveryConfig,
} = require('../services/stripe-webhook-recovery');

function premiumCreditsForPlan(plan) {
  return monthlyLimitForStripePlan(plan);
}

function gemaLimitForPlan(plan) {
  return gemaTokenGrant(plan);
}

// Helper: coerce a value to BigInt safely. Stripe + Prisma return
// monthlyLimit/usage as BigInt in some code paths and Number in
// others. Mixing the two in arithmetic throws
// "Cannot mix BigInt and other types" which silently aborts the
// webhook handler.
function toBigIntSafe(value, fallback = 0n) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return value;
  try {
    if (typeof value === 'number' && !Number.isFinite(value)) return fallback;
    return BigInt(Math.trunc(Number(value)));
  } catch {
    return fallback;
  }
}
const prorationService = require('../services/proration');
const subscriptionAnalyticsService = require('../services/subscription-analytics');
const { serializeBigIntFields } = require('../utils/bigint-serializer');
const {
  capturePostHogEvent,
  getPostHogStatus,
} = require('../services/observability/posthog');
const axios = require('axios');
const {
  contentDispositionHeader,
  safeDownloadFilename,
} = require('../middleware/file-response-safety');
const {
  assertOutboundUrlSafe,
  parseSafeOutboundUrl,
} = require('../utils/url-ssrf-guard');

const router = express.Router();

function invoicePdfFilename(invoice) {
  return safeDownloadFilename(`invoice-${invoice?.number || invoice?.id || Date.now()}.pdf`, {
    fallback: 'invoice.pdf',
    extension: '.pdf',
  });
}

// Stripe sometimes returns timestamps as BigInt in newer SDK versions.
// Multiplying a BigInt by a Number throws "Cannot mix BigInt and other types",
// and `new Date(undefined)` produces an Invalid Date that Prisma rejects.
// Funnel every Stripe-unix-seconds → Date conversion through this helper.
function toDateFromUnix(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function futureDateOrNull(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) && timestamp > nowMs ? date : null;
}

function requestIdFor(req) {
  return req.requestId || req.id || req.headers?.['x-request-id'] || null;
}

function logRouteError(req, message, error, context = {}) {
  const log = req.log || logger;
  const payload = {
    error: {
      name: error?.name || 'Error',
      message: redactErrorMessage(error),
      code: error?.code || undefined,
    },
    requestId: requestIdFor(req),
    ...context,
  };
  if (typeof log.error === 'function') log.error(payload, message);
}

function sendStripeError(res, req, error, operation) {
  const response = stripeService.toHttpError(error, {
    requestId: requestIdFor(req),
    operation,
  });
  return res.status(response.statusCode).json(response.body);
}

// Stripe invoice assets (invoice_pdf / hosted_invoice_url) live on *.stripe.com.
// Restricting outbound fetches + redirects to those hosts — on top of the shared
// private-IP / DNS-rebinding guard — closes an SSRF + open-redirect vector where a
// tampered invoice object could point invoice_pdf at an internal service such as
// http://127.0.0.1:6379 or the cloud metadata endpoint. Env-extendable so an ops
// change never requires a code change.
const STRIPE_INVOICE_ALLOWED_HOSTS = (() => {
  const base = ['stripe.com'];
  const extra = String(process.env.STRIPE_INVOICE_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set([...base, ...extra]));
})();

// Streams the invoice PDF (after validating the outbound URL) or, failing that,
// redirects to the hosted invoice URL (after validating it too). Returns the
// Express response. Shared by both invoice-download routes.
async function streamInvoicePdfOrRedirect(req, res, invoice) {
  if (invoice.invoice_pdf) {
    try {
      await assertOutboundUrlSafe(invoice.invoice_pdf, { allowHosts: STRIPE_INVOICE_ALLOWED_HOSTS });
    } catch (err) {
      logRouteError(req, 'payments.invoice.url_rejected', err, { field: 'invoice_pdf' });
      return res.status(502).json({ error: 'Invoice URL failed safety validation', requestId: requestIdFor(req) });
    }
    const response = await axios.get(invoice.invoice_pdf, { responseType: 'stream', timeout: 15000 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDispositionHeader('attachment', invoicePdfFilename(invoice)));
    return response.data.pipe(res);
  }

  if (invoice.hosted_invoice_url) {
    try {
      parseSafeOutboundUrl(invoice.hosted_invoice_url, { allowHosts: STRIPE_INVOICE_ALLOWED_HOSTS });
    } catch (err) {
      logRouteError(req, 'payments.invoice.redirect_rejected', err, { field: 'hosted_invoice_url' });
      return res.status(502).json({ error: 'Invoice URL failed safety validation', requestId: requestIdFor(req) });
    }
    return res.redirect(invoice.hosted_invoice_url);
  }

  return res.status(404).json({ error: 'Invoice PDF not available' });
}

// Rate limiting for payment endpoints
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: { error: 'Too many payment attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const subscriptionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour  
  max: 5, // Limit subscription changes
  message: { error: 'Too many subscription changes, please try again later.' }
});

// Get usage statistics
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const period = req.query.period || 'current_month';
    
    const stats = await usageMonitor.getUsageStats(userId, period);
    res.json(stats);
    
  } catch (error) {
    console.error('Error fetching usage stats:', error);
    res.status(500).json({ error: 'Failed to fetch usage statistics' });
  }
});



// Get notifications
router.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: parsePositiveInt(req.query.limit, 50, { min: 1, max: 100 })
    });

    const unreadCount = await prisma.notification.count({
      where: { 
        userId: req.user.id,
        read: false
      }
    });
    
    res.json({
      notifications,
      unreadCount
    });
    
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});



// Get subscription analytics (admin only)
router.get('/analytics', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });
    
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const period = req.query.period || '30d';
    const analytics = await subscriptionAnalyticsService.getSubscriptionAnalytics(period);
    
    res.json(analytics);
    
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Mark notification as read
router.put('/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    await prisma.notification.update({
      where: { 
        id: req.params.id,
        userId: req.user.id 
      },
      data: { 
        read: true,
        readAt: new Date()
      }
    });
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// Preview plan change
router.post('/plan-change/preview', subscriptionLimiter, [
  body('newPlan').isIn(['PRO', 'PRO_MAX', 'ENTERPRISE']).withMessage('Invalid plan')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { newPlan } = req.body;
    const userId = req.user.id;

    const preview = await prorationService.previewPlanChange(userId, newPlan);
    res.json(preview);
    
  } catch (error) {
    console.error('Error previewing plan change:', error);
    res.status(400).json({ error: error.message });
  }
});

// Execute plan change
router.post('/plan-change/execute', subscriptionLimiter, [
  body('newPlan').isIn(['PRO', 'PRO_MAX', 'ENTERPRISE']).withMessage('Invalid plan'),
  // `immediate` is optional — the handler defaults it to true. Without
  // .optional(), activating validationResult below would reject every
  // legitimate request that omits it.
  body('immediate').optional().isBoolean().withMessage('Immediate must be boolean')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { newPlan, immediate = true } = req.body;
    const userId = req.user.id;

    const result = await prorationService.changePlan(userId, newPlan, immediate);
    res.json(result);
    
  } catch (error) {
    console.error('Error executing plan change:', error);
    res.status(400).json({ error: error.message });
  }
});

// Cancel scheduled plan change
router.post('/plan-change/cancel', subscriptionLimiter, authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await prorationService.cancelScheduledPlanChange(userId);
    res.json(result);
    
  } catch (error) {
    console.error('Error cancelling scheduled plan change:', error);
    res.status(400).json({ error: error.message });
  }
});

// Create Stripe checkout session
router.post('/stripe', paymentLimiter, [
  body('plan').isIn(['PRO', 'PRO_MAX', 'ENTERPRISE']).withMessage('Invalid plan')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Check if Stripe is configured
    if (!stripeService.isConfigured) {
      return res.status(503).json({ 
        error: 'Stripe not configured', 
        message: 'Payment processing is not available. Please contact support or use demo mode.',
        fallbackAvailable: true
      });
    }

    const { plan } = req.body;
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get or create Stripe customer
    let stripeCustomerId = user.stripeCustomerId;
    
    if (!stripeCustomerId) {
      const customer = await stripeService.createCustomer(
        user.email,
        user.name,
        user.id
      );
      
      stripeCustomerId = customer.id;
      
      // Update user with Stripe customer ID
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId }
      });
    }

    // Get price ID for the plan
    const priceId = await getPriceIdForPlan(plan);
    
    // Calculate amount for payment record
    const planAmounts = {
      PRO: 5.00,
      PRO_MAX: 10.00,
      ENTERPRISE: 200.00
    };

    // Create payment record
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        amount: planAmounts[plan],
        plan,
        provider: 'STRIPE',
        stripeCustomerId,
        stripePriceId: priceId,
        status: 'PENDING'
      }
    });

    // Create Stripe checkout session
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const session = await stripeService.createCheckoutSession(
      priceId,
      stripeCustomerId,
      user.id,
      plan,
      `${frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      `${frontendUrl}/payment/cancel?plan=${encodeURIComponent(plan)}`
    );

    // Update payment record with session ID
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        stripeSessionId: session.id,
        providerId: session.id
      }
    });

    res.json({
      sessionId: session.id,
      url: session.url,
      payment
    });

  } catch (error) {
    if (error?.isStripeOperationalError || stripeService.isStripeLikeError?.(error)) {
      return sendStripeError(res, req, error, 'createStripeCheckout');
    }

    logRouteError(req, 'payments.stripe.create_failed', error, { plan: req.body?.plan });
    res.status(500).json({ 
      error: 'Payment creation failed',
      requestId: requestIdFor(req),
    });
  }
});

// PayPal payment
router.post('/paypal', [
  body('plan').isIn(['PRO', 'ENTERPRISE']).withMessage('Invalid plan')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { plan } = req.body;
    const amount = plan === 'PRO' ? 29 : 99;

    // Create payment record
    const payment = await prisma.payment.create({
      data: {
        userId: req.user.id,
        amount,
        plan,
        provider: 'PAYPAL',
        status: 'PENDING'
      }
    });

    // Simulate PayPal integration
    const paypalOrderId = `PAYPAL_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    res.json({
      orderId: paypalOrderId,
      approvalUrl: `${process.env.FRONTEND_URL}/payment/paypal?order_id=${paypalOrderId}`,
      payment
    });
  } catch (error) {
    console.error('PayPal payment error:', error);
    res.status(500).json({ error: 'PayPal payment creation failed' });
  }
});

// MercadoPago payment
router.post('/mercadopago', [
  body('plan').isIn(['PRO', 'ENTERPRISE']).withMessage('Invalid plan')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { plan } = req.body;
    const amount = plan === 'PRO' ? 29 : 99;

    // Create payment record
    const payment = await prisma.payment.create({
      data: {
        userId: req.user.id,
        amount,
        plan,
        provider: 'MERCADOPAGO',
        status: 'PENDING'
      }
    });

    // Simulate MercadoPago integration
    const preferenceId = `MP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    res.json({
      preferenceId,
      initPoint: `${process.env.FRONTEND_URL}/payment/mercadopago?preference_id=${preferenceId}`,
      payment
    });
  } catch (error) {
    console.error('MercadoPago payment error:', error);
    res.status(500).json({ error: 'MercadoPago payment creation failed' });
  }
});

async function claimAndGrantVerifiedPayment({
  payment,
  authenticatedUserId,
  sessionId,
  subscriptionId = null,
  checkoutCreated = null,
  checkoutSession = null,
}) {
  return prisma.$transaction(async (tx) => {
    // Match the webhook's global billing lock order. The unlocked lookup above
    // supplies only immutable identity; all mutable state is re-read below.
    await lockStripeWebhookUser(tx, payment.userId);
    const currentUser = await tx.user.findUnique({ where: { id: payment.userId } });
    if (!currentUser || currentUser.id !== authenticatedUserId) {
      return { granted: false, status: payment.status, reason: 'user_revalidation_failed' };
    }

    await lockStripePayment(tx, payment.id);
    const durablePayment = await tx.payment.findFirst({
      where: {
        id: payment.id,
        userId: payment.userId,
        stripeSessionId: sessionId,
      },
    });
    if (!durablePayment) {
      return { granted: false, status: payment.status, reason: 'payment_revalidation_failed' };
    }
    if (durablePayment.status !== 'PENDING') {
      return {
        granted: false,
        status: durablePayment.status,
        reason: 'payment_already_resolved',
      };
    }

    let plan = stripePaidPlan(durablePayment.plan);
    if (checkoutSession) {
      const metadataUserId = typeof checkoutSession.metadata?.userId === 'string'
        && checkoutSession.metadata.userId
        ? checkoutSession.metadata.userId
        : null;
      const metadataPlanProvided = typeof checkoutSession.metadata?.plan === 'string'
        && checkoutSession.metadata.plan.length > 0;
      const identityValidation = checkoutValidation({
        object: checkoutSession,
        user: currentUser,
        payment: durablePayment,
        customerId: stripeResourceId(checkoutSession.customer),
        metadataUserId,
        metadataPlan: stripePaidPlan(checkoutSession.metadata?.plan),
        metadataPlanProvided,
      }, durablePayment);
      if (!identityValidation.ok) {
        return {
          fulfilled: false,
          granted: false,
          status: durablePayment.status,
          reason: identityValidation.reason,
        };
      }
      plan = identityValidation.plan;
    }
    if (!plan || plan !== stripePaidPlan(payment.plan)) {
      return { granted: false, status: durablePayment.status, reason: 'plan_revalidation_failed' };
    }
    const normalizedSubscriptionId = stripeResourceId(subscriptionId);
    const claim = await tx.payment.updateMany({
      where: {
        id: durablePayment.id,
        userId: payment.userId,
        stripeSessionId: sessionId,
        plan,
        status: 'PENDING',
        ...(checkoutSession
          ? { stripeCustomerId: stripeResourceId(checkoutSession.customer) }
          : {}),
      },
      data: {
        status: 'COMPLETED',
        ...(normalizedSubscriptionId
          ? { stripeSubscriptionId: normalizedSubscriptionId }
          : {}),
      },
    });
    if (claim.count === 0) {
      return { granted: false, status: 'COMPLETED', reason: 'payment_claim_lost' };
    }

    const checkoutEvent = {
      type: 'checkout.session.completed',
      created: checkoutCreated,
    };
    const latestEntitlement = await latestStripeEntitlementForUser(
      tx,
      currentUser.id,
      {
        subscriptionId: normalizedSubscriptionId,
        sessionId,
      },
    );
    const latestOrder = latestEntitlement
      ? {
        created: latestEntitlement.created,
        precedence: latestEntitlement.precedence,
      }
      : null;
    let entitlementFenceReason = null;
    if (!normalizedSubscriptionId) {
      entitlementFenceReason = 'subscription_id_missing';
    } else if (!stripeEventCreated(checkoutEvent)) {
      entitlementFenceReason = 'event_created_missing';
    } else if (stripeOrderIsBehind(checkoutEvent, latestOrder)) {
      entitlementFenceReason = 'event_out_of_order';
    }
    const entitlementFence = {
      currentUser,
      latestEntitlement,
      currentSubscriptionMatches: Boolean(
        normalizedSubscriptionId
        && stripeResourceId(currentUser.stripeSubscriptionId) === normalizedSubscriptionId,
      ),
      reason: entitlementFenceReason,
    };
    const entitlementDecision = checkoutEntitlementDecision(
      checkoutEvent,
      entitlementFence,
    );
    if (!entitlementDecision.grantEntitlement) {
      return {
        fulfilled: true,
        granted: false,
        status: 'COMPLETED',
        reason: entitlementDecision.reason,
      };
    }

    const currentLimit = typeof currentUser.monthlyLimit === 'bigint'
      ? currentUser.monthlyLimit
      : BigInt(currentUser.monthlyLimit ?? 0);
    const userData = {
      plan,
      monthlyLimit: currentLimit + premiumCreditsForPlan(plan),
      gemaTokenLimit: toBigIntSafe(currentUser.gemaTokenLimit) + gemaLimitForPlan(plan),
      ...(normalizedSubscriptionId
        ? { stripeSubscriptionId: normalizedSubscriptionId }
        : {}),
      ...(entitlementDecision.reactivateSubscription
        ? { subscriptionStatus: 'active' }
        : {}),
    };
    await tx.user.update({
      where: { id: payment.userId },
      data: userData,
    });
    return {
      fulfilled: true,
      granted: true,
      status: 'COMPLETED',
      reason: null,
    };
  });
}

// Verify payment session
router.get('/verify-session', authenticateToken, async (req, res) => {
  try {
    const { session_id } = req.query;
    
    if (!session_id) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    console.log(`Verifying payment session: ${session_id} for user: ${req.user.id}`);

    // Find payment by session ID
    const payment = await prisma.payment.findFirst({
      where: {
        stripeSessionId: session_id,
        userId: req.user.id
      }
    });

    if (!payment) {
      console.log(`Payment not found for session: ${session_id}, user: ${req.user.id}`);
      return res.status(404).json({ error: 'Payment session not found' });
    }

    console.log(`Found payment:`, { id: payment.id, status: payment.status, plan: payment.plan });

    let session;
    let paymentStatus = payment.status;
    
    try {
      // Get session details from Stripe
      session = await stripeService.retrieveCheckoutSession(session_id);
      console.log(`Stripe session status: ${session.payment_status}`);
      
      // If Stripe session is paid and our payment is still pending, claim the
      // row and grant the plan ATOMICALLY — the same idempotency compare-and-set
      // the webhook uses (handleCheckoutSessionCompleted). Without the atomic
      // claim, two concurrent verify-session calls — or a verify racing the
      // checkout.session.completed webhook — each read PENDING and granted
      // credits, double-granting. Only the request that flips the row
      // PENDING → COMPLETED grants; the loser short-circuits. monthlyLimit
      // is BigInt in Prisma, so both operands are coerced to BigInt.
      if (session.payment_status === 'paid' && payment.status === 'PENDING') {
        console.log('Payment is successful in Stripe, updating user plan...');

        const grant = await claimAndGrantVerifiedPayment({
          payment,
          authenticatedUserId: req.user.id,
          sessionId: session_id,
          subscriptionId: session.subscription,
          checkoutCreated: session.created,
          checkoutSession: session,
        });

        console.log(
          grant.granted
            ? `Successfully updated user ${req.user.id} to plan ${payment.plan}`
            : (
                grant.fulfilled
                  ? `Payment ${payment.id} completed without entitlement grant (${grant.reason})`
                  : (
                      grant.reason === 'payment_already_resolved'
                      || grant.reason === 'payment_claim_lost'
                        ? `Payment ${payment.id} already completed elsewhere; skipping duplicate grant`
                        : `Payment ${payment.id} verification rejected (${grant.reason})`
                    )
              ),
        );
        paymentStatus = grant.status;
      }
    } catch (stripeError) {
      if (!stripeService.demoAllowed || stripeService.isConfigured) {
        return sendStripeError(res, req, stripeError, 'verifyStripeCheckoutSession');
      }

      // In explicit local demo mode (without Stripe keys), simulate successful payment.
      if (payment.status === 'PENDING') {
        console.log('Demo mode: Updating payment and user plan...');

        // Same user-first lock order and durable revalidation as configured
        // Stripe verification.
        const grant = await claimAndGrantVerifiedPayment({
          payment,
          authenticatedUserId: req.user.id,
          sessionId: session_id,
        });

        console.log(grant.granted
          ? `Demo mode: Successfully updated user ${req.user.id} to plan ${payment.plan}`
          : `Demo mode: Payment ${payment.id} completed without entitlement grant`);
        paymentStatus = grant.status;
      }
    }
    
    res.json({
      sessionId: session_id,
      paymentStatus,
      plan: payment.plan,
      amount: payment.amount,
      status: session?.payment_status || 'demo_paid',
      customerEmail: session?.customer_details?.email || req.user.email,
      updated: true
    });

  } catch (error) {
    if (error?.isStripeOperationalError || stripeService.isStripeLikeError?.(error)) {
      return sendStripeError(res, req, error, 'verifyStripeCheckoutSession');
    }
    logRouteError(req, 'payments.verify_session_failed', error);
    res.status(500).json({ error: 'Failed to verify payment session', requestId: requestIdFor(req) });
  }
});


// Get user payments
router.get('/', authenticateToken, async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 100000 });
    const limit = parsePositiveInt(req.query.limit, 10, { min: 1, max: 100 });
    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where: { userId: req.user.id },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.payment.count({
        where: { userId: req.user.id }
      })
    ]);

    res.json({
      payments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// List Stripe invoices for current user
router.get('/stripe/invoices', authenticateToken, async (req, res) => {
  try {
    if (!stripeService.isConfigured) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !user.stripeCustomerId) {
      return res.json({ invoices: [] });
    }

    const invoices = await stripeService.listInvoices({
      customer: user.stripeCustomerId,
      limit: 50
    });

    res.json({
      invoices: invoices.data.map(inv => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        amountPaid: Number(inv.amount_paid || 0) / 100,
        currency: inv.currency,
        hostedInvoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
        created: toDateFromUnix(inv.created),
        periodStart: toDateFromUnix(inv.lines.data[0]?.period?.start),
        periodEnd: toDateFromUnix(inv.lines.data[0]?.period?.end)
      }))
    });
  } catch (error) {
    if (error?.isStripeOperationalError || stripeService.isStripeLikeError?.(error)) {
      return sendStripeError(res, req, error, 'listStripeInvoices');
    }
    logRouteError(req, 'payments.invoices.list_failed', error);
    res.status(500).json({ error: 'Failed to list invoices', requestId: requestIdFor(req) });
  }
});

// Download a specific invoice PDF (proxy/redirect)
router.get('/stripe/invoice/:invoiceId', authenticateToken, async (req, res) => {
  try {
    if (!stripeService.isConfigured) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    const { invoiceId } = req.params;
    const invoice = await stripeService.retrieveInvoice(invoiceId);

    // Optional: ensure invoice belongs to the current user
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !user.stripeCustomerId || invoice.customer !== user.stripeCustomerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Prefer direct invoice PDF if available; otherwise redirect to the hosted
    // URL. Both outbound URLs are SSRF/open-redirect validated in the helper.
    return await streamInvoicePdfOrRedirect(req, res, invoice);
  } catch (error) {
    if (error?.isStripeOperationalError || stripeService.isStripeLikeError?.(error)) {
      return sendStripeError(res, req, error, 'downloadStripeInvoice');
    }
    logRouteError(req, 'payments.invoice.download_failed', error, { invoiceId: req.params.invoiceId });
    res.status(500).json({ error: 'Failed to download invoice', requestId: requestIdFor(req) });
  }
});

// Download invoice by payment ID (maps payment -> related Stripe invoice)
router.get('/invoice/:paymentId', authenticateToken, async (req, res) => {
  try {
    if (!stripeService.isConfigured) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    const payment = await prisma.payment.findFirst({
      where: { id: req.params.paymentId, userId: req.user.id }
    });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (!payment.stripeCustomerId) {
      return res.status(400).json({ error: 'No Stripe customer associated with this payment' });
    }

    // Strategy: if we have a subscription ID, list invoices for that subscription first; otherwise list by customer
    let invoice = null;

    if (payment.stripeSubscriptionId) {
      const list = await stripeService.listInvoices({
        subscription: payment.stripeSubscriptionId,
        limit: 20
      });
      invoice = list.data.find(inv => inv.status === 'paid') || list.data[0] || null;
    }

    if (!invoice) {
      const list = await stripeService.listInvoices({
        customer: payment.stripeCustomerId,
        limit: 50
      });
      // Pick closest by created date to the payment
      const targetTime = payment.createdAt.getTime();
      invoice = list.data
        .sort((a, b) => Math.abs(a.created * 1000 - targetTime) - Math.abs(b.created * 1000 - targetTime))[0] || null;
    }

    if (!invoice) {
      return res.status(404).json({ error: 'No related invoice found for this payment' });
    }

    // Stream PDF if available, else redirect to hosted URL. Both outbound URLs
    // are SSRF/open-redirect validated in the helper.
    return await streamInvoicePdfOrRedirect(req, res, invoice);
  } catch (error) {
    if (error?.isStripeOperationalError || stripeService.isStripeLikeError?.(error)) {
      return sendStripeError(res, req, error, 'downloadStripeInvoiceByPayment');
    }
    logRouteError(req, 'payments.invoice_by_payment.download_failed', error, { paymentId: req.params.paymentId });
    res.status(500).json({ error: 'Failed to download invoice', requestId: requestIdFor(req) });
  }
});

// Instant (demo) subscription - frontend calls /api/payments/instant
//
// SECURITY: This endpoint can grant any caller a paid plan. It is
// locked behind THREE gates:
//   1. The caller must be a super admin (`req.user.isSuperAdmin`).
//   2. The env flag `ALLOW_INSTANT_SUBSCRIPTION=true` must be set.
//   3. Every successful call is recorded in `subscriptionEvent` and
//      logged with the `[SUPER_ADMIN_AUDIT]` tag for grep-ability.
// Without (1) AND (2) the endpoint returns 403/404 — the legacy
// "any authenticated user can self-upgrade" behavior is gone.
router.post(
  '/instant',
  authenticateToken,
  [
    body('plan')
      .isIn(['PRO', 'PRO_MAX', 'ENTERPRISE'])
      .withMessage('Invalid plan (allowed: PRO, PRO_MAX, ENTERPRISE)'),
    body('monthlyLimit').optional().isInt({ min: 0 }).withMessage('monthlyLimit must be an integer >= 0'),
    body('targetUserId').optional().isString(),
    body('reason').optional().isString(),
  ],
  async (req, res) => {
    try {
      // Gate 1: super-admin only.
      if (!req.user?.isSuperAdmin) {
        return res.status(403).json({ error: 'Super admin access required' });
      }

      // Gate 2: env flag must be on (default-off in production).
      if (process.env.ALLOW_INSTANT_SUBSCRIPTION !== 'true') {
        return res.status(404).json({
          error: 'Instant subscription endpoint disabled. Set ALLOW_INSTANT_SUBSCRIPTION=true to enable.',
        });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { plan, monthlyLimit, targetUserId, reason } = req.body;
      const userIdToUpdate = targetUserId || req.user.id;

      const add = typeof monthlyLimit !== 'undefined' && monthlyLimit !== null
        ? toBigIntSafe(monthlyLimit)
        : premiumCreditsForPlan(plan);

      const dbUser = await prisma.user.findUnique({ where: { id: userIdToUpdate } });
      if (!dbUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      const currentLimit = toBigIntSafe(dbUser.monthlyLimit);
      const newMonthlyLimit = currentLimit + add;

      const updated = await prisma.user.update({
        where: { id: userIdToUpdate },
        data: {
          plan,
          monthlyLimit: newMonthlyLimit,
          gemaTokenLimit: toBigIntSafe(dbUser.gemaTokenLimit) + gemaLimitForPlan(plan),
          monthlyCallLimit: 0,
        },
      });

      // Audit trail — persist + structured log so ops can grep.
      console.warn(
        `[SUPER_ADMIN_AUDIT] instant_subscription admin=${req.user.email} target=${dbUser.email} plan=${plan} added=${add} reason=${JSON.stringify(reason || 'n/a')}`
      );
      try {
        await prisma.subscriptionEvent.create({
          data: {
            userId: userIdToUpdate,
            eventType: 'admin_instant_grant',
            newPlan: plan,
            eventData: serializeBigIntFields({
              adminId: req.user.id,
              adminEmail: req.user.email,
              addedCredits: add,
              newMonthlyLimit,
              reason: reason || null,
            }),
          },
        });
      } catch (auditErr) {
        console.error('[SUPER_ADMIN_AUDIT] failed to persist event:', auditErr.message);
      }

      void writeAuditLog(prisma, {
        req,
        action: 'payment_instant',
        resource: 'payment',
        resourceId: userIdToUpdate,
        userId: req.user.id,
        actorName: req.user.email,
        before: { plan: dbUser.plan, monthlyLimit: String(currentLimit) },
        after: { plan, monthlyLimit: String(newMonthlyLimit) },
        metadata: {
          targetUserId: userIdToUpdate,
          targetEmail: dbUser.email,
          addedCredits: String(add),
          reason: reason || null,
        },
        tags: ['billing', 'admin'],
      });

      return res.json({ user: serializeBigIntFields(updated) });
    } catch (error) {
      console.error('Instant subscription error:', error);
      return res.status(500).json({ error: 'Failed to apply instant subscription' });
    }
  }
);

// Stripe webhook handler
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripeService.constructWebhookEvent(req.body, sig);
    } catch (err) {
      const response = stripeService.toHttpError(err, {
        requestId: requestIdFor(req),
        operation: 'constructWebhookEvent',
      });
      return res.status(response.statusCode).send(`Webhook Error: ${response.body.message}`);
    }

    console.log('Received Stripe webhook:', event.type);

    // Handle the verified event. Signature construction above is deliberately
    // unchanged; durable idempotency starts only after Stripe has authenticated
    // the payload and supplied its canonical `event.id`.
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event);
        break;
      
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event);
        break;
      
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event);
        break;
      
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event);
        break;
      
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event);
        break;
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });

  } catch (error) {
    logRouteError(req, 'payments.webhook.processing_failed', error);
    res.status(500).json({ error: 'Webhook processing failed', requestId: requestIdFor(req) });
  }
});

const STRIPE_WEBHOOK_EVENT_TYPES = Object.freeze({
  'checkout.session.completed': 'checkout_completed',
  'invoice.payment_succeeded': 'payment_succeeded',
  'invoice.payment_failed': 'payment_failed',
  'customer.subscription.created': 'created',
  'customer.subscription.updated': 'updated',
  'customer.subscription.deleted': 'canceled',
});

const STRIPE_PAID_PLANS = new Set(['PRO', 'PRO_MAX', 'ENTERPRISE']);
const STRIPE_ENTITLEMENT_EVENT_TYPES = Object.freeze([
  STRIPE_WEBHOOK_EVENT_TYPES['checkout.session.completed'],
  STRIPE_WEBHOOK_EVENT_TYPES['customer.subscription.created'],
  STRIPE_WEBHOOK_EVENT_TYPES['customer.subscription.updated'],
  STRIPE_WEBHOOK_EVENT_TYPES['customer.subscription.deleted'],
]);
const STRIPE_ENTITLEMENT_PRECEDENCE = Object.freeze({
  'checkout.session.completed': 1,
  checkout_completed: 1,
  'customer.subscription.created': 1,
  created: 1,
  'customer.subscription.updated': 2,
  updated: 2,
  'customer.subscription.deleted': 3,
  canceled: 3,
  cancelled: 3,
  deleted: 3,
});
const STRIPE_TERMINAL_ENTITLEMENT_STATUSES = new Set([
  'canceled',
  'cancelled',
  'deleted',
  'expired',
  'inactive',
  'incomplete_expired',
  'past_due',
  'paused',
  'unpaid',
]);
const STRIPE_SUBSCRIPTION_CYCLE_BILLING_REASON = 'subscription_cycle';
const STRIPE_WEBHOOK_OUTBOX_VERSION = 1;
const STRIPE_EFFECT_LEASE_MS = 5 * 60 * 1000;
const STRIPE_EFFECT_BUSY_WAIT_MS = 250;
const STRIPE_UNRESOLVED_PREFIX = 'stripe:webhook:unresolved:';

function stripeResourceId(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

function stripePaidPlan(value) {
  const plan = typeof value === 'string' ? value.toUpperCase() : '';
  return STRIPE_PAID_PLANS.has(plan) ? plan : null;
}

function currentMonthStartUtcForStripeWebhook() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function stripeEventCreated(event) {
  const created = Number(event?.created);
  return Number.isFinite(created) && created > 0 ? Math.trunc(created) : null;
}

function projectedStripeSubscriptionStatus(subscription) {
  const status = String(subscription?.status || '').trim().toLowerCase();
  if (
    subscription?.cancel_at_period_end === true
    && (status === 'active' || status === 'trialing')
  ) {
    return 'canceling';
  }
  return status || null;
}

function checkoutValidation(context, payment = context.payment) {
  const { object, user } = context;
  if (object.payment_status !== 'paid') {
    return { ok: false, reason: 'checkout_unpaid' };
  }
  if (!payment) {
    return { ok: false, reason: 'checkout_payment_not_found' };
  }
  if (
    payment.provider
    && String(payment.provider).trim().toUpperCase() !== 'STRIPE'
  ) {
    return { ok: false, reason: 'checkout_payment_provider_mismatch' };
  }
  if (payment.stripeSessionId !== object.id) {
    return { ok: false, reason: 'checkout_session_mismatch' };
  }

  const customerId = stripeResourceId(object.customer);
  const paymentCustomerId = stripeResourceId(payment.stripeCustomerId);
  if (
    !customerId
    || paymentCustomerId !== customerId
    || stripeResourceId(user?.stripeCustomerId) !== customerId
  ) {
    return { ok: false, reason: 'checkout_customer_mismatch' };
  }
  const subscriptionId = stripeResourceId(object.subscription);
  const paymentSubscriptionId = stripeResourceId(payment.stripeSubscriptionId);
  if (
    paymentSubscriptionId
    && paymentSubscriptionId !== subscriptionId
  ) {
    return { ok: false, reason: 'checkout_subscription_mismatch' };
  }

  if (
    !user
    || payment.userId !== user.id
    || (context.metadataUserId && context.metadataUserId !== payment.userId)
  ) {
    return { ok: false, reason: 'checkout_user_mismatch' };
  }

  const paymentPlan = stripePaidPlan(payment.plan);
  if (
    !paymentPlan
    || (context.metadataPlanProvided && context.metadataPlan !== paymentPlan)
  ) {
    return { ok: false, reason: 'checkout_plan_mismatch' };
  }

  return { ok: true, plan: paymentPlan };
}

async function resolveStripeWebhookContext(event) {
  const object = event?.data?.object || {};

  if (event.type === 'checkout.session.completed') {
    const metadataUserId = typeof object.metadata?.userId === 'string'
      && object.metadata.userId
      ? object.metadata.userId
      : null;
    const metadataPlanProvided = typeof object.metadata?.plan === 'string'
      && object.metadata.plan.length > 0;
    const metadataPlan = stripePaidPlan(object.metadata?.plan);
    const payment = object.id && prisma.payment?.findFirst
      ? await prisma.payment.findFirst({ where: { stripeSessionId: object.id } })
      : null;
    const userId = metadataUserId || payment?.userId || null;
    let user = userId
      ? await prisma.user.findUnique({ where: { id: userId } })
      : null;
    const customerId = stripeResourceId(object.customer);
    if (!user && customerId) {
      user = await prisma.user.findUnique({ where: { stripeCustomerId: customerId } });
    }

    return {
      event,
      object,
      user,
      userId: user?.id || userId,
      plan: stripePaidPlan(payment?.plan),
      payment,
      customerId,
      metadataUserId,
      metadataPlan,
      metadataPlanProvided,
      subscriptionId: stripeResourceId(object.subscription),
      subscription: null,
    };
  }

  const customerId = stripeResourceId(object.customer);
  const user = customerId
    ? await prisma.user.findUnique({ where: { stripeCustomerId: customerId } })
    : null;

  return {
    event,
    object,
    user,
    userId: user?.id || null,
    plan: null,
    payment: null,
    customerId,
    subscriptionId: event.type.startsWith('invoice.')
      ? stripeInvoiceSubscriptionId(object)
      : stripeResourceId(object),
    subscription: event.type.startsWith('invoice.')
      ? (
        typeof object?.parent?.subscription_details?.subscription === 'object'
          ? object.parent.subscription_details.subscription
          : (typeof object.subscription === 'object' ? object.subscription : null)
      )
      : null,
  };
}

function stripeSubscriptionStateRetrievalEnabled(options = {}) {
  if (typeof options.retrieveSubscriptionState === 'boolean') {
    return options.retrieveSubscriptionState;
  }
  return /^(?:1|true|on)$/iu.test(
    String(process.env.STRIPE_WEBHOOK_RETRIEVE_SUBSCRIPTION_STATE || ''),
  );
}

async function hydrateStripeWebhookContext(context, options = {}) {
  if (
    stripeSubscriptionStateRetrievalEnabled(options)
    && context.event.type === 'invoice.payment_succeeded'
    && context.subscriptionId
    && (!context.subscription?.status || !context.subscription?.current_period_end)
  ) {
    return {
      ...context,
      subscription: await stripeService.retrieveSubscription(context.subscriptionId),
    };
  }
  return context;
}

function canonicalStripeEventData(event, context) {
  const object = context.object;
  const common = {
    stripeEventType: event.type,
    objectId: stripeResourceId(object) || null,
    customerId: context.customerId || null,
  };

  switch (event.type) {
    case 'checkout.session.completed':
      return {
        ...common,
        sessionId: object.id || null,
        subscriptionId: context.subscriptionId,
        plan: context.plan,
        paymentStatus: object.payment_status || null,
      };
    case 'invoice.payment_succeeded':
      return {
        ...common,
        invoiceId: object.id || null,
        subscriptionId: context.subscriptionId,
        amount: Number(object.amount_paid || 0) / 100,
        currency: object.currency || null,
        billingReason: object.billing_reason || null,
      };
    case 'invoice.payment_failed':
      return {
        ...common,
        invoiceId: object.id || null,
        subscriptionId: context.subscriptionId,
        amount: Number(object.amount_due || 0) / 100,
        currency: object.currency || null,
        billingReason: object.billing_reason || null,
        reason: object.last_finalization_error?.message || 'Payment declined',
      };
    default:
      return {
        ...common,
        subscriptionId: context.subscriptionId,
        status: projectedStripeSubscriptionStatus(object),
        currentPeriodEnd: object.current_period_end || null,
        endedAt: object.ended_at || null,
      };
  }
}

function stripeEffect(event, type, payload, { required = false } = {}) {
  return {
    key: `stripe:${event.id}:${type}`,
    type,
    required: required === true,
    status: 'pending',
    attempts: 0,
    payload: serializeBigIntFields(payload),
  };
}

function buildStripeWebhookEffects(event, context, outcome = null) {
  const { object, user } = context;

  if (event.type === 'checkout.session.completed') {
    const planned = outcome
      ? outcome.kind === 'checkout' && outcome.granted
      : checkoutValidation(context).ok;
    if (!planned) return [];
    return [stripeEffect(event, 'posthog.plan_upgraded', {
      distinctId: user.id,
      event: 'plan.upgraded',
      properties: {
        plan: outcome?.plan || context.plan,
        previous_plan: outcome?.previousPlan ?? user.plan ?? null,
        monthly_limit: Number(outcome?.updatedUser?.monthlyLimit || user.monthlyLimit || 0),
        added_credits: Number(outcome?.addedCredits || 0),
        stripe_session_id: object.id,
        stripe_event_id: event.id,
        $insert_id: event.id,
        source: 'stripe.checkout.session.completed',
      },
    })];
  }

  if (event.type === 'invoice.payment_succeeded') {
    const renewal = outcome
      ? outcome.kind === 'invoice_succeeded' && outcome.subscriptionRenewal
      : Boolean(context.subscriptionId);
    if (!renewal) return [];
    return [stripeEffect(event, 'trigger.payment_succeeded', {
      invoiceId: object.id,
      amount: Number(object.amount_paid || 0) / 100,
      currency: object.currency,
      stripeEventId: event.id,
      idempotencyKey: `stripe:${event.id}:payment_succeeded`,
    })];
  }

  if (event.type !== 'invoice.payment_failed') return [];
  const failedRenewal = outcome
    ? outcome.kind === 'invoice_failed'
      && outcome.subscriptionRenewal
      && outcome.disposition === 'applied'
    : Boolean(context.subscriptionId);
  if (!failedRenewal) return [];
  const amount = Number(object.amount_due || 0) / 100;
  return [
    stripeEffect(event, 'email.payment_failed', {
      amount,
      currency: object.currency,
      nextRetry: 'Within 24 hours',
      stripeEventId: event.id,
      idempotencyKey: event.id,
    }),
    stripeEffect(event, 'trigger.payment_failed', {
      invoiceId: object.id,
      amount,
      reason: object.last_finalization_error?.message || 'Payment declined',
      stripeEventId: event.id,
      idempotencyKey: `stripe:${event.id}:payment_failed`,
      skipInbox: true,
    }),
  ];
}

function initialStripeEventData(event, context) {
  return serializeBigIntFields({
    ...canonicalStripeEventData(event, context),
    eventCreated: stripeEventCreated(event),
    processing: {
      disposition: 'pending',
      reason: null,
    },
    outbox: {
      version: STRIPE_WEBHOOK_OUTBOX_VERSION,
      effects: buildStripeWebhookEffects(event, context),
    },
  });
}

function canonicalStripeEventRecord(event, context) {
  let newPlan = context.user?.plan || null;
  if (event.type === 'checkout.session.completed') newPlan = context.plan;
  if (event.type === 'customer.subscription.deleted') newPlan = 'FREE';

  return {
    userId: context.user.id,
    eventType: STRIPE_WEBHOOK_EVENT_TYPES[event.type],
    previousPlan: context.user.plan || null,
    newPlan: newPlan || null,
    eventData: initialStripeEventData(event, context),
    // This is Stripe's Event identifier (`evt_*`), never a checkout,
    // invoice, customer, or subscription resource identifier.
    stripeEventId: event.id,
  };
}

function finalStripeEventData(event, context, outcome) {
  return serializeBigIntFields({
    ...canonicalStripeEventData(event, context),
    eventCreated: stripeEventCreated(event),
    processing: {
      disposition: outcome.disposition || 'applied',
      reason: outcome.reason || null,
    },
    outbox: {
      version: STRIPE_WEBHOOK_OUTBOX_VERSION,
      effects: buildStripeWebhookEffects(event, context, outcome),
    },
  });
}

function finalStripeEventPlan(context, outcome) {
  if (outcome.kind === 'checkout' && outcome.granted) return outcome.plan;
  if (outcome.kind === 'subscription_deleted' && outcome.disposition === 'applied') return 'FREE';
  return outcome.currentPlan || context.user.plan || null;
}

async function syncStripeInvoiceInTransaction(tx, invoice, user) {
  const result = await syncInvoiceFromStripe(tx, invoice, { user });
  if (result?.ok) return result;
  const error = new Error(`Stripe invoice sync failed: ${result?.reason || 'unknown'}`);
  error.code = 'STRIPE_INVOICE_SYNC_FAILED';
  throw error;
}

async function lockStripeWebhookUser(tx, userId) {
  if (typeof tx.$queryRawUnsafe !== 'function') return;
  // Static SQL + a bound parameter: the verified Stripe/user identifier is
  // never interpolated into the query text. NO KEY UPDATE serializes all
  // billing mutations for a user while remaining compatible with the KEY
  // SHARE lock PostgreSQL takes for SubscriptionEvent's userId foreign key.
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "users" WHERE "id" = $1 FOR NO KEY UPDATE',
    userId,
  );
}

async function lockStripePayment(tx, paymentId) {
  if (typeof tx.$queryRawUnsafe !== 'function') return;
  // Static SQL with a bound immutable payment ID; never interpolate request
  // input into lock statements.
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "payments" WHERE "id" = $1 FOR UPDATE',
    paymentId,
  );
}

function stripeEntitlementPrecedence(eventType) {
  return STRIPE_ENTITLEMENT_PRECEDENCE[eventType] || 0;
}

function stripeEntitlementMatchesScope(entitlement, scope = {}) {
  const subscriptionId = stripeResourceId(scope.subscriptionId);
  const sessionId = stripeResourceId(scope.sessionId);
  return Boolean(
    (subscriptionId && entitlement.subscriptionId === subscriptionId)
    || (sessionId && entitlement.sessionId === sessionId),
  );
}

function latestAppliedStripeEntitlement(priorEvents, scope) {
  // Stripe event IDs are opaque identifiers, not sequence numbers. `created`
  // remains the primary order; equal-second lifecycle events use only the
  // explicit domain precedence declared above.
  let latest = null;
  for (const prior of priorEvents) {
    const data = prior?.eventData;
    if (!data || typeof data !== 'object') continue;
    const disposition = data.processing?.disposition;
    if (disposition && disposition !== 'applied') continue;
    const created = Number(data.eventCreated);
    if (!Number.isFinite(created) || created <= 0) continue;
    const precedence = stripeEntitlementPrecedence(
      data.stripeEventType || prior.eventType,
    );
    const eventType = data.stripeEventType || prior.eventType;
    const isCheckout = eventType === 'checkout.session.completed'
      || eventType === 'checkout_completed';
    const candidate = {
      created,
      precedence,
      eventType,
      status: data.status || null,
      subscriptionId: stripeResourceId(
        data.subscriptionId || (!isCheckout ? data.objectId : null),
      ),
      sessionId: stripeResourceId(
        data.sessionId || (isCheckout ? data.objectId : null),
      ),
    };
    if (!stripeEntitlementMatchesScope(candidate, scope)) continue;
    // Equal-second/equal-kind records have no sequence signal. Prefer the
    // access-revoking semantic state, never an opaque Stripe event ID.
    const terminalTieBreak = latest
      && created === latest.created
      && precedence === latest.precedence
      && stripeEntitlementIsTerminal(candidate)
      && !stripeEntitlementIsTerminal(latest);
    if (
      !latest
      || created > latest.created
      || (created === latest.created && precedence > latest.precedence)
      || terminalTieBreak
    ) {
      latest = candidate;
    }
  }
  return latest;
}

function terminalStripeEntitlementStatus(value) {
  return STRIPE_TERMINAL_ENTITLEMENT_STATUSES.has(
    String(value || '').trim().toLowerCase(),
  );
}

function stripeEntitlementIsTerminal(entitlement) {
  if (!entitlement) return false;
  if (stripeEntitlementPrecedence(entitlement.eventType) >= 3) return true;
  return terminalStripeEntitlementStatus(entitlement.status);
}

function checkoutEntitlementDecision(event, fence) {
  const latest = fence?.latestEntitlement || null;
  const latestOrder = latest
    ? { created: latest.created, precedence: latest.precedence }
    : null;
  const terminalIsNewer = stripeEntitlementIsTerminal(latest)
    && (
      !stripeEventCreated(event)
      || stripeOrderIsBehind(event, latestOrder)
    );
  const currentIsTerminal = fence?.currentSubscriptionMatches === true
    && terminalStripeEntitlementStatus(fence?.currentUser?.subscriptionStatus);
  const terminalWithoutOrderEvidence = currentIsTerminal
    && (
      !latest
      || !stripeEntitlementIsTerminal(latest)
      || !stripeEventCreated(event)
    );

  if (terminalIsNewer || terminalWithoutOrderEvidence) {
    return {
      grantEntitlement: false,
      reactivateSubscription: false,
      reason: 'newer_terminal_entitlement',
    };
  }
  return {
    grantEntitlement: true,
    reactivateSubscription: !fence?.reason,
    reason: null,
  };
}

function stripeOrderIsBehind(event, latestOrder) {
  if (!latestOrder) return false;
  const incomingCreated = stripeEventCreated(event);
  const incomingPrecedence = stripeEntitlementPrecedence(event.type);
  return latestOrder.created > incomingCreated
    || (
      latestOrder.created === incomingCreated
      && latestOrder.precedence > incomingPrecedence
    );
}

async function latestStripeEntitlementForUser(tx, userId, options = {}) {
  if (typeof tx.subscriptionEvent?.findMany !== 'function') return null;
  const {
    subscriptionId = null,
    sessionId = null,
    excludeStripeEventId = null,
  } = options;
  const priorEvents = await tx.subscriptionEvent.findMany({
    where: {
      userId,
      ...(excludeStripeEventId
        ? { stripeEventId: { not: excludeStripeEventId } }
        : {}),
      eventType: { in: STRIPE_ENTITLEMENT_EVENT_TYPES },
    },
    select: { eventType: true, eventData: true },
  });
  return latestAppliedStripeEntitlement(priorEvents, {
    subscriptionId,
    sessionId,
  });
}

async function subscriptionFence(tx, event, context) {
  const currentUser = await tx.user.findUnique({ where: { id: context.user.id } });
  if (!currentUser) {
    return { reason: 'user_not_found', currentUser: context.user };
  }
  const subscriptionId = stripeResourceId(context.subscriptionId);
  const sessionId = event.type === 'checkout.session.completed'
    ? stripeResourceId(context.object)
    : null;
  const currentSubscriptionMatches = Boolean(
    subscriptionId
    && stripeResourceId(currentUser.stripeSubscriptionId) === subscriptionId,
  );
  let latestEntitlement;
  if (event.type === 'checkout.session.completed') {
    latestEntitlement = await latestStripeEntitlementForUser(
      tx,
      context.user.id,
      {
        subscriptionId,
        sessionId,
        excludeStripeEventId: event.id,
      },
    );
  }
  if (!subscriptionId) {
    return {
      reason: 'subscription_id_missing',
      currentUser,
      latestEntitlement,
      currentSubscriptionMatches,
    };
  }

  const mayReplaceSubscription = event.type === 'checkout.session.completed'
    || event.type === 'customer.subscription.created';
  if (
    !mayReplaceSubscription
    && stripeResourceId(currentUser.stripeSubscriptionId) !== subscriptionId
  ) {
    return {
      reason: 'subscription_id_mismatch',
      currentUser,
      latestEntitlement,
      currentSubscriptionMatches,
    };
  }

  const incomingCreated = stripeEventCreated(event);
  if (!incomingCreated) {
    return {
      reason: 'event_created_missing',
      currentUser,
      latestEntitlement,
      currentSubscriptionMatches,
    };
  }

  if (latestEntitlement === undefined) {
    latestEntitlement = await latestStripeEntitlementForUser(
      tx,
      context.user.id,
      {
        subscriptionId,
        sessionId,
        excludeStripeEventId: event.id,
      },
    );
  }
  const latestOrder = latestEntitlement
    ? {
      created: latestEntitlement.created,
      precedence: latestEntitlement.precedence,
    }
    : null;
  return {
    reason: stripeOrderIsBehind(event, latestOrder) ? 'event_out_of_order' : null,
    currentUser,
    latestEntitlement,
    currentSubscriptionMatches,
  };
}

async function invoiceFence(tx, event, context, invoiceSync) {
  const currentUser = await tx.user.findUnique({ where: { id: context.user.id } });
  if (!currentUser) {
    return { reason: 'user_not_found', currentUser: context.user };
  }
  const subscriptionId = stripeResourceId(context.subscriptionId);
  const invoiceId = stripeResourceId(context.object);
  if (!invoiceId) return { reason: 'invoice_id_missing', currentUser };
  if (!subscriptionId) return { reason: 'subscription_id_missing', currentUser };
  if (stripeResourceId(currentUser.stripeSubscriptionId) !== subscriptionId) {
    return { reason: 'subscription_id_mismatch', currentUser };
  }
  if (
    event.type === 'invoice.payment_failed'
    && invoiceSync?.authoritativeStatus === 'PAID'
  ) {
    return { reason: 'invoice_status_regression', currentUser };
  }
  return {
    reason: null,
    currentUser,
  };
}

async function applyStripeWebhookTransaction(tx, event, context) {
  const { object, user } = context;

  switch (event.type) {
    case 'checkout.session.completed': {
      const initialValidation = checkoutValidation(context);
      if (!initialValidation.ok) {
        return {
          kind: 'checkout',
          granted: false,
          disposition: 'no_op',
          reason: initialValidation.reason,
        };
      }
      const durablePayment = await tx.payment.findFirst({
        where: { id: context.payment.id },
      });
      const validation = checkoutValidation(context, durablePayment);
      if (!validation.ok) {
        return {
          kind: 'checkout',
          granted: false,
          disposition: 'no_op',
          reason: validation.reason,
        };
      }
      if (durablePayment.status === 'COMPLETED') {
        return {
          kind: 'checkout',
          granted: false,
          alreadyCompleted: true,
          disposition: 'no_op',
          reason: 'checkout_payment_already_completed',
        };
      }
      if (durablePayment.status !== 'PENDING') {
        return {
          kind: 'checkout',
          granted: false,
          disposition: 'no_op',
          reason: 'checkout_payment_not_pending',
        };
      }
      const fence = await subscriptionFence(tx, event, context);
      const entitlementDecision = checkoutEntitlementDecision(event, fence);

      const claim = await tx.payment.updateMany({
        where: {
          id: durablePayment.id,
          stripeSessionId: object.id,
          stripeCustomerId: context.customerId,
          userId: user.id,
          plan: validation.plan,
          status: 'PENDING',
        },
        data: {
          status: 'COMPLETED',
          stripeSubscriptionId: context.subscriptionId,
        },
      });

      if (claim.count === 0) {
        return {
          kind: 'checkout',
          granted: false,
          disposition: 'no_op',
          reason: 'checkout_payment_claim_lost',
        };
      }

      if (!entitlementDecision.grantEntitlement) {
        return {
          kind: 'checkout',
          paymentFulfilled: true,
          granted: false,
          currentPlan: fence.currentUser.plan,
          plan: validation.plan,
          disposition: 'accounting_only',
          reason: entitlementDecision.reason,
        };
      }

      const addedCredits = premiumCreditsForPlan(validation.plan);
      const entitlementData = {
        plan: validation.plan,
        monthlyLimit: { increment: addedCredits },
        gemaTokenLimit: { increment: gemaLimitForPlan(validation.plan) },
        stripeSubscriptionId: context.subscriptionId,
      };
      // Payment fulfillment is authoritative once the paid checkout identity
      // is validated and claimed. Non-terminal ordering fences suppress only
      // the status projection; a newer terminal entitlement suppresses this
      // entire grant in the accounting-only branch above.
      if (entitlementDecision.reactivateSubscription) {
        entitlementData.subscriptionStatus = 'active';
        entitlementData.subscriptionEndDate = null;
      }
      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: entitlementData,
      });
      return {
        kind: 'checkout',
        granted: true,
        previousPlan: fence.currentUser.plan || null,
        updatedUser,
        addedCredits,
        plan: validation.plan,
        subscriptionStatusApplied: entitlementDecision.reactivateSubscription,
        subscriptionStatusReason: fence.reason || null,
        disposition: 'applied',
      };
    }

    case 'invoice.payment_succeeded': {
      const invoiceId = stripeResourceId(object);
      if (!invoiceId) {
        return {
          kind: 'invoice_succeeded',
          subscriptionRenewal: false,
          disposition: 'no_op',
          reason: 'invoice_id_missing',
        };
      }
      // Mirror every valid invoice before deciding whether it is eligible to
      // affect the active entitlement. The SQL upsert owns monotonic PAID state.
      const invoiceSync = await syncStripeInvoiceInTransaction(tx, object, user);
      if (object.billing_reason !== STRIPE_SUBSCRIPTION_CYCLE_BILLING_REASON) {
        return {
          kind: 'invoice_succeeded',
          subscriptionRenewal: false,
          disposition: 'no_op',
          reason: 'invoice_not_subscription_cycle',
        };
      }
      const fence = await invoiceFence(tx, event, context, invoiceSync);
      if (fence.reason) {
        return {
          kind: 'invoice_succeeded',
          subscriptionRenewal: false,
          disposition: 'no_op',
          reason: fence.reason,
          currentPlan: fence.currentUser.plan,
        };
      }

      await tx.user.update({
        where: { id: user.id },
        data: {
          apiUsage: 0,
          monthlyCallLimit: 0,
        },
      });
      await tx.usageAlert.deleteMany({
        where: {
          userId: user.id,
          sentAt: { lt: currentMonthStartUtcForStripeWebhook() },
        },
      });
      return {
        kind: 'invoice_succeeded',
        subscriptionRenewal: true,
        disposition: 'applied',
      };
    }

    case 'invoice.payment_failed': {
      const invoiceId = stripeResourceId(object);
      if (!invoiceId) {
        return {
          kind: 'invoice_failed',
          subscriptionRenewal: false,
          disposition: 'no_op',
          reason: 'invoice_id_missing',
        };
      }
      // Do not drop history for old subscriptions or non-cycle invoices. A
      // rejected OPEN write reports authoritative PAID state to the fence below.
      const invoiceSync = await syncStripeInvoiceInTransaction(tx, object, user);
      if (object.billing_reason !== STRIPE_SUBSCRIPTION_CYCLE_BILLING_REASON) {
        return {
          kind: 'invoice_failed',
          subscriptionRenewal: false,
          disposition: 'no_op',
          reason: 'invoice_not_subscription_cycle',
        };
      }
      const fence = await invoiceFence(tx, event, context, invoiceSync);
      if (fence.reason) {
        return {
          kind: 'invoice_failed',
          subscriptionRenewal: false,
          disposition: 'no_op',
          reason: fence.reason,
          currentPlan: fence.currentUser.plan,
        };
      }

      const amountDue = Number(object.amount_due || 0) / 100;
      await tx.notification.create({
        data: {
          userId: user.id,
          type: 'payment_failed',
          title: 'Payment Failed',
          message: `Your payment of $${amountDue} could not be processed. We'll retry automatically.`,
          severity: 'warning',
          metadata: serializeBigIntFields({
            invoiceId: object.id,
            amount: amountDue,
            stripeEventId: event.id,
            idempotencyKey: `stripe:${event.id}:payment_failed`,
          }),
        },
      });
      return {
        kind: 'invoice_failed',
        amountDue,
        subscriptionRenewal: true,
        disposition: 'applied',
      };
    }

    case 'customer.subscription.created': {
      const fence = await subscriptionFence(tx, event, context);
      if (fence.reason) {
        return {
          kind: 'subscription_created',
          disposition: 'stale',
          reason: fence.reason,
          currentPlan: fence.currentUser.plan,
        };
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          stripeSubscriptionId: context.subscriptionId,
          subscriptionStatus: projectedStripeSubscriptionStatus(object),
          subscriptionEndDate: toDateFromUnix(object.current_period_end),
        },
      });
      return {
        kind: 'subscription_created',
        disposition: 'applied',
        currentPlan: fence.currentUser.plan,
      };
    }

    case 'customer.subscription.updated': {
      const fence = await subscriptionFence(tx, event, context);
      if (fence.reason) {
        return {
          kind: 'subscription_updated',
          disposition: 'stale',
          reason: fence.reason,
          currentPlan: fence.currentUser.plan,
        };
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          subscriptionStatus: projectedStripeSubscriptionStatus(object),
          subscriptionEndDate: toDateFromUnix(object.current_period_end),
        },
      });
      return {
        kind: 'subscription_updated',
        disposition: 'applied',
        currentPlan: fence.currentUser.plan,
      };
    }

    case 'customer.subscription.deleted': {
      const fence = await subscriptionFence(tx, event, context);
      if (fence.reason) {
        return {
          kind: 'subscription_deleted',
          disposition: 'stale',
          reason: fence.reason,
          currentPlan: fence.currentUser.plan,
        };
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          plan: 'FREE',
          monthlyLimit: 1000n,
          monthlyCallLimit: 3,
          subscriptionStatus: 'canceled',
          subscriptionEndDate: toDateFromUnix(object.ended_at),
        },
      });
      return { kind: 'subscription_deleted', disposition: 'applied' };
    }

    default:
      throw new Error(`Unsupported Stripe webhook event: ${event.type}`);
  }
}

async function isCommittedStripeEventDuplicate(error, stripeEventId) {
  if (error?.code !== 'P2002') return false;

  // Do not classify an unrelated unique violation as a duplicate delivery.
  // Querying the exact event ID also handles Prisma connector differences in
  // P2002 `meta.target` shape.
  const existing = await prisma.subscriptionEvent.findUnique({
    where: { stripeEventId },
    select: { id: true },
  });
  return Boolean(existing);
}

async function compareAndSwapStripeEventData(row, eventData) {
  return prisma.subscriptionEvent.updateMany({
    where: {
      id: row.id,
      eventData: { equals: row.eventData },
    },
    data: { eventData: serializeBigIntFields(eventData) },
  });
}

function stripeEffectRetryOptions(options = {}) {
  const config = resolveStripeWebhookRecoveryConfig(process.env);
  const maxAttempts = Number.isFinite(Number(options.maxAttempts))
    ? Math.min(25, Math.max(1, Math.trunc(Number(options.maxAttempts))))
    : config.maxAttempts;
  const backoffBaseMs = Number.isFinite(Number(options.backoffBaseMs))
    ? Math.min(60 * 60 * 1000, Math.max(1_000, Math.trunc(Number(options.backoffBaseMs))))
    : config.backoffBaseMs;
  const configuredMax = Number.isFinite(Number(options.backoffMaxMs))
    ? Math.min(24 * 60 * 60 * 1000, Math.max(1_000, Math.trunc(Number(options.backoffMaxMs))))
    : config.backoffMaxMs;
  return {
    maxAttempts,
    backoffBaseMs,
    backoffMaxMs: Math.max(backoffBaseMs, configuredMax),
    respectBackoff: options.respectBackoff === true,
    now: typeof options.now === 'function' ? options.now : Date.now,
  };
}

function stripeEffectBackoffMs(attempts, options) {
  const exponent = Math.max(0, Math.min(20, Number(attempts || 1) - 1));
  return Math.min(options.backoffMaxMs, options.backoffBaseMs * (2 ** exponent));
}

async function claimNextStripeEffect(stripeEventId, rawOptions = {}) {
  const options = stripeEffectRetryOptions(rawOptions);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const row = await prisma.subscriptionEvent.findUnique({
      where: { stripeEventId },
      select: { id: true, userId: true, stripeEventId: true, eventData: true },
    });
    if (!row) return null;
    const effects = row.eventData?.outbox?.effects;
    if (!Array.isArray(effects) || effects.length === 0) return null;

    const nowMs = Number(options.now());
    let nextIndex = -1;
    let exhaustedIndex = -1;
    let nextDeferredAt = null;
    let hasBusyEffect = false;
    for (let index = 0; index < effects.length; index += 1) {
      const effect = effects[index];
      if (effect.status !== 'pending' && effect.status !== 'processing') continue;
      const leaseUntilMs = Date.parse(effect.leaseUntil || '');
      if (effect.status === 'processing' && leaseUntilMs > nowMs) {
        hasBusyEffect = true;
        if (!nextDeferredAt || leaseUntilMs < Date.parse(nextDeferredAt)) {
          nextDeferredAt = effect.leaseUntil;
        }
        continue;
      }
      if (Number(effect.attempts || 0) >= options.maxAttempts) {
        exhaustedIndex = index;
        break;
      }
      const nextAttemptMs = Date.parse(effect.nextAttemptAt || '');
      if (
        options.respectBackoff
        && effect.status === 'pending'
        && nextAttemptMs > nowMs
      ) {
        if (!nextDeferredAt || nextAttemptMs < Date.parse(nextDeferredAt)) {
          nextDeferredAt = effect.nextAttemptAt;
        }
        continue;
      }
      nextIndex = index;
      break;
    }
    if (exhaustedIndex >= 0) {
      const exhaustedData = structuredClone(row.eventData);
      exhaustedData.outbox.effects[exhaustedIndex] = {
        ...exhaustedData.outbox.effects[exhaustedIndex],
        status: 'failed',
        nextAttemptAt: null,
        claimToken: null,
        leaseUntil: null,
        lastError: exhaustedData.outbox.effects[exhaustedIndex].lastError
          || 'max_attempts_exhausted',
      };
      const exhausted = await compareAndSwapStripeEventData(row, exhaustedData);
      if (exhausted.count === 1) continue;
      continue;
    }
    if (nextIndex < 0) {
      if (options.respectBackoff && nextDeferredAt) {
        return { deferred: true, nextAttemptAt: nextDeferredAt };
      }
      if (hasBusyEffect) return { busy: true };
      return null;
    }

    const claimToken = randomUUID();
    const nextData = structuredClone(row.eventData);
    nextData.outbox.effects[nextIndex] = {
      ...nextData.outbox.effects[nextIndex],
      status: 'processing',
      attempts: Number(nextData.outbox.effects[nextIndex].attempts || 0) + 1,
      claimToken,
      startedAt: new Date(nowMs).toISOString(),
      leaseUntil: new Date(nowMs + STRIPE_EFFECT_LEASE_MS).toISOString(),
      nextAttemptAt: null,
      lastError: null,
    };
    const claimed = await compareAndSwapStripeEventData(row, nextData);
    if (claimed.count === 1) {
      return {
        row: { ...row, eventData: nextData },
        effect: nextData.outbox.effects[nextIndex],
        claimToken,
      };
    }
  }
  const error = new Error(`Could not claim Stripe webhook effect for ${stripeEventId}`);
  error.code = 'STRIPE_EFFECT_CLAIM_CONTENTION';
  throw error;
}

async function updateClaimedStripeEffect(
  claim,
  status,
  error = null,
  rawOptions = {},
  deliveryResult = null,
) {
  const options = stripeEffectRetryOptions(rawOptions);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const row = await prisma.subscriptionEvent.findUnique({
      where: { stripeEventId: claim.row.stripeEventId || claim.effect.payload?.stripeEventId },
      select: { id: true, userId: true, stripeEventId: true, eventData: true },
    });
    if (!row) throw new Error('Stripe webhook event disappeared while completing an effect');
    const effects = row.eventData?.outbox?.effects;
    const index = Array.isArray(effects)
      ? effects.findIndex((effect) => effect.key === claim.effect.key)
      : -1;
    if (index < 0) throw new Error(`Stripe webhook effect ${claim.effect.key} disappeared`);
    const current = effects[index];
    if (current.status === 'completed' && status === 'completed') return;
    if (current.claimToken !== claim.claimToken) return;

    const nextData = structuredClone(row.eventData);
    const nowMs = Number(options.now());
    const exhausted = status === 'pending'
      && Number(current.attempts || 0) >= options.maxAttempts;
    const nextStatus = exhausted ? 'failed' : status;
    nextData.outbox.effects[index] = {
      ...nextData.outbox.effects[index],
      status: nextStatus,
      claimToken: null,
      leaseUntil: null,
      ...(nextStatus === 'completed'
        ? {
          completedAt: new Date(nowMs).toISOString(),
          nextAttemptAt: null,
          lastError: null,
          completion: {
            outcome: deliveryResult?.skipped ? 'skipped' : 'succeeded',
            reason: deliveryResult?.skipped || null,
          },
        }
        : {
          startedAt: null,
          nextAttemptAt: nextStatus === 'failed'
            ? null
            : new Date(
              nowMs + stripeEffectBackoffMs(current.attempts, options),
            ).toISOString(),
          lastError: String(redactErrorMessage(error) || 'effect_failed').slice(0, 500),
          lastFailedAt: new Date(nowMs).toISOString(),
          completion: null,
        }),
    };
    const updated = await compareAndSwapStripeEventData(row, nextData);
    if (updated.count === 1) return;
  }
  const stateError = new Error(`Could not persist Stripe effect state for ${claim.effect.key}`);
  stateError.code = 'STRIPE_EFFECT_STATE_CONTENTION';
  throw stateError;
}

function stripeEffectDeliveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertTriggerPublishSucceeded(result, effectType) {
  if (!result || !Array.isArray(result.errors)) {
    throw stripeEffectDeliveryError(
      'STRIPE_EFFECT_TRIGGER_RESULT_INVALID',
      `${effectType} did not return an explicit trigger-registry result`,
    );
  }
  if (result.errors.length > 0) {
    const details = result.errors
      .map((entry) => entry?.message || entry?.stage || String(entry))
      .filter(Boolean)
      .join('; ');
    throw stripeEffectDeliveryError(
      'STRIPE_EFFECT_TRIGGER_DELIVERY_FAILED',
      `${effectType} delivery failed${details ? `: ${details}` : ''}`,
    );
  }
  return result.dispatched === 0
    ? { ok: true, skipped: 'no_configured_integrations' }
    : { ok: true };
}

function assertEmailDeliverySucceeded(result) {
  if (
    !result
    || result === false
    || result.error
    || (result.ok !== true && result.success !== true)
  ) {
    const details = result?.error || result?.message || 'email service returned no explicit success';
    throw stripeEffectDeliveryError(
      'STRIPE_EFFECT_EMAIL_DELIVERY_FAILED',
      `email.payment_failed delivery failed: ${details}`,
    );
  }
  return { ok: true };
}

async function executeStripeEffect(claim) {
  const { effect, row } = claim;
  switch (effect.type) {
    case 'posthog.plan_upgraded': {
      const posthogStatus = typeof getPostHogStatus === 'function'
        ? getPostHogStatus()
        : { configured: true, requested: true };
      if (!posthogStatus?.configured || posthogStatus.requested === false) {
        if (effect.required) {
          throw stripeEffectDeliveryError(
            'STRIPE_EFFECT_POSTHOG_NOT_CONFIGURED',
            'posthog.plan_upgraded requires a configured PostHog integration',
          );
        }
        return {
          ok: true,
          skipped: posthogStatus?.configured
            ? 'posthog_disabled'
            : 'posthog_not_configured',
        };
      }
      const queued = capturePostHogEvent(effect.payload);
      if (queued !== true) {
        throw stripeEffectDeliveryError(
          'STRIPE_EFFECT_POSTHOG_DELIVERY_FAILED',
          'posthog.plan_upgraded was not explicitly queued',
        );
      }
      return { ok: true };
    }
    case 'trigger.payment_succeeded': {
      const result = await triggers.publish('payment.succeeded', effect.payload, row.userId);
      return assertTriggerPublishSucceeded(result, effect.type);
    }
    case 'trigger.payment_failed': {
      const result = await triggers.publish('payment.failed', effect.payload, row.userId);
      return assertTriggerPublishSucceeded(result, effect.type);
    }
    case 'email.payment_failed': {
      const configured = typeof emailService.isConfigured === 'function'
        ? emailService.isConfigured()
        : emailService.isConfigured;
      if (!configured) {
        if (!effect.required) {
          return { ok: true, skipped: 'email_not_configured' };
        }
        throw stripeEffectDeliveryError(
          'STRIPE_EFFECT_EMAIL_NOT_CONFIGURED',
          'email.payment_failed delivery failed: email service is not configured',
        );
      }
      const user = await prisma.user.findUnique({ where: { id: row.userId } });
      if (!user) {
        throw stripeEffectDeliveryError(
          'STRIPE_EFFECT_EMAIL_USER_NOT_FOUND',
          `email.payment_failed delivery failed: user ${row.userId} was not found`,
        );
      }
      const emailPrefs = require('../services/email-preferences');
      const optIn = await emailPrefs.shouldSendEmail(prisma, user.id, 'billing');
      if (!optIn) return { ok: true, skipped: 'billing_email_opt_out' };
      const result = await emailService.sendPaymentFailureAlert(user, effect.payload);
      return assertEmailDeliverySucceeded(result);
    }
    default: {
      const error = new Error(`Unknown Stripe webhook effect: ${effect.type}`);
      error.code = 'STRIPE_EFFECT_UNKNOWN';
      throw error;
    }
  }
}

async function drainStripeWebhookEffects(stripeEventId, options = {}) {
  const retryOptions = stripeEffectRetryOptions(options);
  const busyDeadline = Number(retryOptions.now()) + STRIPE_EFFECT_BUSY_WAIT_MS;
  let completed = 0;
  let nextAttemptAt = null;
  let firstError = null;
  while (true) {
    const claim = await claimNextStripeEffect(stripeEventId, retryOptions);
    if (!claim || claim.deferred) {
      if (claim?.nextAttemptAt) nextAttemptAt = claim.nextAttemptAt;
      const result = {
        completed,
        deferred: Boolean(nextAttemptAt),
        nextAttemptAt,
      };
      if (firstError) {
        firstError.drainResult = result;
        throw firstError;
      }
      return result;
    }
    if (claim.busy) {
      if (Number(retryOptions.now()) >= busyDeadline) {
        const error = new Error(`Stripe webhook effects are still processing for ${stripeEventId}`);
        error.code = 'STRIPE_EFFECT_IN_PROGRESS';
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    try {
      const result = await executeStripeEffect(claim);
      if (result?.ok !== true) {
        throw stripeEffectDeliveryError(
          'STRIPE_EFFECT_RESULT_NOT_EXPLICIT',
          `${claim.effect.type} did not return explicit success`,
        );
      }
      await updateClaimedStripeEffect(claim, 'completed', null, retryOptions, result);
      completed += 1;
    } catch (error) {
      await updateClaimedStripeEffect(claim, 'pending', error, retryOptions);
      if (!retryOptions.respectBackoff) throw error;
      if (!firstError) firstError = error;
    }
  }
}

function minimalStripeWebhookEvent(event) {
  const object = event?.data?.object || {};
  let minimalObject;
  if (event.type === 'checkout.session.completed') {
    minimalObject = {
      id: stripeResourceId(object),
      customer: stripeResourceId(object.customer),
      subscription: stripeResourceId(object.subscription),
      payment_status: object.payment_status || null,
      metadata: {
        userId: typeof object.metadata?.userId === 'string' ? object.metadata.userId : null,
        plan: stripePaidPlan(object.metadata?.plan),
      },
    };
  } else if (event.type.startsWith('invoice.')) {
    minimalObject = {
      id: stripeResourceId(object),
      customer: stripeResourceId(object.customer),
      billing_reason: object.billing_reason || null,
      parent: {
        type: 'subscription_details',
        subscription_details: {
          subscription: stripeInvoiceSubscriptionId(object),
        },
      },
      status: object.status || null,
      amount_due: Number(object.amount_due || 0),
      amount_paid: Number(object.amount_paid || 0),
      amount_remaining: Number(object.amount_remaining || 0),
      subtotal: Number(object.subtotal || 0),
      total: Number(object.total || 0),
      currency: object.currency || null,
      created: Number(object.created || 0),
      last_finalization_error: object.last_finalization_error?.message
        ? { message: String(object.last_finalization_error.message).slice(0, 300) }
        : null,
    };
  } else {
    minimalObject = {
      id: stripeResourceId(object),
      customer: stripeResourceId(object.customer),
      status: object.status || null,
      current_period_end: Number(object.current_period_end || 0) || null,
      ended_at: Number(object.ended_at || 0) || null,
    };
  }
  return {
    id: event.id,
    type: event.type,
    created: stripeEventCreated(event),
    data: { object: minimalObject },
  };
}

function unresolvedStripeEventKey(stripeEventId) {
  return `${STRIPE_UNRESOLVED_PREFIX}${stripeEventId}`;
}

async function persistUnresolvedStripeEvent(event, context) {
  const key = unresolvedStripeEventKey(event.id);
  const existing = await prisma.systemSettings.findUnique({ where: { key } });
  let previous = null;
  try {
    previous = existing?.value ? JSON.parse(existing.value) : null;
  } catch {
    previous = null;
  }
  const now = new Date().toISOString();
  const value = JSON.stringify({
    version: 1,
    status: 'pending',
    attempts: Number(previous?.attempts || 0) + 1,
    firstSeenAt: previous?.firstSeenAt || now,
    lastAttemptAt: now,
    nextAttemptAt: null,
    leaseToken: null,
    leaseUntil: null,
    lastError: null,
    reason: 'user_not_found',
    identifiers: {
      customerId: context.customerId || null,
      userIdHint: context.userId || null,
    },
    event: minimalStripeWebhookEvent(event),
  });
  await prisma.systemSettings.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

async function markUnresolvedStripeEventResolved(event, userId) {
  const key = unresolvedStripeEventKey(event.id);
  const existing = await prisma.systemSettings.findUnique({ where: { key } });
  if (!existing?.value) return;
  let value;
  try {
    value = JSON.parse(existing.value);
  } catch {
    value = { version: 1, event: minimalStripeWebhookEvent(event) };
  }
  const resolvedAt = new Date().toISOString();
  const nextValue = JSON.stringify({
    ...value,
    status: 'resolved',
    resolvedUserId: userId,
    resolvedAt,
    lastAttemptAt: resolvedAt,
  });
  await prisma.systemSettings.upsert({
    where: { key },
    create: { key, value: nextValue },
    update: { value: nextValue },
  });
}

async function processStripeWebhookEvent(event, options = {}) {
  if (typeof event?.id !== 'string' || !event.id) {
    const error = new Error('Verified Stripe webhook is missing event.id');
    error.code = 'STRIPE_EVENT_ID_REQUIRED';
    throw error;
  }

  // All user resolution is read-only and happens before the transaction.
  let context = await resolveStripeWebhookContext(event);
  if (!context.user) {
    console.error('User not found for Stripe webhook:', {
      eventId: event.id,
      eventType: event.type,
      customerId: context.customerId,
      userId: context.userId,
    });
    if (options.persistUnresolved !== false) {
      await persistUnresolvedStripeEvent(event, context);
    }
    const error = new Error(`Stripe webhook user mapping unresolved for ${event.id}`);
    error.code = 'STRIPE_WEBHOOK_USER_UNRESOLVED';
    throw error;
  }

  // A committed event can short-circuit before any remote Stripe hydration.
  // This is only a fast path; the unique insert below remains the concurrency
  // authority when two fresh deliveries both observe no row here.
  const completed = await prisma.subscriptionEvent.findUnique({
    where: { stripeEventId: event.id },
    select: { id: true, stripeEventId: true },
  });
  if (completed) {
    console.log(`Duplicate Stripe event ${event.id}; retrying pending effects only`);
    await drainStripeWebhookEffects(event.id);
    await markUnresolvedStripeEventResolved(event, context.user.id);
    return { duplicate: true };
  }

  context = await hydrateStripeWebhookContext(context, options);

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // This must be the first lock-bearing statement in every supported event
      // transaction. Inserting SubscriptionEvent first acquires a KEY SHARE
      // lock through its FK; two distinct deliveries could then deadlock while
      // both tried to upgrade to a conflicting user-row lock.
      await lockStripeWebhookUser(tx, context.user.id);
      // The canonical event row is also the durable claim. Its unique
      // stripeEventId serializes concurrent deliveries; every later write is
      // in this transaction, so a failure rolls the claim back for retry.
      const claimedEvent = await tx.subscriptionEvent.create({
        data: canonicalStripeEventRecord(event, context),
      });
      const applied = await applyStripeWebhookTransaction(tx, event, context);
      await tx.subscriptionEvent.update({
        where: { id: claimedEvent.id },
        data: {
          newPlan: finalStripeEventPlan(context, applied),
          eventData: finalStripeEventData(event, context, applied),
        },
      });
      return applied;
    });
  } catch (error) {
    if (await isCommittedStripeEventDuplicate(error, event.id)) {
      console.log(`Duplicate Stripe event ${event.id}; retrying pending effects only`);
      await drainStripeWebhookEffects(event.id);
      await markUnresolvedStripeEventResolved(event, context.user.id);
      return { duplicate: true };
    }
    throw error;
  }

  await drainStripeWebhookEffects(event.id);
  await markUnresolvedStripeEventResolved(event, context.user.id);
  return { duplicate: false, outcome };
}

// Webhook event handlers
async function handleCheckoutSessionCompleted(event) {
  return processStripeWebhookEvent(event);
}

async function handleInvoicePaymentSucceeded(event) {
  return processStripeWebhookEvent(event);
}

async function handleInvoicePaymentFailed(event) {
  return processStripeWebhookEvent(event);
}

async function handleSubscriptionCreated(event) {
  return processStripeWebhookEvent(event);
}

async function handleSubscriptionUpdated(event) {
  return processStripeWebhookEvent(event);
}

async function handleSubscriptionDeleted(event) {
  return processStripeWebhookEvent(event);
}

// Get subscription management info
router.get('/subscription', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let subscriptionInfo = {
      plan: user.plan,
      status: user.subscriptionStatus,
      endDate: user.subscriptionEndDate,
      stripeCustomerId: user.stripeCustomerId
    };

    // If user has a Stripe subscription, get detailed info
    if (user.stripeSubscriptionId) {
      try {
        const subscription = await stripeService.retrieveSubscription(user.stripeSubscriptionId);
        subscriptionInfo = {
          ...subscriptionInfo,
          stripeSubscription: {
            id: subscription.id,
            status: subscription.status,
            currentPeriodEnd: toDateFromUnix(subscription.current_period_end),
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            nextInvoiceDate: subscription.status === 'active' ? toDateFromUnix(subscription.current_period_end) : null
          }
        };
      } catch (error) {
        if (!error?.isStripeOperationalError && !stripeService.isStripeLikeError?.(error)) {
          logRouteError(req, 'payments.subscription.stripe_fetch_failed', error);
        }
      }
    }

    res.json(subscriptionInfo);

  } catch (error) {
    logRouteError(req, 'payments.subscription.fetch_failed', error);
    res.status(500).json({ error: 'Failed to fetch subscription info', requestId: requestIdFor(req) });
  }
});

// Cancel subscription
router.post('/subscription/cancel', subscriptionLimiter, authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user || !user.stripeSubscriptionId) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Cancel at period end
    const subscription = await stripeService.cancelSubscription(user.stripeSubscriptionId);

    // A canceling account remains paid through Stripe's current period end.
    // Persist status + deadline in one write so paid-plan middleware can never
    // observe `canceling` without its matching access boundary. If Stripe
    // returns an invalid/past timestamp, reuse only a trusted future deadline;
    // otherwise preserve the current local status until the webhook reconciles.
    const nowMs = Date.now();
    const stripePeriodEnd = futureDateOrNull(
      toDateFromUnix(subscription.current_period_end),
      nowMs,
    );
    const currentStatus = String(user.subscriptionStatus || '').trim().toLowerCase();
    const currentStatusPreservesPaidAccess = currentStatus === 'active'
      || currentStatus === 'trialing'
      || currentStatus === 'canceling';
    const existingPeriodEnd = currentStatusPreservesPaidAccess
      ? futureDateOrNull(user.subscriptionEndDate, nowMs)
      : null;
    const effectivePeriodEnd = stripePeriodEnd || existingPeriodEnd;
    if (effectivePeriodEnd) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionStatus: 'canceling',
          subscriptionEndDate: effectivePeriodEnd,
        },
      });
    }

    res.json({
      message: 'Subscription will be canceled at the end of the current billing period',
      subscription: {
        id: subscription.id,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        currentPeriodEnd: effectivePeriodEnd,
      }
    });

  } catch (error) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Reactivate subscription
router.post('/subscription/reactivate', subscriptionLimiter, authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user || !user.stripeSubscriptionId) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    // Reactivate subscription
    const subscription = await stripeService.reactivateSubscription(user.stripeSubscriptionId);

    // Update user record
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: subscription.status
      }
    });

    res.json({
      message: 'Subscription reactivated successfully',
      subscription: {
        id: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end
      }
    });

  } catch (error) {
    console.error('Error reactivating subscription:', error);
    res.status(500).json({ error: 'Failed to reactivate subscription' });
  }
});

module.exports = router;
module.exports.INTERNAL = Object.freeze({
  processStripeWebhookEvent,
  drainStripeWebhookEffects,
  minimalStripeWebhookEvent,
});
