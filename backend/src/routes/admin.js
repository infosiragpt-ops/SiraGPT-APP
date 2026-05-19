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
const { responseCache } = require('../middleware/response-cache');
const adminStats = require('../services/admin-stats-aggregator');
const webhookDispatcher = require('../services/webhook-dispatcher');
const { writeAuditLog } = require('../utils/audit-log');
const crypto = require('crypto');
const {
  contentDispositionHeader,
  safeDownloadFilename,
} = require('../middleware/file-response-safety');

function invoicePdfFilename(invoice) {
  return safeDownloadFilename(`invoice-${invoice?.number || invoice?.id || Date.now()}.pdf`, {
    fallback: 'invoice.pdf',
    extension: '.pdf',
  });
}

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
// Also includes cache stats (size/hits/misses/ratio).
router.get('/analyzer/health', responseCache({ ttlMs: 60_000, namespace: 'analyzer-health' }), (_req, res) => {
  try {
    const documentProfessionalAnalyzer = require('../services/document-professional-analyzer');
    const snapshot = documentProfessionalAnalyzer.getAnalyzerHealthSnapshot();
    res.json(snapshot);
  } catch (err) {
    console.error('[admin/analyzer-health] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to capture analyzer health snapshot' });
  }
});

// Maintenance — wipe every in-process cache in one shot. Super-admin
// only. Clears:
//   - response-cache middleware global LRU (cycle 10)
//   - ai-response-cache in-memory stores (cycle 31)
//   - document-professional-analyzer content-hash cache (existing)
// Each subsystem is wrapped in its own try so a partial failure still
// clears the rest. Returns per-subsystem counts + the audit-log id.
router.post('/maintenance/clear-cache', requireSuperAdmin, async (req, res) => {
  const counts = { responseCache: 0, aiResponseCache: 0, analyzerCache: 0 };
  const errors = {};

  // 1. Response-cache middleware LRU
  try {
    const responseCacheMod = require('../middleware/response-cache');
    const before = responseCacheMod.globalLRU.size;
    responseCacheMod.clearCache();
    counts.responseCache = before;
  } catch (err) {
    errors.responseCache = err && err.message ? err.message : String(err);
  }

  // 2. AI response cache (in-memory stores only — redis-backed stores
  //    are shared infra and not flushed by this endpoint).
  try {
    const aiCache = require('../services/cache/ai-response-cache');
    const result = aiCache.clearAllInMemoryStores();
    counts.aiResponseCache = result.cleared;
  } catch (err) {
    errors.aiResponseCache = err && err.message ? err.message : String(err);
  }

  // 3. Document professional analyzer cache
  try {
    const documentProfessionalAnalyzer = require('../services/document-professional-analyzer');
    const result = documentProfessionalAnalyzer.clearAnalyzerCache();
    if (result.cleared) {
      counts.analyzerCache = (result.before && Number(result.before.size)) || 0;
    } else {
      errors.analyzerCache = result.reason || 'unavailable';
    }
  } catch (err) {
    errors.analyzerCache = err && err.message ? err.message : String(err);
  }

  void writeAuditLog(prisma, {
    actorType: 'admin',
    actorId: req.user?.id || null,
    actorName: req.user?.email || null,
    resourceType: 'maintenance',
    resourceId: 'clear-cache',
    action: 'clear_cache',
    after: { counts, errors: Object.keys(errors).length ? errors : undefined },
  });

  res.json({ ok: true, counts, errors: Object.keys(errors).length ? errors : undefined });
});

// ── Maintenance mode toggle (ratchet 45, super-admin) ───────────────────
// GET  /api/admin/maintenance/mode → current state
// POST /api/admin/maintenance/mode → { enabled: boolean, message?: string }
//   Writes the flag to SystemSettings (key=maintenance_mode) and busts
//   the in-process middleware cache so the change takes effect on the
//   writing replica immediately; other replicas pick it up within the
//   maintenance-mode middleware TTL (5s).
const maintenanceMode = require('../middleware/maintenance-mode');

router.get('/maintenance/mode', requireSuperAdmin, async (_req, res) => {
  try {
    const state = await maintenanceMode.getMaintenanceState(prisma);
    res.json({
      enabled: Boolean(state && state.enabled),
      message: (state && state.message) || null,
      since: (state && state.since) || null,
    });
  } catch (err) {
    console.error('[admin/maintenance/mode GET] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to read maintenance state' });
  }
});

router.post('/maintenance/mode', requireSuperAdmin, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: '`enabled` (boolean) is required' });
  }
  if (body.message != null && typeof body.message !== 'string') {
    return res.status(400).json({ error: '`message` must be a string when provided' });
  }
  if (typeof body.message === 'string' && body.message.length > 500) {
    return res.status(400).json({ error: '`message` must be 500 chars or fewer' });
  }
  try {
    const before = await maintenanceMode.getMaintenanceState(prisma);
    const next = await maintenanceMode.writeMaintenanceState(prisma, {
      enabled: body.enabled,
      message: body.message || null,
    });
    void writeAuditLog(prisma, {
      req,
      actorType: 'admin',
      action: 'maintenance_mode_set',
      resource: 'maintenance',
      resourceId: 'mode',
      before: before || { enabled: false },
      after: next,
    });
    res.json({ ok: true, ...next });
  } catch (err) {
    console.error('[admin/maintenance/mode POST] failed:', err?.message || err);
    res.status(500).json({ error: 'Failed to update maintenance state' });
  }
});

// Analyzer cache invalidation — wipes the in-process content-hash cache
// for the document-enrichment pipeline. Use after rolling out new
// analyzer logic that should produce different output for the same
// input (otherwise cached responses keep the old behaviour until they
// LRU-evict naturally).
router.post('/analyzer/cache/clear', (_req, res) => {
  try {
    const documentProfessionalAnalyzer = require('../services/document-professional-analyzer');
    const result = documentProfessionalAnalyzer.clearAnalyzerCache();
    if (!result.cleared) {
      return res.status(503).json({ error: 'Cache module unavailable', reason: result.reason });
    }
    res.json({ ok: true, cleared: true, before: result.before });
  } catch (err) {
    console.error('[admin/analyzer-cache-clear] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to clear analyzer cache' });
  }
});

// ── Service health probes (super-admin only) ────────────────────────────────
// Lightweight liveness probes for external dependencies. Each probe is
// budgeted with a 2-second timeout and reports its own status independently
// so that one dead dependency does not mask the rest. Provider keys are
// reported as `configured: true/false` without making real API calls
// (those are expensive and would burn quota on every health check).
const PROBE_TIMEOUT_MS = 2000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function probePostgres(prismaClient) {
  const t0 = Date.now();
  try {
    await withTimeout(prismaClient.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS, 'postgres');
    return { status: 'up', latencyMs: Date.now() - t0 };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - t0, error: err.message || String(err) };
  }
}

async function probeRedis(env) {
  if (!env.REDIS_URL) {
    return { status: 'unconfigured', latencyMs: 0 };
  }
  const t0 = Date.now();
  let client;
  try {
    const IORedis = require('ioredis');
    client = new IORedis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: PROBE_TIMEOUT_MS,
    });
    await withTimeout(client.connect(), PROBE_TIMEOUT_MS, 'redis-connect');
    await withTimeout(client.ping(), PROBE_TIMEOUT_MS, 'redis-ping');
    return { status: 'up', latencyMs: Date.now() - t0 };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - t0, error: err.message || String(err) };
  } finally {
    if (client) {
      try { await client.quit(); } catch (_) { try { client.disconnect(); } catch (_) { /* ignore */ } }
    }
  }
}

async function probeStripe(stripeSvc) {
  if (!stripeSvc || !stripeSvc.isConfigured) {
    return { status: 'unconfigured', latencyMs: 0 };
  }
  const t0 = Date.now();
  try {
    await withTimeout(
      stripeSvc.ping ? stripeSvc.ping() : stripeSvc.stripe.products.list({ limit: 1 }),
      PROBE_TIMEOUT_MS,
      'stripe'
    );
    return { status: 'up', latencyMs: Date.now() - t0 };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - t0, error: err.message || String(err) };
  }
}

async function probeSmtp(emailSvc) {
  if (!emailSvc) return { status: 'unconfigured', latencyMs: 0 };
  if (typeof emailSvc.isConfigured === 'function' && !emailSvc.isConfigured()) {
    return { status: 'unconfigured', latencyMs: 0 };
  }
  if (typeof emailSvc.isConfigured !== 'function' && emailSvc.isConfigured !== true) {
    return { status: 'unconfigured', latencyMs: 0 };
  }
  const t0 = Date.now();
  try {
    if (typeof emailSvc.verify === 'function') {
      await withTimeout(emailSvc.verify(), PROBE_TIMEOUT_MS, 'smtp-verify');
    } else if (emailSvc.transporter && typeof emailSvc.transporter.verify === 'function') {
      await withTimeout(
        new Promise((resolve, reject) => emailSvc.transporter.verify((err, ok) => (err ? reject(err) : resolve(ok)))),
        PROBE_TIMEOUT_MS,
        'smtp-verify'
      );
    }
    return { status: 'up', latencyMs: Date.now() - t0 };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - t0, error: err.message || String(err) };
  }
}

function probeProviders(env) {
  // We deliberately do NOT call provider endpoints — health checks must
  // be cheap. Reporting that the key is set is the most useful signal.
  return {
    openai:   { status: env.OPENAI_API_KEY    ? 'configured' : 'unconfigured' },
    anthropic:{ status: env.ANTHROPIC_API_KEY ? 'configured' : 'unconfigured' },
    groq:     { status: env.GROQ_API_KEY      ? 'configured' : 'unconfigured' },
    gemini:   { status: env.GEMINI_API_KEY    ? 'configured' : 'unconfigured' },
    deepseek: { status: env.DEEPSEEK_API_KEY  ? 'configured' : 'unconfigured' },
  };
}

// ── AI provider boot status ─────────────────────────────────────────────
// Attempts to *construct* the provider SDK client (no network call) to
// verify the constructor and credentials don't throw at boot. This is a
// stronger signal than "key is set" — a malformed key or a missing peer
// dep is surfaced here.
function probeProviderBoot(env) {
  const out = {};
  const tryBoot = (name, fn) => {
    try {
      const client = fn();
      out[name] = { status: client ? 'booted' : 'unconfigured' };
    } catch (err) {
      out[name] = { status: 'error', error: err.message || String(err) };
    }
  };

  tryBoot('openai', () => {
    if (!env.OPENAI_API_KEY) return null;
    const OpenAI = require('openai');
    return new OpenAI({ apiKey: env.OPENAI_API_KEY });
  });
  tryBoot('anthropic', () => {
    if (!env.ANTHROPIC_API_KEY) return null;
    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { return null; }
    return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  });
  tryBoot('groq', () => {
    if (!env.GROQ_API_KEY) return null;
    let Groq;
    try { Groq = require('groq-sdk'); } catch (_) { return null; }
    return new Groq({ apiKey: env.GROQ_API_KEY });
  });
  tryBoot('gemini', () => {
    if (!env.GEMINI_API_KEY) return null;
    let GoogleGenerativeAI;
    try {
      ({ GoogleGenerativeAI } = require('@google/generative-ai'));
    } catch (_) { return null; }
    return new GoogleGenerativeAI(env.GEMINI_API_KEY);
  });
  tryBoot('deepseek', () => {
    if (!env.DEEPSEEK_API_KEY) return null;
    // DeepSeek uses the OpenAI SDK with a custom baseURL.
    const OpenAI = require('openai');
    return new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  });
  return out;
}

// ── BullMQ workers ───────────────────────────────────────────────────────
async function probeBullmqWorkers(env, queueModule) {
  if (!env.REDIS_URL) return { status: 'unconfigured' };
  try {
    const mod = queueModule || require('../services/agents/agent-task-queue');
    if (typeof mod.getQueueHealth !== 'function') {
      return { status: 'unconfigured', reason: 'queue module missing getQueueHealth' };
    }
    const health = await withTimeout(mod.getQueueHealth(), PROBE_TIMEOUT_MS, 'bullmq-health');
    return {
      status: 'up',
      queue: health.queue,
      counts: health.counts,
    };
  } catch (err) {
    return { status: 'down', error: err.message || String(err) };
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────
function probeScheduler(schedulerModule) {
  try {
    const mod = schedulerModule || require('../services/scheduler/scheduler');
    const active = mod._active && typeof mod._active.size === 'number' ? mod._active.size : 0;
    const jobs = typeof mod.listJobs === 'function' ? mod.listJobs({}) : [];
    return {
      status: active > 0 || jobs.length === 0 ? 'up' : 'idle',
      activeCronTasks: active,
      registeredJobs: Array.isArray(jobs) ? jobs.length : 0,
    };
  } catch (err) {
    return { status: 'down', error: err.message || String(err) };
  }
}

// ── WebSocket server ─────────────────────────────────────────────────────
function probeWebsocket(socketModule) {
  try {
    const mod = socketModule || require('../services/realtime/socket-server');
    if (typeof mod.getRealtimeState !== 'function') {
      return { status: 'unconfigured' };
    }
    const state = mod.getRealtimeState();
    if (!state || !state.wss) return { status: 'down', reason: 'not_initialised' };
    const userClients = state.userIndex ? state.userIndex.size : 0;
    return {
      status: 'up',
      path: mod.WS_PATH,
      connectedUsers: userClients,
    };
  } catch (err) {
    return { status: 'down', error: err.message || String(err) };
  }
}

function deriveOverall(services) {
  const critical = [services.postgres, services.redis, services.stripe, services.smtp];
  // Treat 'down' as degrading and postgres-down as fully down (DB is hard
  // requirement). Other 'down' statuses → degraded.
  if (services.postgres.status === 'down') return 'down';
  if (critical.some((s) => s.status === 'down')) return 'degraded';
  return 'healthy';
}

// System cron probe — surfaces the registered jobs from
// `jobs/system-cron.js` (cycle 14/29 GDPR housekeeping, etc.) so ops can
// confirm the scheduler is running and see lastRun / lastDuration /
// nextRun per job without SSH-ing into the box. Caller can override the
// module (e.g. tests inject a fake) via `systemCronModule`.
function probeSystemCron(systemCronModule) {
  try {
    let mod = systemCronModule;
    if (!mod) {
      // eslint-disable-next-line global-require
      mod = require('../jobs/system-cron');
    }
    const snap = (typeof mod.status === 'function' ? mod.status() : null) || { enabled: false, tasks: [] };
    return {
      status: snap.enabled ? 'up' : 'disabled',
      enabled: Boolean(snap.enabled),
      jobs: Array.isArray(snap.tasks) ? snap.tasks : [],
    };
  } catch (err) {
    return { status: 'down', error: err && err.message ? err.message : String(err), jobs: [] };
  }
}

async function collectServiceHealth({
  prismaClient,
  env,
  stripeSvc,
  emailSvc,
  queueModule,
  schedulerModule,
  socketModule,
  systemCronModule,
}) {
  const [postgres, redis, stripe, smtp, bullmq] = await Promise.all([
    probePostgres(prismaClient),
    probeRedis(env),
    probeStripe(stripeSvc),
    probeSmtp(emailSvc),
    probeBullmqWorkers(env, queueModule),
  ]);
  const providers = probeProviders(env);
  const providerBoot = probeProviderBoot(env);
  const scheduler = probeScheduler(schedulerModule);
  const websocket = probeWebsocket(socketModule);
  const systemCron = probeSystemCron(systemCronModule);
  const services = {
    postgres,
    redis,
    stripe,
    smtp,
    providers,
    providerBoot,
    bullmq,
    scheduler,
    websocket,
    systemCron,
  };
  return {
    timestamp: new Date().toISOString(),
    overall: deriveOverall(services),
    services,
  };
}

// ── Cost report (super-admin only) ──────────────────────────────────────
// Aggregates per-user / per-model AI costs over a date range. Backed by
// the in-process services/ai/cost-tracker; for production-grade durability
// install a `setPersistHook` writer at boot that flushes records into a
// Postgres `ai_cost_log` table.
router.get('/cost-report', requireSuperAdmin, async (req, res) => {
  try {
    const costTracker = require('../services/ai/cost-tracker');
    const { from, to, userId, groupBy } = req.query || {};
    const fromDate = from ? new Date(String(from)) : null;
    const toDate = to ? new Date(String(to)) : null;
    if (from && Number.isNaN(fromDate.getTime())) {
      return res.status(400).json({ error: "Invalid 'from' date" });
    }
    if (to && Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: "Invalid 'to' date" });
    }
    const includeRecords = req.query.includeRecords !== '0' && req.query.includeRecords !== 'false';
    let report = costTracker.report({
      from: fromDate,
      to: toDate,
      userId: userId || null,
      includeRecords,
    });

    // Ratchet 45 — three-layer cost report.
    //   1. archive  (SystemSettings cost_archive:* — rows ≥ 13 months old)
    //   2. persisted (CostUsageDaily — rows < 13 months and ≥ 24h old)
    //   3. recent   (in-memory cost-tracker — last 24h)
    // Each layer covers a disjoint window so we never double-count.
    const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    // 13-month boundary for the archive cut.
    const ARCHIVE_MONTHS = costTracker.ARCHIVE_RETENTION_MONTHS || 13;
    const archiveBoundary = new Date();
    archiveBoundary.setUTCDate(1);
    archiveBoundary.setUTCHours(0, 0, 0, 0);
    archiveBoundary.setUTCMonth(archiveBoundary.getUTCMonth() - ARCHIVE_MONTHS);
    if (fromDate && fromDate.getTime() < cutoff) {
      // Recent in-memory layer (always last 24h).
      const recent = costTracker.report({
        from: new Date(cutoff),
        to: toDate,
        userId: userId || null,
        includeRecords,
      });
      // Persisted CostUsageDaily layer covers [max(from, archiveBoundary),
      // min(to, now-24h)].
      const persistedFrom = fromDate.getTime() < archiveBoundary.getTime()
        ? archiveBoundary
        : fromDate;
      const persistedTo = toDate
        ? new Date(Math.min(toDate.getTime(), cutoff))
        : new Date(cutoff);
      const persisted = persistedFrom.getTime() <= persistedTo.getTime()
        ? await costTracker.loadDailyReport({
            from: persistedFrom,
            to: persistedTo,
            userId: userId || null,
            prisma,
          })
        : null;
      let merged = persisted ? costTracker.mergeReports(persisted, recent) : recent;
      // Archive layer when the requested window predates the 13-month cut.
      if (fromDate.getTime() < archiveBoundary.getTime()) {
        const archiveTo = toDate && toDate.getTime() < archiveBoundary.getTime()
          ? toDate
          : new Date(archiveBoundary.getTime() - 1);
        const archived = await costTracker.loadArchivedReport({
          from: fromDate,
          to: archiveTo,
          userId: userId || null,
          prisma,
        });
        merged = costTracker.mergeReports(archived, merged);
      }
      report = merged;
    }

    // Cycle 45: optional org-level aggregation. When `?groupBy=org` is
    // passed we join the per-user totals through OrgMembership to roll
    // tokens + cost up to each Organization. A user belonging to N orgs
    // is counted once per org (the typical SaaS billing model: each org
    // sees the spend of its own members). Users with no memberships are
    // grouped under the synthetic "__unaffiliated__" bucket so callers
    // can still account for 100% of the cost.
    let perOrg = null;
    if (String(groupBy || '').toLowerCase() === 'org') {
      const { aggregatePerOrg } = require('../services/ai/cost-report-aggregator');
      const userIds = report.perUser.map((u) => u.userId).filter((id) => id && id !== 'anonymous');
      let memberships = [];
      if (userIds.length > 0) {
        try {
          memberships = await prisma.orgMembership.findMany({
            where: { userId: { in: userIds } },
            select: {
              userId: true,
              orgId: true,
              organization: { select: { id: true, name: true, slug: true } },
            },
          });
        } catch (err) {
          console.error('[admin/cost-report] org join failed:', err && err.message ? err.message : err);
        }
      }
      perOrg = aggregatePerOrg(report.perUser, memberships);
    }

    return res.json({
      ok: true,
      filters: {
        from: from || null,
        to: to || null,
        userId: userId || null,
        groupBy: groupBy || null,
      },
      ...report,
      ...(perOrg ? { perOrg } : {}),
    });
  } catch (err) {
    console.error('[admin/cost-report] failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to build cost report' });
  }
});

// ── Cost forecast (super-admin only) ────────────────────────────────────
// Ratchet 45 — linear-regression projection of AI spend for the current
// month. Surfaces per-user + per-org forecasts so finance can flag
// runaway trends before billing closes. Backed by the same in-process
// cost-tracker as /cost-report; install a persist hook at boot for
// production-grade durability.
//   GET /api/admin/cost-forecast?windowDays=14
router.get('/cost-forecast', requireSuperAdmin, async (req, res) => {
  try {
    const costTracker = require('../services/ai/cost-tracker');
    const costForecast = require('../services/ai/cost-forecast');
    const windowDays = Number.parseInt(String(req.query.windowDays || ''), 10);
    const safeWindow = Number.isFinite(windowDays) && windowDays > 0
      ? Math.min(60, windowDays)
      : costForecast.FORECAST_WINDOW_DAYS;

    // Pull membership rows once so we can roll user forecasts up to orgs
    // without a per-user N+1. Records are already in-memory; the only
    // I/O is this single join.
    let memberships = [];
    try {
      const records = typeof costTracker._peekRecords === 'function' ? costTracker._peekRecords() : [];
      const ids = new Set();
      for (const r of records) {
        if (r && r.userId) ids.add(String(r.userId));
      }
      if (ids.size > 0) {
        memberships = await prisma.orgMembership.findMany({
          where: { userId: { in: [...ids] } },
          select: {
            userId: true,
            orgId: true,
            organization: { select: { id: true, name: true, slug: true } },
          },
        });
      }
    } catch (err) {
      console.error('[admin/cost-forecast] org join failed:', err && err.message ? err.message : err);
    }

    const forecast = costForecast.forecastAll({
      tracker: costTracker,
      memberships,
      windowDays: safeWindow,
    });

    return res.json({
      ok: true,
      windowDays: safeWindow,
      ...forecast,
    });
  } catch (err) {
    console.error('[admin/cost-forecast] failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to build cost forecast' });
  }
});

// ── Top AI models (super-admin only) ────────────────────────────────────
// Cycle 45 — aggregates the in-process cost-tracker records into a
// per-model leaderboard suitable for the admin "API usage analytics"
// dashboard. Sorted by request count desc; `limit` capped at 1000.
//   GET /api/admin/stats/ai-models?from=&to=&limit=10
router.get('/stats/ai-models', requireSuperAdmin, async (req, res) => {
  try {
    const costTracker = require('../services/ai/cost-tracker');
    const { from, to, limit } = req.query || {};
    const fromDate = from ? new Date(String(from)) : null;
    const toDate = to ? new Date(String(to)) : null;
    if (from && Number.isNaN(fromDate.getTime())) {
      return res.status(400).json({ error: "Invalid 'from' date" });
    }
    if (to && Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: "Invalid 'to' date" });
    }
    const parsedLimit = limit != null ? Number.parseInt(String(limit), 10) : 10;
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10;
    const rows = costTracker.topModels({
      from: fromDate,
      to: toDate,
      limit: safeLimit,
    });
    return res.json({
      ok: true,
      filters: {
        from: from || null,
        to: to || null,
        limit: safeLimit,
      },
      models: rows,
    });
  } catch (err) {
    console.error('[admin/stats/ai-models] failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to build AI models report' });
  }
});

// ── System summary (super-admin only) ──────────────────────────────────
// Aggregates the most-watched dashboards into a single response so the
// on-call dashboard / status page can render in one round-trip:
//   - overall: 'green' | 'amber' | 'red' (derived from service health)
//   - services: postgres / redis / smtp / stripe statuses
//   - crons: stale job count (system-cron jobs whose lastRun is older
//            than 2x their interval — best-effort, never throws)
//   - users: active-in-last-7-days
//   - orgs:  total Organization rows
//   - mrr:   estimated USD MRR from active subscriptions
//   - alerts: count of alerts currently inside the dedup window
//
// All sub-calls are guarded individually — if any one fails we still
// return the rest so the dashboard never goes blank.
async function buildSystemSummary({
  prismaClient = prisma,
  env = process.env,
  stripeSvc = stripeService,
  emailSvc = null,
  queueModule = null,
  schedulerModule = null,
  socketModule = null,
  systemCronModule = null,
  alertingModule = null,
  nowMs = Date.now(),
} = {}) {
  const settle = (p, fallback) =>
    Promise.resolve()
      .then(() => p)
      .catch(() => fallback);

  const emailSvcResolved = emailSvc || (() => {
    try { return require('../services/email'); } catch { return null; }
  })();
  const queueModuleResolved = queueModule || (() => {
    try { return require('../services/agents/agent-task-queue'); } catch { return null; }
  })();
  const schedulerModuleResolved = schedulerModule || (() => {
    try { return require('../services/scheduler/scheduler'); } catch { return null; }
  })();
  const socketModuleResolved = socketModule || (() => {
    try { return require('../services/realtime/socket-server'); } catch { return null; }
  })();
  const systemCronModuleResolved = systemCronModule || (() => {
    try { return require('../jobs/system-cron'); } catch { return null; }
  })();
  const alertingModuleResolved = alertingModule || (() => {
    try { return require('../services/alerting'); } catch { return null; }
  })();

  // Service health snapshot — reused so we surface the same numbers as
  // /api/admin/health/services without a second round-trip.
  const healthSnap = await settle(
    collectServiceHealth({
      prismaClient,
      env,
      stripeSvc,
      emailSvc: emailSvcResolved,
      queueModule: queueModuleResolved,
      schedulerModule: schedulerModuleResolved,
      socketModule: socketModuleResolved,
      systemCronModule: systemCronModuleResolved,
    }),
    { overall: 'down', services: {} },
  );

  const services = {
    postgres: healthSnap.services?.postgres?.status || 'unknown',
    redis: healthSnap.services?.redis?.status || 'unknown',
    smtp: healthSnap.services?.smtp?.status || 'unknown',
    stripe: healthSnap.services?.stripe?.status || 'unknown',
  };

  // Map health-services overall (healthy/degraded/down) to traffic-light.
  const overall = healthSnap.overall === 'healthy' ? 'green'
    : healthSnap.overall === 'degraded' ? 'amber'
    : 'red';

  // Stale crons — a job is "stale" when its declared interval has elapsed
  // since lastRun by more than 2x (best-effort: jobs without lastRun or
  // intervalMs are skipped, never counted as stale).
  let staleCronCount = 0;
  try {
    const sysCron = healthSnap.services?.systemCron;
    const jobs = Array.isArray(sysCron?.jobs) ? sysCron.jobs : [];
    for (const j of jobs) {
      if (!j) continue;
      const lastRun = j.lastRun ? new Date(j.lastRun).getTime() : null;
      const interval = Number(j.intervalMs);
      if (!lastRun || !Number.isFinite(interval) || interval <= 0) continue;
      if ((nowMs - lastRun) > 2 * interval) staleCronCount += 1;
    }
  } catch { /* never throw */ }

  // Users active in last 7 days — bounded by aggregator's `updatedAt`
  // signal (same heuristic the admin dashboard already uses).
  const sevenDaysAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);
  const activeUsers7d = await settle(
    prismaClient.user.count({
      where: {
        updatedAt: { gte: sevenDaysAgo },
        isSuperAdmin: false,
        deletedAt: null,
      },
    }),
    null,
  );

  // Orgs total
  const orgsTotal = await settle(
    prismaClient.organization?.count?.() ?? Promise.resolve(null),
    null,
  );

  // MRR proxy — reuse the aggregator's plan-weighted active-sub count so
  // we report the same number the analytics dashboard does.
  let mrrUsd = null;
  try {
    const userStats = await adminStats.aggregateUserStats(prismaClient, {});
    mrrUsd = userStats?.mrrProxyUsd ?? null;
  } catch { /* leave null */ }

  // Active alerts — count of titles inside the dedup window.
  let activeAlerts = 0;
  try {
    if (alertingModuleResolved && typeof alertingModuleResolved.getActiveAlerts === 'function') {
      const snap = alertingModuleResolved.getActiveAlerts({ now: nowMs });
      activeAlerts = snap?.count || 0;
    }
  } catch { /* leave 0 */ }

  return {
    timestamp: new Date(nowMs).toISOString(),
    overall,
    services,
    crons: { stale: staleCronCount },
    users: { active7d: activeUsers7d },
    orgs: { total: orgsTotal },
    mrr: { estimatedUsd: mrrUsd },
    alerts: { active: activeAlerts },
  };
}

router.get('/system-summary', requireSuperAdmin, async (_req, res) => {
  try {
    const summary = await buildSystemSummary({});
    res.json(summary);
  } catch (err) {
    console.error('[admin/system-summary] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to build system summary' });
  }
});

// ── System snapshot (ratchet 45, super-admin) ──────────────────────────
// Single roll-up for ops audit / debug. Combines:
//   - summary       : buildSystemSummary() (overall, services, mrr, ...)
//   - health        : collectServiceHealth() (full probe detail)
//   - queues        : agent-task-queue counts (when Redis is configured)
//   - cron          : system-cron status() (jobs, lastRun, nextRun, ...)
//   - webhooks      : dispatcher.health() + dlqStats()
// Every sub-call is settled independently so a single failure doesn't
// blank the page — failed sections come back as `{ error: '...' }`.
router.get('/system-snapshot', requireSuperAdmin, async (_req, res) => {
  const settle = async (label, fn) => {
    try { return await fn(); }
    catch (err) {
      return { error: err && err.message ? err.message : String(err), section: label };
    }
  };

  const emailService = (() => { try { return require('../services/email'); } catch { return null; } })();
  const queueModule = (() => { try { return require('../services/agents/agent-task-queue'); } catch { return null; } })();
  const schedulerModule = (() => { try { return require('../services/scheduler/scheduler'); } catch { return null; } })();
  const socketModule = (() => { try { return require('../services/realtime/socket-server'); } catch { return null; } })();
  const systemCronModule = (() => { try { return require('../jobs/system-cron'); } catch { return null; } })();

  const [summary, health, queues, cron, webhooks] = await Promise.all([
    settle('summary', () => buildSystemSummary({})),
    settle('health', () => collectServiceHealth({
      prismaClient: prisma,
      env: process.env,
      stripeSvc: stripeService,
      emailSvc: emailService,
      queueModule,
      schedulerModule,
      socketModule,
      systemCronModule,
    })),
    settle('queues', async () => {
      if (!queueModule) return { enabled: false, reason: 'queue_module_missing' };
      if (!process.env.REDIS_URL) return { enabled: false, reason: 'redis_url_unset' };
      const h = await queueModule.getQueueHealth();
      return { enabled: true, queues: [{ name: h.queue, counts: h.counts }] };
    }),
    settle('cron', async () => {
      if (!systemCronModule || typeof systemCronModule.status !== 'function') {
        return { enabled: false, reason: 'system_cron_missing' };
      }
      return systemCronModule.status();
    }),
    settle('webhooks', async () => ({
      health: webhookDispatcher.health(),
      deliveryStats: webhookDispatcher.stats(),
      dlq: webhookDispatcher.dlqStats(),
    })),
  ]);

  res.json({
    generatedAt: new Date().toISOString(),
    summary,
    health,
    queues,
    cron,
    webhooks,
  });
});

router.get('/health/services', requireSuperAdmin, async (_req, res) => {
  try {
    const emailService = (() => { try { return require('../services/email'); } catch (_) { return null; } })();
    const queueModule = (() => { try { return require('../services/agents/agent-task-queue'); } catch (_) { return null; } })();
    const schedulerModule = (() => { try { return require('../services/scheduler/scheduler'); } catch (_) { return null; } })();
    const socketModule = (() => { try { return require('../services/realtime/socket-server'); } catch (_) { return null; } })();
    const snapshot = await collectServiceHealth({
      prismaClient: prisma,
      env: process.env,
      stripeSvc: stripeService,
      emailSvc: emailService,
      queueModule,
      schedulerModule,
      socketModule,
    });
    res.json(snapshot);
  } catch (err) {
    console.error('[admin/health/services] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to capture service health snapshot' });
  }
});

// ── Backup verification (super-admin only) ─────────────────────────────
// Cycle 15 ships a nightly pg_dump (scripts/backup-db.sh) that writes a
// JSON payload into system_settings(key='last_db_backup') after every
// successful run. This endpoint reads that row and reports:
//   - lastBackupAt (ISO timestamp from the backup script)
//   - sizeMB, sizeBytes (rounded to 2 decimals)
//   - retained (count of *.sql.gz files still on disk)
//   - retentionDays (BACKUP_RETENTION_DAYS at the time of last run)
//   - schedule (cron expression of the nightly job)
//   - nextBackupAt (computed from `schedule` via cron-expression util)
//
// When no row exists (fresh install or backup never ran) we return 200
// with `lastBackupAt: null` so the admin UI can render a "never run"
// state — distinct from a 5xx telling the operator something is broken.
router.get('/backups', requireSuperAdmin, async (_req, res) => {
  try {
    const row = await prisma.systemSettings.findUnique({
      where: { key: 'last_db_backup' },
    }).catch(() => null);

    if (!row || !row.value) {
      return res.json({
        ok: true,
        lastBackupAt: null,
        sizeMB: null,
        sizeBytes: null,
        retained: null,
        retentionDays: null,
        schedule: null,
        nextBackupAt: null,
        message: 'No backup metadata recorded yet — has scripts/backup-db.sh ever run?',
      });
    }

    let meta = {};
    try { meta = JSON.parse(row.value); } catch (_) { meta = {}; }

    // Next scheduled run — derive from `schedule` (defaults to nightly
    // 02:00 UTC, matching the cron entry in ops/cron.d).
    let nextBackupAt = null;
    const schedule = meta.schedule || '0 2 * * *';
    try {
      const cronExpr = require('../utils/cron-expression');
      if (cronExpr && typeof cronExpr.parseCron === 'function') {
        const parsed = cronExpr.parseCron(schedule);
        const next = cronExpr.nextRun(parsed, new Date());
        if (next instanceof Date) nextBackupAt = next.toISOString();
      }
    } catch (_) { /* leave nextBackupAt null on parse failure */ }

    const sizeBytes = Number(meta.sizeBytes) || 0;
    const sizeMB = sizeBytes > 0 ? Number((sizeBytes / (1024 * 1024)).toFixed(2)) : (meta.sizeMB ?? null);

    return res.json({
      ok: true,
      lastBackupAt: meta.timestamp || null,
      filename: meta.filename || null,
      sizeBytes: sizeBytes || null,
      sizeMB,
      retained: typeof meta.retained === 'number' ? meta.retained : null,
      retentionDays: typeof meta.retentionDays === 'number' || typeof meta.retentionDays === 'string'
        ? Number(meta.retentionDays)
        : null,
      schedule,
      nextBackupAt,
    });
  } catch (err) {
    console.error('[admin/backups] failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to read backup metadata' });
  }
});

// ── Prometheus /metrics exporter ─────────────────────────────────────────
// Exposed at the top-level `/metrics` path (mounted from index.js) — NOT
// behind `/api/admin/*` so Prometheus scrapers do not need the cookie
// jar / auth header dance. Gate: localhost callers always allowed (so a
// local Prometheus sidecar can scrape without credentials); remote
// callers must present a super-admin token.
//
// We deliberately do not put this on the `adminRoutes` router (which
// applies `authenticateToken, requireAdmin` to everything) — a local
// scraper has no token to present.
const _siraMetrics = require('../utils/metrics');
let _analyzerCachePrev = { hits: 0, misses: 0 };

function _isLocalhost(req) {
  const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '').toString();
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (ip.startsWith('::ffff:127.')) return true;
  return false;
}

async function metricsHandler(req, res) {
  // Auth gate: localhost OR super-admin via existing middleware chain.
  if (!_isLocalhost(req)) {
    // Replay the auth+admin chain manually so the gate is the same as
    // /api/admin/health/services. Each middleware short-circuits with
    // its own res.status() on failure.
    const _runChain = (mws) => new Promise((resolve, reject) => {
      let i = 0;
      const step = (err) => {
        if (err) return reject(err);
        if (res.headersSent) return resolve(false);
        if (i >= mws.length) return resolve(true);
        const mw = mws[i++];
        try { mw(req, res, step); } catch (e) { reject(e); }
      };
      step();
    });
    try {
      const ok = await _runChain([authenticateToken, requireAdmin, requireSuperAdmin]);
      if (!ok || res.headersSent) return;
    } catch (err) {
      if (!res.headersSent) {
        return res.status(500).json({ error: 'metrics auth failed', detail: err.message });
      }
      return;
    }
  }

  // Refresh dynamic gauges before rendering.
  try { _siraMetrics.refreshProcessMetrics(); } catch { /* noop */ }
  try {
    const documentProfessionalAnalyzer = require('../services/document-professional-analyzer');
    const snap = documentProfessionalAnalyzer.getAnalyzerHealthSnapshot();
    if (snap && snap.cache) {
      _analyzerCachePrev = _siraMetrics.recordAnalyzerCacheStats(
        _analyzerCachePrev.hits,
        _analyzerCachePrev.misses,
        snap.cache,
      );
    }
  } catch { /* analyzer optional */ }

  const body = _siraMetrics.renderText();
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.status(200).send(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// CYCLE 21 — Admin aggregation, queue management, user management & webhooks
// ─────────────────────────────────────────────────────────────────────────────

const STATS_CACHE = responseCache({ ttlMs: 60_000, namespace: 'admin-stats' });

async function _handleStatsRoute(fn, req, res, label) {
  try {
    const result = await fn(prisma, { from: req.query.from, to: req.query.to });
    res.json(result);
  } catch (err) {
    if (err instanceof RangeError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(`[admin/stats/${label}] failed:`, err && err.message ? err.message : err);
    res.status(500).json({ error: `Failed to aggregate ${label} stats` });
  }
}

router.get('/stats/users', requireSuperAdmin, STATS_CACHE, (req, res) =>
  _handleStatsRoute(adminStats.aggregateUserStats, req, res, 'users')
);
router.get('/stats/usage', requireSuperAdmin, STATS_CACHE, (req, res) =>
  _handleStatsRoute(adminStats.aggregateUsageStats, req, res, 'usage')
);
router.get('/stats/files', requireSuperAdmin, STATS_CACHE, (req, res) =>
  _handleStatsRoute(adminStats.aggregateFileStats, req, res, 'files')
);
router.get('/stats/agents', requireSuperAdmin, STATS_CACHE, (req, res) =>
  _handleStatsRoute(adminStats.aggregateAgentStats, req, res, 'agents')
);

// ── Queue dashboard ─────────────────────────────────────────────────────────
// The repo already exposes the BullMQ board at /api/admin/queues/board.
// These JSON endpoints add ergonomic admin-only operations for monitoring
// dashboards. Errors are surfaced as 503 when Redis is unconfigured so the
// UI can render an empty-state instead of a 500.
router.get('/queues', requireSuperAdmin, async (_req, res) => {
  try {
    const queueSvc = require('../services/agents/agent-task-queue');
    if (!process.env.REDIS_URL) {
      return res.status(503).json({ error: 'Queue subsystem disabled (REDIS_URL unset)', queues: [] });
    }
    const health = await queueSvc.getQueueHealth();
    res.json({ queues: [{ name: health.queue, counts: health.counts }] });
  } catch (err) {
    console.error('[admin/queues] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to read queue counts' });
  }
});

router.post('/queues/:name/retry-failed', requireSuperAdmin, async (req, res) => {
  try {
    const queueSvc = require('../services/agents/agent-task-queue');
    if (!process.env.REDIS_URL) {
      return res.status(503).json({ error: 'Queue subsystem disabled (REDIS_URL unset)' });
    }
    const q = queueSvc.getAgentTaskQueue();
    if (req.params.name !== queueSvc.getQueueName()) {
      return res.status(404).json({ error: 'Queue not found' });
    }
    const failed = await q.getFailed(0, 999);
    let retried = 0;
    for (const job of failed) {
      try { await job.retry(); retried += 1; } catch (_) { /* skip non-retryable */ }
    }
    void writeAuditLog(prisma, {
      actorType: 'admin',
      actorId: req.user?.id || null,
      actorName: req.user?.email || null,
      resourceType: 'queue',
      resourceId: req.params.name,
      action: 'retry_failed',
      after: { retried, totalFailed: failed.length },
    });
    res.json({ ok: true, retried, totalFailed: failed.length });
  } catch (err) {
    console.error('[admin/queues/retry-failed] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to retry failed jobs' });
  }
});

router.delete('/queues/:name/job/:id', requireSuperAdmin, async (req, res) => {
  try {
    const queueSvc = require('../services/agents/agent-task-queue');
    if (!process.env.REDIS_URL) {
      return res.status(503).json({ error: 'Queue subsystem disabled (REDIS_URL unset)' });
    }
    if (req.params.name !== queueSvc.getQueueName()) {
      return res.status(404).json({ error: 'Queue not found' });
    }
    const q = queueSvc.getAgentTaskQueue();
    const job = await q.getJob(String(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await job.remove();
    void writeAuditLog(prisma, {
      actorType: 'admin',
      actorId: req.user?.id || null,
      actorName: req.user?.email || null,
      resourceType: 'queue_job',
      resourceId: req.params.id,
      action: 'remove',
      metadata: { queue: req.params.name },
    });
    res.json({ ok: true, removed: req.params.id });
  } catch (err) {
    console.error('[admin/queues/job/delete] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to remove job' });
  }
});

// ── User search + management ───────────────────────────────────────────────
router.get('/users/search', requireSuperAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
    if (!q) return res.json({ users: [], q, limit });

    const users = await prisma.user.findMany({
      where: {
        AND: [
          { isSuperAdmin: false },
          {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true, email: true, name: true, plan: true, isAdmin: true,
        createdAt: true, deletedAt: true, subscriptionStatus: true,
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ users, q, limit });
  } catch (err) {
    console.error('[admin/users/search] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

router.get('/users/:id', requireSuperAdmin, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, email: true, name: true, plan: true, isAdmin: true,
        isSuperAdmin: true, apiUsage: true, monthlyLimit: true,
        monthlyCallLimit: true, subscriptionStatus: true, subscriptionEndDate: true,
        stripeCustomerId: true, locale: true, preferredTone: true,
        createdAt: true, updatedAt: true, deletedAt: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [chats, payments, auditLog] = await Promise.all([
      prisma.chat.findMany({
        where: { userId: user.id },
        select: { id: true, title: true, createdAt: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
      prisma.payment.findMany({
        where: { userId: user.id },
        select: { id: true, amount: true, currency: true, status: true, plan: true, provider: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.auditLog.findMany({
        where: { OR: [{ actorId: user.id }, { resourceType: 'user', resourceId: user.id }] },
        select: { id: true, action: true, resourceType: true, resourceId: true, createdAt: true, metadata: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }).catch(() => []),
    ]);

    res.json({
      user: serializeUser(user),
      chats,
      payments: serializeBigIntFields(payments),
      auditLog,
    });
  } catch (err) {
    console.error('[admin/users/:id] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to fetch user detail' });
  }
});

router.post('/users/:id/reset-password', requireSuperAdmin, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true, name: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

    // Email service is optional — admins still get the token in the response
    // so they can hand it to the user out-of-band when SMTP is unconfigured.
    let emailed = false;
    try {
      const emailService = require('../services/email');
      if (emailService && typeof emailService.isConfigured === 'function' && emailService.isConfigured()) {
        if (typeof emailService.sendPasswordReset === 'function') {
          await emailService.sendPasswordReset(user, { token, expiresAt });
          emailed = true;
        } else if (emailService.transporter && typeof emailService.transporter.sendMail === 'function') {
          const base = process.env.FRONTEND_URL || 'http://localhost:3000';
          await emailService.transporter.sendMail({
            from: process.env.SMTP_FROM || 'no-reply@siragpt.io',
            to: user.email,
            subject: 'Reset your SiraGPT password',
            text: `A password reset has been requested for your account.\n\nReset link: ${base}/reset-password?token=${token}\n\nThis link expires at ${expiresAt.toISOString()}.\nIf you did not request this, ignore this email.`,
          });
          emailed = true;
        }
      }
    } catch (mailErr) {
      console.error('[admin/users/reset-password] email failed:', mailErr.message);
    }

    void writeAuditLog(prisma, {
      actorType: 'admin',
      actorId: req.user?.id || null,
      actorName: req.user?.email || null,
      resourceType: 'user',
      resourceId: user.id,
      action: 'reset_password_issued',
      metadata: { emailed, expiresAt: expiresAt.toISOString(), tokenHash },
    });

    res.json({ ok: true, emailed, expiresAt, tokenHash });
  } catch (err) {
    console.error('[admin/users/reset-password] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to issue reset token' });
  }
});

router.post('/users/:id/grant-credits', requireSuperAdmin, async (req, res) => {
  try {
    const credits = Number(req.body?.credits);
    if (!Number.isFinite(credits) || credits <= 0) {
      return res.status(400).json({ error: 'credits must be a positive number' });
    }
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true, monthlyLimit: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const previousLimit = BigInt(user.monthlyLimit || 0);
    const newLimit = previousLimit + BigInt(Math.floor(credits));
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { monthlyLimit: newLimit },
      select: { id: true, email: true, monthlyLimit: true },
    });

    void writeAuditLog(prisma, {
      actorType: 'admin',
      actorId: req.user?.id || null,
      actorName: req.user?.email || null,
      resourceType: 'user',
      resourceId: user.id,
      action: 'grant_credits',
      before: { monthlyLimit: previousLimit.toString() },
      after: { monthlyLimit: newLimit.toString() },
      metadata: { credits, reason: req.body?.reason || null },
    });

    res.json({ ok: true, user: serializeUser(updated), granted: credits });
  } catch (err) {
    console.error('[admin/users/grant-credits] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to grant credits' });
  }
});

// ── Webhook delivery monitor ───────────────────────────────────────────────
router.get('/webhooks/deliveries', requireSuperAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const status = req.query.status ? String(req.query.status) : null;
    const event = req.query.event ? String(req.query.event) : null;
    const deliveries = webhookDispatcher.listDeliveries({ limit, status, event });
    res.json({ deliveries, stats: webhookDispatcher.stats() });
  } catch (err) {
    console.error('[admin/webhooks] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to list webhook deliveries' });
  }
});

router.post('/webhooks/deliveries/:id/retry', requireSuperAdmin, async (req, res) => {
  try {
    const result = await webhookDispatcher.retry(req.params.id, {
      secret: req.body?.secret || process.env.WEBHOOK_SECRET,
    });
    if (result?.reason === 'not_found') return res.status(404).json({ error: 'Delivery not found' });
    res.json(result);
  } catch (err) {
    console.error('[admin/webhooks/retry] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to retry webhook delivery' });
  }
});

// ── Webhook delivery health (ratchet 45, super-admin) ──────────────────────
// Aggregated view of the in-memory delivery ring buffer. Returns the four
// signals the admin dashboard cards render: total delivered in the last
// 24h, failure rate (failed / terminal), p95 delivery wall-clock latency
// (including retry backoff), and the count of deliveries currently in
// flight that have already retried at least once.
//   GET /api/admin/webhooks/health?windowHours=24
router.get('/webhooks/health', requireSuperAdmin, (req, res) => {
  try {
    // Clamp window between 1h and 30d so a typo can't make us scan a
    // negative or wildly out-of-range range. Default 24h matches the
    // dashboard contract documented in the route comment.
    const hoursRaw = Number(req.query.windowHours);
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
      ? Math.min(hoursRaw, 24 * 30)
      : 24;
    const windowMs = hours * 60 * 60 * 1000;
    const snapshot = webhookDispatcher.health({ windowMs });
    res.json({ ...snapshot, windowHours: hours });
  } catch (err) {
    console.error('[admin/webhooks/health] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to compute webhook health' });
  }
});

// ── Webhook DLQ (ratchet 45) ────────────────────────────────────────────
// Cycle 21 retries inline; once retries are exhausted the delivery is
// pushed to a dead-letter queue so operators can inspect payload + error
// + attempts and trigger a manual re-dispatch.
//   GET  /api/admin/webhooks/dlq                  → list failed deliveries
//   POST /api/admin/webhooks/dlq/:id/retry        → re-dispatch one item
router.get('/webhooks/dlq', requireSuperAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const event = req.query.event ? String(req.query.event) : null;
    const items = webhookDispatcher.listDLQ({ limit, event });
    res.json({ items, stats: webhookDispatcher.dlqStats() });
  } catch (err) {
    console.error('[admin/webhooks/dlq] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to list webhook DLQ' });
  }
});

router.post('/webhooks/dlq/:id/retry', requireSuperAdmin, async (req, res) => {
  try {
    const result = await webhookDispatcher.retryDLQItem(req.params.id, {
      secret: req.body?.secret || process.env.WEBHOOK_SECRET,
    });
    if (!result?.ok && result?.reason === 'not_found') {
      return res.status(404).json({ error: 'DLQ item not found' });
    }
    void writeAuditLog(prisma, {
      actorType: 'admin',
      actorId: req.user?.id || null,
      actorName: req.user?.email || null,
      resourceType: 'webhook_dlq',
      resourceId: req.params.id,
      action: 'retry',
      after: { status: result?.result?.status || 'unknown' },
    });
    res.json(result);
  } catch (err) {
    console.error('[admin/webhooks/dlq/retry] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to retry DLQ item' });
  }
});

router.post('/webhooks/retry-failed', requireSuperAdmin, async (req, res) => {
  try {
    const result = await webhookDispatcher.retryFailed({
      limit: Math.min(parseInt(req.body?.limit, 10) || 100, 500),
      since: req.body?.since || null,
      secretResolver: () => req.body?.secret || process.env.WEBHOOK_SECRET,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin/webhooks/retry-failed] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to retry failed webhooks' });
  }
});

// ── Audit log query DSL endpoint ───────────────────────────────────────────
// GET /api/admin/audit-logs?userId=&action=&resource=&resourceId=&orgId=&from=&to=&page=&limit=
router.get('/audit-logs', requireSuperAdmin, async (req, res) => {
  try {
    const result = await runAuditLogQuery(req);
    res.json(result);
  } catch (err) {
    console.error('[admin/audit-logs] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to query audit logs' });
  }
});

// ── Audit log CSV export ───────────────────────────────────────────────────
// GET /api/admin/audit-logs.csv — same query DSL as /audit-logs but
// streams a text/csv response for compliance / SIEM ingestion. Quoting
// follows RFC4180: any field containing ", \r, \n, or , is wrapped in
// double quotes with inner quotes doubled. JSON columns (`before`,
// `after`, `metadata`) are serialised inline.
router.get('/audit-logs.csv', requireSuperAdmin, async (req, res) => {
  try {
    // Force a generous default + cap so a CSV export doesn't degenerate
    // into a tiny paginated slice. Callers can still pass ?limit=.
    if (!req.query.limit) req.query.limit = '500';
    const result = await runAuditLogQuery(req);
    const items = Array.isArray(result.items) ? result.items : [];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-logs-${Date.now()}.csv"`,
    );
    res.write(auditLogsToCsv(items));
    res.end();
  } catch (err) {
    console.error('[admin/audit-logs.csv] failed:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

async function runAuditLogQuery(req) {
  const { query: auditQuery } = require('../services/audit-query');
  let q = auditQuery(prisma);
  if (req.query.userId) q = q.byUser(String(req.query.userId));
  if (req.query.action) q = q.byAction(String(req.query.action));
  if (req.query.resource) q = q.byResource(String(req.query.resource), req.query.resourceId ? String(req.query.resourceId) : null);
  if (req.query.orgId) q = q.byOrg(String(req.query.orgId));
  if (req.query.from || req.query.to) q = q.byDate(req.query.from || null, req.query.to || null);
  if (req.query.page) q = q.page(req.query.page);
  if (req.query.limit) q = q.limit(req.query.limit);
  return q.run();
}

const AUDIT_CSV_COLUMNS = [
  'id', 'createdAt', 'actorId', 'actorName', 'action',
  'resourceType', 'resourceId', 'ip', 'userAgent',
  'before', 'after', 'metadata',
];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') {
    try { s = JSON.stringify(value); } catch (_) { s = String(value); }
  } else {
    s = String(value);
  }
  // RFC4180: wrap in quotes if it contains quote, comma, CR, or LF.
  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function auditLogsToCsv(items) {
  const header = AUDIT_CSV_COLUMNS.join(',');
  const lines = [header];
  for (const row of items) {
    const cells = AUDIT_CSV_COLUMNS.map((col) => csvEscape(row?.[col]));
    lines.push(cells.join(','));
  }
  // Trailing newline for POSIX-friendly tools.
  return lines.join('\r\n') + '\r\n';
}

module.exports = router;
module.exports.metricsHandler = metricsHandler;
module.exports.INTERNAL_CSV = { auditLogsToCsv, csvEscape, AUDIT_CSV_COLUMNS };
module.exports.INTERNAL = {
  collectServiceHealth,
  buildSystemSummary,
  probePostgres,
  probeRedis,
  probeStripe,
  probeSmtp,
  probeProviders,
  probeProviderBoot,
  probeBullmqWorkers,
  probeScheduler,
  probeWebsocket,
  probeSystemCron,
  deriveOverall,
  withTimeout,
  PROBE_TIMEOUT_MS,
  adminStats,
  webhookDispatcher,
};
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
      res.setHeader('Content-Disposition', contentDispositionHeader('attachment', invoicePdfFilename(invoice)));
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

// ── Secret rotation (super-admin only) ──────────────────────────────────────
// Generates a fresh 32-byte cryptographic secret for one of the named
// rotatable secrets (currently `webhook_signing` and `csrf_pepper`).
// The new value is returned ONCE — the caller is expected to copy it
// to their secret manager / env. This endpoint deliberately does NOT
// mutate `process.env` or any persisted config: rotation in this
// codebase is operator-driven (the actual swap happens in the
// deployment pipeline), and writing to `process.env` from a request
// handler would be both racy and process-local.
//
// Audit logging records the rotation event (without the secret) so we
// have an immutable record of who initiated it and when.
const ROTATABLE_SECRETS = new Set(['webhook_signing', 'csrf_pepper']);

router.post('/maintenance/rotate-secret', requireSuperAdmin, async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    if (!ROTATABLE_SECRETS.has(name)) {
      return res.status(400).json({
        error: 'Invalid secret name',
        allowed: Array.from(ROTATABLE_SECRETS),
      });
    }

    // 32 bytes of CSPRNG output → 64-char hex string. Matches the
    // entropy of the webhook-signing keys generated by
    // `routes/webhooks.js` on endpoint creation.
    const secret = crypto.randomBytes(32).toString('hex');
    const rotatedAt = new Date().toISOString();

    // Best-effort audit log. The secret itself is never persisted —
    // only the metadata around the rotation event.
    void writeAuditLog(prisma, {
      actorType: 'admin',
      actorId: req.user?.id || null,
      actorName: req.user?.email || null,
      resourceType: 'maintenance',
      resourceId: `rotate-secret:${name}`,
      action: 'rotate_secret',
      after: { name, rotatedAt, length: secret.length },
      req,
    });

    res.json({
      ok: true,
      name,
      secret, // one-time display — operator must copy now
      rotatedAt,
      note: 'This secret is shown once. Copy it to your secret manager. '
        + 'It has NOT been applied to the running process or persisted by SiraGPT.',
    });
  } catch (error) {
    console.error('[admin/rotate-secret] failed:', error && error.message ? error.message : error);
    res.status(500).json({ error: 'Failed to rotate secret' });
  }
});
