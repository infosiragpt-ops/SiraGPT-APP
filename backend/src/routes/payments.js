const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const stripeService = require('../services/stripe');
const { getPriceIdForPlan } = require('../utils/stripe-setup');

const router = express.Router();

// Create Stripe checkout session
router.post('/stripe', [
  body('plan').isIn(['BASIC', 'STANDARD', 'ENTERPRISE']).withMessage('Invalid plan')
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
      BASIC: 5.00,
      STANDARD: 15.00,
      ENTERPRISE: 99.00
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
      `${frontendUrl}/payment/cancel`
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
    console.error('Stripe payment error:', error);
    
    // Check if it's a configuration issue
    if (error.message.includes('Stripe is not configured')) {
      return res.status(503).json({ 
        error: 'Stripe not configured', 
        message: 'Payment processing is not available. Please contact support or use demo mode.',
        fallbackAvailable: true
      });
    }
    
    res.status(500).json({ 
      error: 'Payment creation failed', 
      details: error.message 
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
      session = await stripeService.stripe.checkout.sessions.retrieve(session_id);
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

        // Update user subscription - same logic as webhook
        const planCredits = {
          BASIC: 10000,
          STANDARD: 30000,
          ENTERPRISE: 100000
        };

        const updatedUser = await prisma.user.update({
          where: { id: req.user.id },
          data: {
            plan: payment.plan,
            monthlyLimit: planCredits[payment.plan],
            stripeSubscriptionId: session.subscription,
            subscriptionStatus: 'active'
          }
        });

        console.log(`Successfully updated user ${req.user.id} to plan ${payment.plan}`);
        paymentStatus = 'COMPLETED';
      }
    } catch (stripeError) {
      console.log('Stripe not configured or session not found in Stripe, checking demo mode...');
      
      // In demo mode (without Stripe keys), simulate successful payment after a delay
      if (payment.status === 'PENDING') {
        console.log('Demo mode: Updating payment and user plan...');
        
        // Update payment status
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'COMPLETED' }
        });

        // Update user subscription
        const planCredits = {
          BASIC: 10000,
          STANDARD: 30000,
          ENTERPRISE: 10000000
        };

        const updatedUser = await prisma.user.update({
          where: { id: req.user.id },
          data: {
            plan: payment.plan,
            monthlyLimit: planCredits[payment.plan],
            subscriptionStatus: 'active'
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
    console.error('Error verifying payment session:', error);
    res.status(500).json({ error: 'Failed to verify payment session' });
  }
});


// Get user payments
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where: { userId: req.user.id },
        skip: parseInt(skip),
        take: parseInt(limit),
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

// Instant (demo) subscription - frontend calls /api/payments/instant
router.post(
  '/instant',
  authenticateToken,
  [
    // optional validators: monthlyLimit if provided must be integer
    body('plan')
      .isIn(['BASIC', 'STANDARD', 'ENTERPRISE'])
      .withMessage('Invalid plan (allowed: BASIC, STANDARD, ENTERPRISE)'),
    body('monthlyLimit').optional().isInt({ min: 0 }).withMessage('monthlyLimit must be an integer >= 0'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { plan, monthlyLimit } = req.body;

      // Default plan credits (used when monthlyLimit isn't supplied)
      const planCredits = {
        BASIC: 10000,
        STANDARD: 30000,
        ENTERPRISE: 10000000,
      };

      const add = typeof monthlyLimit !== 'undefined' && monthlyLimit !== null
        ? Number(monthlyLimit)
        : (planCredits[plan] || 0);

      // Load current user
      const dbUser = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!dbUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Append credits to existing monthlyLimit
      const newMonthlyLimit = (dbUser.monthlyLimit ?? 0) + add;

      const updated = await prisma.user.update({
        where: { id: req.user.id },
        data: {
          plan,
          monthlyLimit: newMonthlyLimit,
          // If you use monthlyCallLimit only for free users, keep this 0 for paid plans
          monthlyCallLimit: 0,
        },
      });

      // Return updated user (omit sensitive fields if needed)
      return res.json({ user: updated });
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
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
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
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Webhook event handlers
async function handleCheckoutSessionCompleted(session) {
  try {
    console.log('Processing checkout session completed:', session.id);
    
    const userId = session.metadata.userId;
    const plan = session.metadata.plan;
    
    if (!userId || !plan) {
      console.error('Missing metadata in checkout session:', session.id);
      return;
    }

    // Update payment record
    await prisma.payment.updateMany({
      where: {
        stripeSessionId: session.id,
        userId: userId
      },
      data: {
        status: 'COMPLETED',
        stripeSubscriptionId: session.subscription
      }
    });

    // Update user subscription
    const planCredits = {
      BASIC: 10000,
      STANDARD: 30000,
      ENTERPRISE: 10000000
    };

    await prisma.user.update({
      where: { id: userId },
      data: {
        plan,
        monthlyLimit: planCredits[plan],
        stripeSubscriptionId: session.subscription,
        subscriptionStatus: 'active'
      }
    });

    console.log(`Subscription activated for user ${userId}, plan: ${plan}`);
    
  } catch (error) {
    console.error('Error handling checkout session completed:', error);
  }
}

async function handleInvoicePaymentSucceeded(invoice) {
  try {
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

    // Update subscription status
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: subscription.status,
        subscriptionEndDate: new Date(subscription.current_period_end * 1000)
      }
    });

    console.log(`Invoice payment succeeded for user ${user.id}`);
    
  } catch (error) {
    console.error('Error handling invoice payment succeeded:', error);
  }
}

async function handleInvoicePaymentFailed(invoice) {
  try {
    const customerId = invoice.customer;
    
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
        subscriptionStatus: 'past_due'
      }
    });

    console.log(`Invoice payment failed for user ${user.id}`);
    
  } catch (error) {
    console.error('Error handling invoice payment failed:', error);
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
    await prisma.user.update({
      where: { id: user.id },
      data: {
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        subscriptionEndDate: new Date(subscription.current_period_end * 1000)
      }
    });

    console.log(`Subscription created for user ${user.id}`);
    
  } catch (error) {
    console.error('Error handling subscription created:', error);
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
        subscriptionEndDate: new Date(subscription.current_period_end * 1000)
      }
    });

    console.log(`Subscription updated for user ${user.id}, status: ${subscription.status}`);
    
  } catch (error) {
    console.error('Error handling subscription updated:', error);
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
         monthlyLimit: 10000,
        monthlyCallLimit: 3,
        subscriptionStatus: 'canceled',
        subscriptionEndDate: new Date(subscription.ended_at * 1000)
        // monthlyCallLimit: NOT UPDATED - preserve current usage
      }
    });

    console.log(`Subscription canceled for user ${user.id}`);
    
  } catch (error) {
    console.error('Error handling subscription deleted:', error);
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
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            nextInvoiceDate: subscription.status === 'active' ? new Date(subscription.current_period_end * 1000) : null
          }
        };
      } catch (error) {
        console.error('Error fetching Stripe subscription:', error);
      }
    }

    res.json(subscriptionInfo);

  } catch (error) {
    console.error('Error fetching subscription info:', error);
    res.status(500).json({ error: 'Failed to fetch subscription info' });
  }
});

// Cancel subscription
router.post('/subscription/cancel', authenticateToken, async (req, res) => {
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
        currentPeriodEnd: new Date(subscription.current_period_end * 1000)
      }
    });

  } catch (error) {
    console.error('Error canceling subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Reactivate subscription
router.post('/subscription/reactivate', authenticateToken, async (req, res) => {
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