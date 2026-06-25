const express = require('express');
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
const { capturePostHogEvent } = require('../services/observability/posthog');
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
      PRO_MAX: 20.00,
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
      
      // If Stripe session is paid and our payment is still pending, update it
      if (session.payment_status === 'paid' && payment.status === 'PENDING') {
        console.log('Payment is successful in Stripe, updating user plan...');
        
        // Update payment status
        await prisma.payment.update({
          where: { id: payment.id },
          data: { 
            status: 'COMPLETED',
            stripeSubscriptionId: session.subscription 
          }
        });

        // Update user subscription - ADD new plan limits to existing monthlyLimit.
        // `monthlyLimit` is BigInt in Prisma — coerce both operands to BigInt
        // before adding. Mixing BigInt+Number throws and silently aborts the
        // handler, leaving the user on FREE after a successful charge.
        const creditsForPlan = premiumCreditsForPlan(payment.plan);

        // Get current user to add to existing limits
        const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
        const currentLimit = typeof currentUser?.monthlyLimit === 'bigint'
          ? currentUser.monthlyLimit
          : BigInt(currentUser?.monthlyLimit ?? 0);
        const newTotalLimit = currentLimit + creditsForPlan;
        const currentGemaLimit = toBigIntSafe(currentUser?.gemaTokenLimit);
        const newGemaLimit = currentGemaLimit + gemaLimitForPlan(payment.plan);

        const updatedUser = await prisma.user.update({
          where: { id: req.user.id },
          data: {
            plan: payment.plan,
            monthlyLimit: newTotalLimit,
            gemaTokenLimit: newGemaLimit,
            stripeSubscriptionId: session.subscription,
            subscriptionStatus: 'active'
            // monthlyCallLimit: NOT UPDATED - preserve current usage
          }
        });

        console.log(`Successfully updated user ${req.user.id} to plan ${payment.plan}`);
        paymentStatus = 'COMPLETED';
      }
    } catch (stripeError) {
      if (!stripeService.demoAllowed || stripeService.isConfigured) {
        return sendStripeError(res, req, stripeError, 'verifyStripeCheckoutSession');
      }

      // In explicit local demo mode (without Stripe keys), simulate successful payment.
      if (payment.status === 'PENDING') {
        console.log('Demo mode: Updating payment and user plan...');
        
        // Update payment status
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'COMPLETED' }
        });

        // Update user subscription - ADD new plan limits to existing monthlyLimit.
        // BigInt-safe: see comment in the Stripe branch above for context.
        const creditsForPlan = premiumCreditsForPlan(payment.plan);

        // Get current user to add to existing limits
        const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
        const currentLimit = typeof currentUser?.monthlyLimit === 'bigint'
          ? currentUser.monthlyLimit
          : BigInt(currentUser?.monthlyLimit ?? 0);
        const newTotalLimit = currentLimit + creditsForPlan;
        const currentGemaLimit = toBigIntSafe(currentUser?.gemaTokenLimit);
        const newGemaLimit = currentGemaLimit + gemaLimitForPlan(payment.plan);

        const updatedUser = await prisma.user.update({
          where: { id: req.user.id },
          data: {
            plan: payment.plan,
            monthlyLimit: newTotalLimit,
            gemaTokenLimit: newGemaLimit,
            subscriptionStatus: 'active'
            // monthlyCallLimit: NOT UPDATED - preserve current usage
          }
        });

        console.log(`Demo mode: Successfully updated user ${req.user.id} to plan ${payment.plan}`);
        paymentStatus = 'COMPLETED';
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

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
        break;
      
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object);
        break;
      
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
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

// Webhook event handlers
async function handleCheckoutSessionCompleted(session) {
  console.log('Processing checkout session completed:', session.id);

  const userId = session.metadata.userId;
  const plan = session.metadata.plan;

  if (!userId || !plan) {
    console.error('Missing metadata in checkout session:', session.id);
    return;
  }

  // `monthlyLimit`/`gemaTokenLimit` are BigInt — coerce before adding (mixing
  // BigInt + Number throws and would abort the grant). The grant is ADDITIVE.
  const creditsForPlan = premiumCreditsForPlan(plan);

  // Claim the payment row (idempotency CAS) AND grant the plan ATOMICALLY.
  // Stripe redelivers webhooks on timeout/retry and may send a duplicate, so
  // only the delivery that flips the row not-COMPLETED → COMPLETED grants; a
  // redelivery finds it COMPLETED and short-circuits. Wrapping the claim and
  // the grant in one transaction is what makes this safe: if the grant throws,
  // the COMPLETED claim rolls back with it, so the row stays claimable and a
  // Stripe retry can re-grant. We deliberately do NOT swallow the error — it
  // propagates to the webhook route's 500 path, the correct retry signal.
  const outcome = await prisma.$transaction(async (tx) => {
    const claim = await tx.payment.updateMany({
      where: {
        stripeSessionId: session.id,
        userId: userId,
        status: { not: 'COMPLETED' }
      },
      data: {
        status: 'COMPLETED',
        stripeSubscriptionId: session.subscription
      }
    });
    if (claim.count === 0) {
      // Already processed (duplicate/redelivery) OR no local payment row.
      // Only short-circuit when a COMPLETED row is actually present — flows
      // without a local payment row keep granting (no regression).
      const alreadyCompleted = await tx.payment.findFirst({
        where: { stripeSessionId: session.id, userId: userId, status: 'COMPLETED' },
        select: { id: true }
      });
      if (alreadyCompleted) return { duplicate: true };
    }

    const currentUser = await tx.user.findUnique({ where: { id: userId } });
    const currentLimit = typeof currentUser?.monthlyLimit === 'bigint'
      ? currentUser.monthlyLimit
      : BigInt(currentUser?.monthlyLimit ?? 0);
    const newTotalLimit = currentLimit + creditsForPlan;
    const newGemaLimit = toBigIntSafe(currentUser?.gemaTokenLimit) + gemaLimitForPlan(plan);

    await tx.user.update({
      where: { id: userId },
      data: {
        plan,
        monthlyLimit: newTotalLimit,
        gemaTokenLimit: newGemaLimit,
        stripeSubscriptionId: session.subscription,
        subscriptionStatus: 'active',
        subscriptionEndDate: null // Let Stripe handle the billing cycle
        // monthlyCallLimit: NOT UPDATED - preserve current usage
      }
    });
    return { duplicate: false, previousPlan: currentUser?.plan || null, newTotalLimit };
  });

  if (outcome.duplicate) {
    console.log(`Duplicate checkout.session.completed for ${session.id}; skipping credit grant`);
    return;
  }

  console.log(`Subscription activated for user ${userId}, plan: ${plan}`);

  // Server-authoritative funnel event (best-effort, after the grant committed).
  // Emitted from the backend — the single source of truth — so a malicious
  // frontend can't spoof a "thank you" without paying.
  capturePostHogEvent({
    distinctId: userId,
    event: 'plan.upgraded',
    properties: {
      plan,
      previous_plan: outcome.previousPlan,
      // BigInt cannot be JSON.stringify'd; credits fit in Number precision.
      monthly_limit: Number(outcome.newTotalLimit),
      added_credits: Number(creditsForPlan),
      stripe_session_id: session.id,
      source: 'stripe.checkout.session.completed',
    },
  });
}

async function handleInvoicePaymentSucceeded(invoice) {
  try {
    if (!invoice?.subscription) {
      // One-off invoice (not tied to a subscription) — nothing to update.
      return;
    }
    const subscription = await stripeService.retrieveSubscription(invoice.subscription);
    const customerId = invoice.customer;

    // Find user by customer ID
    const user = await prisma.user.findUnique({
      where: { stripeCustomerId: customerId }
    });

    if (!user) {
      console.error('User not found for customer:', customerId);
      return;
    }

    // Mirror the invoice locally (spec §8). Best-effort — the billing UI
    // reads from this table but a sync failure must not block the
    // subscription state machine below.
    try {
      const { syncInvoiceFromStripe } = require('../services/invoice-sync');
      await syncInvoiceFromStripe(prisma, invoice, { user });
    } catch (syncErr) {
      console.warn('[invoice-sync] payment_succeeded mirror failed:', syncErr?.message || syncErr);
    }

    // Update subscription status
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: subscription.status,
        subscriptionEndDate: toDateFromUnix(subscription.current_period_end)
      }
    });

    // Reset monthly usage for new billing period
    await usageMonitor.resetMonthlyUsage(user.id);

    // Record subscription event — best-effort and LAST among the critical
    // writes. Kept non-fatal (own try/catch) so a transient audit-row failure
    // can't trigger a Stripe retry that would re-run it and duplicate the row.
    try {
      await prisma.subscriptionEvent.create({
        data: {
          userId: user.id,
          eventType: 'payment_succeeded',
          eventData: serializeBigIntFields({
            invoiceId: invoice.id,
            amount: Number(invoice.amount_paid) / 100,
            currency: invoice.currency
          })
        }
      });
    } catch (evtErr) {
      console.warn('[payments] subscriptionEvent payment_succeeded persist failed:', evtErr?.message || evtErr);
    }

    console.log(`Invoice payment succeeded for user ${user.id}`);

    // Fan out to user-owned webhooks + Slack (best-effort).
    triggers.publish('payment.succeeded', {
      invoiceId: invoice.id,
      amount: Number(invoice.amount_paid) / 100,
      currency: invoice.currency,
    }, user.id).catch((err) => {
      console.warn('[payments] trigger payment.succeeded failed:', err?.message || err);
    });

  } catch (error) {
    // Re-throw so the webhook route returns 500 and Stripe redelivers. The
    // critical writes here (status/period-end update, monthly-usage reset) are
    // idempotent, so a retry is safe and far better than silently leaving a
    // paying user un-renewed after a transient failure (we used to swallow).
    console.error('Error handling invoice payment succeeded:', error);
    throw error;
  }
}

async function handleInvoicePaymentFailed(invoice) {
  try {
    const customerId = invoice.customer;

    // Find user by customer ID
    const user = await prisma.user.findUnique({
      where: { stripeCustomerId: customerId }
    });

    if (user) {
      // Mirror the invoice locally so the billing UI shows the failed
      // attempt with its current status. Best-effort.
      try {
        const { syncInvoiceFromStripe } = require('../services/invoice-sync');
        await syncInvoiceFromStripe(prisma, invoice, { user });
      } catch (syncErr) {
        console.warn('[invoice-sync] payment_failed mirror failed:', syncErr?.message || syncErr);
      }
    }

    if (!user) {
      console.error('User not found for customer:', customerId);
      return;
    }

    // Update subscription status
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: 'past_due'
      }
    });

    const amountDue = Number(invoice.amount_due) / 100;

    // Send payment failure email — fire-and-forget but with a guard.
    // emailService.isConfigured short-circuits when SMTP is unset; we
    // still try/catch so a transient SMTP failure can never bubble up
    // and 500 the Stripe webhook (which would cause Stripe to retry
    // forever and double-create notifications).
    try {
      const configured = typeof emailService.isConfigured === 'function'
        ? emailService.isConfigured()
        : emailService.isConfigured;
      if (configured) {
        // Ratchet 45 — honour User.settings.notifications.billing
        // opt-out. shouldSendEmail degrades gracefully on DB errors
        // (returns true) so we never silently drop a billing email
        // because Prisma hiccupped.
        const emailPrefs = require('../services/email-preferences');
        const optIn = await emailPrefs.shouldSendEmail(prisma, user.id, 'billing');
        if (optIn) {
          await emailService.sendPaymentFailureAlert(user, {
            amount: amountDue,
            currency: invoice.currency,
            nextRetry: 'Within 24 hours',
          });
        }
      }
    } catch (mailErr) {
      console.error('Payment failure email dispatch failed (non-fatal):', mailErr.message);
    }

    // Create in-app notification + record the audit event — both non-idempotent
    // (no unique guard on invoice.id), so each is isolated in its own
    // log-and-continue try/catch. Only the idempotent past_due update above
    // gates the rethrow below, so a Stripe redelivery can't duplicate these.
    try {
      await prisma.notification.create({
        data: {
          userId: user.id,
          type: 'payment_failed',
          title: 'Payment Failed',
          message: `Your payment of $${amountDue} could not be processed. We'll retry automatically.`,
          severity: 'warning',
          metadata: serializeBigIntFields({
            invoiceId: invoice.id,
            amount: amountDue
          })
        }
      });
    } catch (notifErr) {
      console.warn('[payments] payment_failed notification persist failed:', notifErr?.message || notifErr);
    }

    // Record subscription event
    try {
      await prisma.subscriptionEvent.create({
        data: {
          userId: user.id,
          eventType: 'payment_failed',
          eventData: serializeBigIntFields({
            invoiceId: invoice.id,
            amount: amountDue,
            reason: invoice.last_finalization_error?.message || 'Payment declined'
          })
        }
      });
    } catch (evtErr) {
      console.warn('[payments] subscriptionEvent payment_failed persist failed:', evtErr?.message || evtErr);
    }

    console.log(`Invoice payment failed for user ${user.id}`);

    triggers.publish('payment.failed', {
      invoiceId: invoice.id,
      amount: amountDue,
      reason: invoice.last_finalization_error?.message || 'Payment declined',
      // Inbox row already created inline above — skip the trigger-
      // registry's auto-inbox handler so the user doesn't see a
      // duplicate notification.
      skipInbox: true,
    }, user.id).catch((err) => {
      console.warn('[payments] trigger payment.failed failed:', err?.message || err);
    });

  } catch (error) {
    // Re-throw so the webhook returns 500 and Stripe redelivers — the
    // subscriptionStatus='past_due' write is revenue-critical (dunning state)
    // and idempotent. The in-app notification + audit-event writes are isolated
    // above so a retry can't duplicate them.
    console.error('Error handling invoice payment failed:', error);
    throw error;
  }
}

async function handleSubscriptionCreated(subscription) {
  try {
    const customerId = subscription.customer;
    
    // Find user by customer ID
    const user = await prisma.user.findUnique({
      where: { stripeCustomerId: customerId }
    });
    
    if (!user) {
      console.error('User not found for customer:', customerId);
      return;
    }

    // Update user with subscription info
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        subscriptionEndDate: toDateFromUnix(subscription.current_period_end)
      }
    });

    // Send welcome email
    // await emailService.sendWelcomeEmail(updatedUser); // Commented out temporarily
    
    // Record subscription event — best-effort and LAST among the writes. Kept
    // non-fatal (own try/catch) so a transient audit-row failure can't trigger a
    // Stripe retry that would re-run it and duplicate the row; only the
    // idempotent user.update above governs the retry/throw decision below.
    try {
      await prisma.subscriptionEvent.create({
        data: {
          userId: user.id,
          eventType: 'created',
          newPlan: updatedUser.plan,
          eventData: {
            subscriptionId: subscription.id,
            planName: subscription.items.data[0]?.price?.nickname || updatedUser.plan
          },
          stripeEventId: subscription.id
        }
      });
    } catch (evtErr) {
      console.warn('[payments] subscriptionEvent created persist failed:', evtErr?.message || evtErr);
    }

    console.log(`Subscription created for user ${user.id}`);

  } catch (error) {
    // Re-throw so the webhook returns 500 and Stripe redelivers — persisting
    // stripeSubscriptionId is critical (cancel/reactivate/renewal all look the
    // user up by it) and the user.update is idempotent. The audit-row write is
    // isolated above so a retry can't duplicate it.
    console.error('Error handling subscription created:', error);
    throw error;
  }
}

async function handleSubscriptionUpdated(subscription) {
  try {
    const customerId = subscription.customer;
    
    // Find user by customer ID
    const user = await prisma.user.findUnique({
      where: { stripeCustomerId: customerId }
    });
    
    if (!user) {
      console.error('User not found for customer:', customerId);
      return;
    }

    // Update subscription status
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: subscription.status,
        subscriptionEndDate: toDateFromUnix(subscription.current_period_end)
      }
    });

    console.log(`Subscription updated for user ${user.id}, status: ${subscription.status}`);

  } catch (error) {
    // Re-throw so the webhook returns 500 and Stripe redelivers — the single
    // write here (subscriptionStatus + period-end) is idempotent, and silently
    // swallowing left subscription state permanently stale on a transient DB
    // failure (mirrors handleSubscriptionDeleted/handleInvoicePaymentSucceeded).
    console.error('Error handling subscription updated:', error);
    throw error;
  }
}

async function handleSubscriptionDeleted(subscription) {
  try {
    const customerId = subscription.customer;
    
    // Find user by customer ID
    const user = await prisma.user.findUnique({
      where: { stripeCustomerId: customerId }
    });
    
    if (!user) {
      console.error('User not found for customer:', customerId);
      return;
    }

    // Revert to free plan - preserve current usage, just update limits
    await prisma.user.update({
      where: { id: user.id },
      data: {
        plan: 'FREE',
        // `monthlyLimit` is `BigInt` in the Prisma schema — use a BigInt
        // literal so Prisma doesn't coerce a JS number and risk overflow.
        monthlyLimit: 1000n,
        monthlyCallLimit: 3,
        subscriptionStatus: 'canceled',
        subscriptionEndDate: toDateFromUnix(subscription.ended_at)
        // monthlyCallLimit: NOT UPDATED - preserve current usage
      }
    });

    console.log(`Subscription canceled for user ${user.id}`);

  } catch (error) {
    // Re-throw so the webhook returns 500 and Stripe redelivers — the downgrade
    // (revert to FREE + limits) is idempotent, and silently swallowing left a
    // canceled user on paid limits indefinitely (revenue leak).
    console.error('Error handling subscription deleted:', error);
    throw error;
  }
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

    // Update user record
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: 'canceling' // Custom status to indicate cancellation pending
      }
    });

    res.json({
      message: 'Subscription will be canceled at the end of the current billing period',
      subscription: {
        id: subscription.id,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        currentPeriodEnd: toDateFromUnix(subscription.current_period_end)
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
