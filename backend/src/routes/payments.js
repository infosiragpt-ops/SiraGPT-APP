const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');

const router = express.Router();

// Create Stripe payment
router.post('/stripe', [
  body('plan').isIn(['PRO', 'ENTERPRISE']).withMessage('Invalid plan'),
  body('priceId').trim().isLength({ min: 1 }).withMessage('Price ID required')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { plan, priceId } = req.body;

    // For demo purposes, simulate Stripe integration
    const sessionId = `cs_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const amount = plan === 'PRO' ? 29 : 99;

    // Create payment record
    const payment = await prisma.payment.create({
      data: {
        userId: req.user.id,
        amount,
        plan,
        provider: 'STRIPE',
        providerId: sessionId,
        status: 'PENDING'
      }
    });

    // Simulate successful payment for demo
    setTimeout(async () => {
      try {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'COMPLETED' }
        });

        await prisma.user.update({
          where: { id: req.user.id },
          data: {
            plan,
            monthlyLimit: plan === 'PRO' ? 50000 : 100000
          }
        });
      } catch (error) {
        console.error('Payment completion error:', error);
      }
    }, 3000);

    res.json({
      sessionId,
      url: `${process.env.FRONTEND_URL}/payment/success?session_id=${sessionId}`,
      payment
    });
  } catch (error) {
    console.error('Stripe payment error:', error);
    res.status(500).json({ error: 'Payment creation failed' });
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

// Webhook handlers would go here for real payment providers
// router.post('/stripe/webhook', ...)
// router.post('/paypal/webhook', ...)
// router.post('/mercadopago/webhook', ...)

module.exports = router;