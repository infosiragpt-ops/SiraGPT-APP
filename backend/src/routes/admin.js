const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const prisma = require('../config/database');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// Apply admin middleware to all routes
router.use(authenticateToken, requireAdmin);

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
  body('provider').trim().isLength({ min: 1 }).withMessage('Provider is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, displayName, provider, description, apiKey } = req.body;

    const model = await prisma.aiModel.create({
      data: {
        name,
        displayName,
        provider,
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
  body('provider').optional().trim().isLength({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { displayName, provider, description, apiKey, isActive } = req.body;
    const updateData = {};

    if (displayName) updateData.displayName = displayName;
    if (provider) updateData.provider = provider;
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
        plan ? { plan } : {}
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

    res.json({
      users,
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
      prisma.user.count(),
      prisma.chat.count(),
      prisma.message.count(),
      prisma.payment.count(),
      prisma.apiUsage.count()
    ]);

    // Get active users (last 7 days)
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const activeUsers = await prisma.user.count({
      where: {
        updatedAt: { gte: lastWeek }
      }
    });

    // Get revenue
    const revenue = await prisma.payment.aggregate({
      where: { status: 'COMPLETED' },
      _sum: { amount: true }
    });

    // Get users by plan
    const usersByPlan = await prisma.user.groupBy({
      by: ['plan'],
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

// Update user
router.put('/users/:id', async (req, res) => {
  try {
    const { plan, isAdmin, monthlyLimit } = req.body;
    const updateData = {};

    if (plan) updateData.plan = plan;
    if (typeof isAdmin === 'boolean') updateData.isAdmin = isAdmin;
    if (monthlyLimit) updateData.monthlyLimit = parseInt(monthlyLimit);

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
    });

    res.json({ user });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

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

module.exports = router;