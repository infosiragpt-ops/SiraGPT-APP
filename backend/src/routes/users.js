const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const bcrypt = require('bcryptjs');

const router = express.Router();

// Get current user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        plan: true,
        isAdmin: true,
        apiUsage: true,
        monthlyLimit: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update user profile
router.put('/profile', [
  body('name').optional().trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('email').optional().isEmail().normalizeEmail().withMessage('Valid email required')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    if (email) {
      // Check if email is already taken by another user
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
          NOT: { id: req.user.id }
        }
      });

      if (existingUser) {
        return res.status(400).json({ error: 'Email already in use' });
      }

      updateData.email = email;
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
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
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Change password
router.put('/password', [
  body('currentPassword').notEmpty().withMessage('Current password required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    // Get user with password
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update password
    await prisma.user.update({
      where: { id: req.user.id },
      data: { password: hashedPassword }
    });

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Get user usage stats
router.get('/usage', authenticateToken, async (req, res) => {
  try {
    const { period = '30' } = req.query;
    const days = parseInt(period);
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [apiUsage, totalCost, messageCount] = await Promise.all([
      prisma.apiUsage.findMany({
        where: {
          userId: req.user.id,
          timestamp: { gte: startDate }
        },
        orderBy: { timestamp: 'desc' }
      }),
      prisma.apiUsage.aggregate({
        where: {
          userId: req.user.id,
          timestamp: { gte: startDate }
        },
        _sum: { cost: true }
      }),
      prisma.message.count({
        where: {
          chat: { userId: req.user.id },
          timestamp: { gte: startDate }
        }
      })
    ]);

    // Group usage by day
    const usageByDay = apiUsage.reduce((acc, usage) => {
      const day = usage.timestamp.toISOString().slice(0, 10);
      if (!acc[day]) {
        acc[day] = { tokens: 0, cost: 0, calls: 0 };
      }
      acc[day].tokens += usage.tokens;
      acc[day].cost += usage.cost;
      acc[day].calls += 1;
      return acc;
    }, {});

    // Group usage by model
    const usageByModel = apiUsage.reduce((acc, usage) => {
      if (!acc[usage.model]) {
        acc[usage.model] = { tokens: 0, cost: 0, calls: 0 };
      }
      acc[usage.model].tokens += usage.tokens;
      acc[usage.model].cost += usage.cost;
      acc[usage.model].calls += 1;
      return acc;
    }, {});

    res.json({
      summary: {
        totalTokens: apiUsage.reduce((sum, usage) => sum + usage.tokens, 0),
        totalCost: totalCost._sum.cost || 0,
        totalCalls: apiUsage.length,
        messageCount,
        currentUsage: req.user.apiUsage,
        monthlyLimit: req.user.monthlyLimit,
        usagePercentage: (req.user.apiUsage / req.user.monthlyLimit) * 100
      },
      usageByDay,
      usageByModel,
      recentUsage: apiUsage.slice(0, 10)
    });
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to fetch usage stats' });
  }
});

// Delete user account
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    // Delete user and all related data (cascading deletes handled by Prisma)
    await prisma.user.delete({
      where: { id: req.user.id }
    });

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;