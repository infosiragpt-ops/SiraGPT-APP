const express = require('express');
const { authenticateToken, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const prisma = require('../config/database');
const { body, validationResult } = require('express-validator');
const { ProviderType, ModelType } = require('@prisma/client'); // Enums ko import karein
const bcrypt = require('bcryptjs');
const router = express.Router();
const stripeService = require('../services/stripe');
const axios = require('axios');
const { serializeUser, serializeBigIntFields } = require('../utils/bigint-serializer');
const modelSyncService = require('../services/model-sync-service');
const modelSyncScheduler = require('../services/model-sync-scheduler');

// Apply admin middleware to all routes
router.use(authenticateToken, requireAdmin);


router.get('/providers', (req, res) => {
  // Prisma se ProviderType enum ki values hasil karein
  const providers = Object.keys(ProviderType);
  res.json({ providers });
});
// AI Models Management
router.get('/models', async (req, res) => {
  try {
    const models = await prisma.aiModel.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json({ models });
  } catch (error) {
    console.error('Get models error:', error);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

router.post('/models', [
  body('name').trim().isLength({ min: 1 }).withMessage('Name is required'),
  body('displayName').trim().isLength({ min: 1 }).withMessage('Display name is required'),
  body('provider').isIn(Object.values(ProviderType)).withMessage('Invalid provider'), // <-- Provider ko validate karein
  body('type').isIn(Object.keys(ModelType)).withMessage('Invalid model type'),
  body('icon').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, displayName, provider, type, icon, description, apiKey } = req.body;

    const model = await prisma.aiModel.create({
      data: {
        name,
        displayName,
        provider,
        type,
        icon,
        description,
        apiKey
      }
    });

    res.status(201).json({ model });
  } catch (error) {
    console.error('Create model error:', error);
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Model name already exists' });
    }
    res.status(500).json({ error: 'Failed to create model' });
  }
});

router.put('/models/:id', [
  body('displayName').optional().trim().isLength({ min: 1 }),
  body('provider').optional().isIn(Object.keys(ProviderType)),
  body('type').optional().isIn(Object.keys(ModelType)),
  body('icon').optional({ nullable: true }).trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { displayName, provider, type, icon, description, apiKey, isActive } = req.body;
    const updateData = {};

    if (displayName) updateData.displayName = displayName;
    if (provider) updateData.provider = provider;
    if (type) updateData.type = type;
    if (icon !== undefined) updateData.icon = icon;
    if (description !== undefined) updateData.description = description;
    if (apiKey !== undefined) updateData.apiKey = apiKey;
    if (typeof isActive === 'boolean') updateData.isActive = isActive;

    const model = await prisma.aiModel.update({
      where: { id: req.params.id },
      data: updateData
    });

    res.json({ model });
  } catch (error) {
    console.error('Update model error:', error);
    res.status(500).json({ error: 'Failed to update model' });
  }
});

router.delete('/models/:id', async (req, res) => {
  try {
    await prisma.aiModel.delete({
      where: { id: req.params.id }
    });
    res.json({ message: 'Model deleted successfully' });
  } catch (error) {
    console.error('Delete model error:', error);
    res.status(500).json({ error: 'Failed to delete model' });
  }
});

// ✨ NEW: Model synchronization endpoints
// Fetch models from all providers without saving to DB
router.get('/models/fetch', async (req, res) => {
  try {
    console.log('📡 Admin requested model fetch from all providers');
    const models = await modelSyncService.fetchAllModels();
    const catalogDiagnostics = modelSyncService.getModelCatalogDiagnostics();
    res.json({ 
      success: true, 
      models,
      count: models.length,
      catalogDiagnostics,
      providers: {
        openai: models.filter(m => m.provider === 'OpenAI').length,
        gemini: models.filter(m => m.provider === 'Gemini').length,
        openrouter: models.filter(m => m.provider === 'OpenRouter').length,
        deepseek: models.filter(m => m.provider === 'DeepSeek').length
      }
    });
  } catch (error) {
    console.error('❌ Error fetching models:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch models from providers',
      message: error.message 
    });
  }
});

// Static provider model catalog and API-key diagnostics.
router.get('/models/catalog', async (req, res) => {
  try {
    const includeModels = req.query.includeModels === 'true';
    res.json({
      success: true,
      providers: modelSyncService.getModelCatalogDiagnostics({ includeModels }),
    });
  } catch (error) {
    console.error('❌ Error getting model catalog diagnostics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get model catalog diagnostics',
      message: error.message
    });
  }
});

// Sync models to database
router.post('/models/sync', async (req, res) => {
  try {
    console.log('🔄 Admin requested model sync to database');
    const result = await modelSyncService.syncModelsToDatabase();
    res.json({ 
      success: true, 
      message: 'Models synchronized successfully',
      result
    });
  } catch (error) {
    console.error('❌ Error syncing models:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to sync models to database',
      message: error.message 
    });
  }
});

// Get provider statistics
router.get('/models/stats', async (req, res) => {
  try {
    const stats = await modelSyncService.getProviderStats();
    const total = await prisma.aiModel.count();
    const active = await prisma.aiModel.count({ where: { isActive: true } });
    
    res.json({
      success: true,
      stats: {
        total,
        active,
        inactive: total - active,
        byProvider: stats
      }
    });
  } catch (error) {
    console.error('❌ Error getting model stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get model statistics' 
    });
  }
});

// Clear model cache
router.post('/models/clear-cache', async (req, res) => {
  try {
    const { provider } = req.body;
    modelSyncService.clearCache(provider);
    res.json({ 
      success: true, 
      message: provider ? `${provider} cache cleared` : 'All caches cleared' 
    });
  } catch (error) {
    console.error('❌ Error clearing cache:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to clear cache' 
    });
  }
});

// Bulk enable/disable models
router.put('/models/bulk', async (req, res) => {
  try {
    const { action, modelIds, provider } = req.body;
    
    if (!action || !['enable', 'disable'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use enable or disable.' });
    }

    const isActive = action === 'enable';
    let whereClause = {};

    if (modelIds && Array.isArray(modelIds)) {
      whereClause.id = { in: modelIds };
    } else if (provider) {
      whereClause.provider = provider;
    } else {
      return res.status(400).json({ error: 'Either modelIds or provider must be specified' });
    }

    const result = await prisma.aiModel.updateMany({
      where: whereClause,
      data: { isActive }
    });

    res.json({ 
      success: true, 
      message: `Successfully ${action}d ${result.count} models`,
      count: result.count 
    });
  } catch (error) {
    console.error('❌ Error in bulk update:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update models' 
    });
  }
});

// ✨ Model sync scheduler endpoints
// Get scheduler status and sync history
router.get('/models/sync/status', async (req, res) => {
  try {
    const history = await modelSyncScheduler.getSyncHistory();
    res.json({ 
      success: true, 
      ...history 
    });
  } catch (error) {
    console.error('❌ Error getting sync status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get sync status' 
    });
  }
});

// Start/stop scheduler
router.post('/models/sync/scheduler', async (req, res) => {
  try {
    const { action, schedule } = req.body;
    
    if (action === 'start') {
      modelSyncScheduler.start(schedule);
      res.json({ 
        success: true, 
        message: 'Model sync scheduler started',
        status: modelSyncScheduler.getStatus() 
      });
    } else if (action === 'stop') {
      modelSyncScheduler.stop();
      res.json({ 
        success: true, 
        message: 'Model sync scheduler stopped',
        status: modelSyncScheduler.getStatus() 
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: 'Invalid action. Use start or stop.' 
      });
    }
  } catch (error) {
    console.error('❌ Error managing scheduler:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to manage scheduler' 
    });
  }
});

// Run sync immediately
router.post('/models/sync/run', async (req, res) => {
  try {
    const result = await modelSyncScheduler.runImmediately();
    res.json({ 
      success: true, 
      message: 'Model sync completed successfully',
      result 
    });
  } catch (error) {
    console.error('❌ Error running immediate sync:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to run model sync',
      message: error.message 
    });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', plan = '' } = req.query;
    const skip = (page - 1) * limit;

    const where = {
      AND: [
        search ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } }
          ]
        } : {},
        plan ? { plan } : {},
        // Exclude super admin users from the list
        { isSuperAdmin: false }
      ]
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          plan: true,
          isAdmin: true,
          isSuperAdmin: true,
          apiUsage: true,
          monthlyLimit: true,
          createdAt: true,
          updatedAt: true
        },
        skip: parseInt(skip),
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
      }),
      prisma.user.count({ where })
    ]);

    const serializedUsers = users.map(user => serializeUser(user));

    res.json({
      users: serializedUsers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get analytics
router.get('/analytics', async (req, res) => {
  try {
    // Get basic stats
    const [
      totalUsers,
      totalChats,
      totalMessages,
      totalPayments,
      totalApiUsage
    ] = await Promise.all([
      prisma.user.count({ where: { isSuperAdmin: false } }), // Exclude super admins
      prisma.chat.count(),
      prisma.message.count(),
      prisma.payment.count(),
      prisma.apiUsage.count()
    ]);

    // Get active users (last 7 days) - exclude super admins
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const activeUsers = await prisma.user.count({
      where: {
        updatedAt: { gte: lastWeek },
        isSuperAdmin: false
      }
    });

    // Get revenue
    const revenue = await prisma.payment.aggregate({
      where: { status: 'COMPLETED' },
      _sum: { amount: true }
    });

    // Get users by plan - exclude super admins
    const usersByPlan = await prisma.user.groupBy({
      by: ['plan'],
      where: { isSuperAdmin: false },
      _count: { plan: true }
    });

    // Get API usage by model
    const apiUsageByModel = await prisma.apiUsage.groupBy({
      by: ['model'],
      _sum: { tokens: true },
      _count: { model: true }
    });

    // Get monthly revenue
    const monthlyRevenue = await prisma.payment.findMany({
      where: {
        status: 'COMPLETED',
        createdAt: {
          gte: new Date(Date.now() - 12 * 30 * 24 * 60 * 60 * 1000)
        }
      },
      select: {
        amount: true,
        createdAt: true
      }
    });

    // Group revenue by month
    const revenueByMonth = monthlyRevenue.reduce((acc, payment) => {
      const month = payment.createdAt.toISOString().slice(0, 7);
      acc[month] = (acc[month] || 0) + payment.amount;
      return acc;
    }, {});

    res.json({
      totalUsers,
      activeUsers,
      totalChats,
      totalMessages,
      totalPayments,
      totalApiUsage,
      totalRevenue: revenue._sum.amount || 0,
      usersByPlan: usersByPlan.reduce((acc, item) => {
        acc[item.plan] = item._count.plan;
        return acc;
      }, {}),
      apiUsageByModel: apiUsageByModel.map(item => ({
        model: item.model,
        tokens: item._sum.tokens || 0,
        count: item._count.model
      })),
      revenueByMonth
    });
  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Get all payments
router.get('/payments', async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '' } = req.query;
    const skip = (page - 1) * limit;

    const where = status ? { status } : {};

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          user: {
            select: {
              name: true,
              email: true
            }
          }
        },
        skip: parseInt(skip),
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
      }),
      prisma.payment.count({ where })
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

router.put(
  '/users/:id',
  [
    // optional validations
    body('name').optional().trim().isLength({ min: 1 }).withMessage('Name cannot be empty'),
    body('email').optional().isEmail().withMessage('Valid email required').normalizeEmail(),
    body('plan').optional().isString(),
    body('isAdmin').optional().isBoolean(),
    body('monthlyLimit').optional().isInt({ min: 0 }).withMessage('monthlyLimit must be 0 or greater'),
  ],
  async (req, res) => {
    try {
      // check validation
      const errors = validationResult(req)
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() })
      }

      const { name, email, plan, isAdmin, monthlyLimit } = req.body
      const updateData = {}

      // include only provided fields
      if (typeof name !== 'undefined') updateData.name = name
      if (typeof email !== 'undefined') updateData.email = email
      if (typeof plan !== 'undefined') updateData.plan = plan
      if (typeof isAdmin !== 'undefined') updateData.isAdmin = isAdmin
      if (typeof monthlyLimit !== 'undefined') updateData.monthlyLimit = parseInt(monthlyLimit, 10)

      // If email is provided, ensure uniqueness across other users
      if (email) {
        const existing = await prisma.user.findFirst({
          where: {
            email,
            NOT: { id: req.params.id },
          },
        })
        if (existing) {
          return res.status(400).json({ error: 'Email already in use by another user' })
        }
      }

      const user = await prisma.user.update({
        where: { id: req.params.id },
        data: updateData,
        select: {
          id: true,
          name: true,
          email: true,
          plan: true,
          isAdmin: true,
          apiUsage: true,
          monthlyLimit: true,
          createdAt: true,
          updatedAt: true
        }
      })

      const serializedUser = serializeUser(user);
      res.json({ user: serializedUser })
    } catch (error) {
      console.error('Update user error:', error)
      // Prisma-specific unique constraint error handling (optional)
      if (error && error.code === 'P2002') {
        return res.status(400).json({ error: 'Email already exists' })
      }
      res.status(500).json({ error: 'Failed to update user' })
    }
  }
)

// Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    // Prevent admin from deleting themselves
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    await prisma.user.delete({
      where: { id: req.params.id }
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Create a new user (admin only) - POST /admin/users
router.post(
  '/users',
  [
    body('name').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('plan').optional().isString(),
    body('isAdmin').optional().isBoolean(),
    body('monthlyLimit').optional().isInt({ min: 0 }).withMessage('monthlyLimit must be 0 or greater'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { name, email, password, plan = 'FREE', isAdmin = false, monthlyLimit = 0 } = req.body;

      // Check email uniqueness
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) return res.status(400).json({ error: 'User with that email already exists' });

      const hashed = await bcrypt.hash(password, 12);

      const user = await prisma.user.create({
        data: {
          name,
          email,
          password: hashed,
          plan,
          isAdmin,
          apiUsage: 0,
          monthlyLimit: Number(monthlyLimit),
        },
        select: {
          id: true,
          name: true,
          email: true,
          plan: true,
          isAdmin: true,
          apiUsage: true,
          monthlyLimit: true,
          createdAt: true,
          updatedAt: true
        }
      });

      return res.status(201).json({ user });
    } catch (err) {
      console.error('Admin create user error:', err);
      return res.status(500).json({ error: 'Failed to create user' });
    }
  }
);

// Get system stats
router.get('/stats', async (req, res) => {
  try {
    const stats = {
      database: {
        users: await prisma.user.count(),
        chats: await prisma.chat.count(),
        messages: await prisma.message.count(),
        files: await prisma.file.count(),
        payments: await prisma.payment.count(),
        apiUsage: await prisma.apiUsage.count()
      },
      storage: {
        totalFiles: await prisma.file.count(),
        totalSize: await prisma.file.aggregate({
          _sum: { size: true }
        }).then(result => result._sum.size || 0)
      }
    };

    res.json(stats);
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Analyzer pipeline health — lists currently open breakers and degraded
// analyzers along with the breaker config. Useful for ops to see whether
// a recently-shipped regex regression is being short-circuited in prod.
router.get('/analyzer/health', (_req, res) => {
  try {
    const documentProfessionalAnalyzer = require('../services/document-professional-analyzer');
    const snapshot = documentProfessionalAnalyzer.getAnalyzerHealthSnapshot();
    res.json(snapshot);
  } catch (err) {
    console.error('[admin/analyzer-health] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to capture analyzer health snapshot' });
  }
});

module.exports = router;
// Stripe invoices (admin)
router.get('/stripe/invoices', async (req, res) => {
  try {
    if (!stripeService.isConfigured) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    const { limit = 50, starting_after } = req.query;

    const invoices = await stripeService.stripe.invoices.list({
      limit: Math.min(parseInt(limit, 10) || 50, 100),
      ...(starting_after ? { starting_after } : {})
    });

    const customerIds = Array.from(new Set(invoices.data.map(i => String(i.customer))));
    const users = await prisma.user.findMany({
      where: { stripeCustomerId: { in: customerIds } },
      select: { id: true, name: true, email: true, stripeCustomerId: true }
    });
    const userByCustomer = new Map(users.map(u => [u.stripeCustomerId, u]));

    res.json({
      invoices: invoices.data.map(inv => ({
        id: inv.id,
        number: inv.number,
        status: inv.status,
        amountPaid: (inv.amount_paid || 0) / 100,
        currency: inv.currency,
        hostedInvoiceUrl: inv.hosted_invoice_url,
        invoicePdf: inv.invoice_pdf,
        customer: String(inv.customer),
        created: new Date(inv.created * 1000),
        user: userByCustomer.get(String(inv.customer)) || null
      })),
      has_more: invoices.has_more
    });
  } catch (error) {
    console.error('Admin list invoices error:', error);
    res.status(500).json({ error: 'Failed to list invoices' });
  }
});

router.get('/stripe/invoice/:invoiceId', async (req, res) => {
  try {
    if (!stripeService.isConfigured) {
      return res.status(503).json({ error: 'Stripe not configured' });
    }

    const invoice = await stripeService.stripe.invoices.retrieve(req.params.invoiceId);

    // Stream PDF if available
    if (invoice.invoice_pdf) {
      const response = await axios.get(invoice.invoice_pdf, { responseType: 'stream' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice.number || invoice.id}.pdf`);
      return response.data.pipe(res);
    }

    if (invoice.hosted_invoice_url) {
      return res.redirect(invoice.hosted_invoice_url);
    }

    return res.status(404).json({ error: 'Invoice PDF not available' });
  } catch (error) {
    console.error('Admin download invoice error:', error);
    res.status(500).json({ error: 'Failed to download invoice' });
  }
});

// Export all user emails to CSV
router.get('/users/export/csv', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        email: true,
        name: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    if (!users.length) {
      return res.status(404).send('No users found to export.');
    }

    // CSV header
    let csv = 'Email,Name,Registration Date\n';

    // CSV rows
    users.forEach(user => {
      const email = user.email || '';
      const name = user.name || '';
      const date = user.createdAt ? user.createdAt.toISOString().split('T')[0] : '';
      csv += `"${email}","${name}","${date}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=user-emails.csv');
    res.status(200).send(csv);

  } catch (error) {
    console.error('Export users error:', error);
    res.status(500).json({ error: 'Failed to export users' });
  }
});
