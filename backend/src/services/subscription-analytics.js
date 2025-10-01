const prisma = require('../config/database');

class SubscriptionAnalyticsService {
  constructor() {
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    this.cache = new Map();
  }

  /**
   * Get comprehensive subscription analytics
   */
  async getSubscriptionAnalytics(period = '30d') {
    const cacheKey = `analytics_${period}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }
    }

    try {
      const analytics = {};

      // Get each analytics section with fallbacks
      try {
        analytics.revenue = await this.getRevenueAnalytics(period);
      } catch (error) {
        console.error('Error getting revenue analytics:', error);
        analytics.revenue = this.getFallbackRevenueData();
      }

      try {
        analytics.subscriptions = await this.getSubscriptionStats(period);
      } catch (error) {
        console.error('Error getting subscription stats:', error);
        analytics.subscriptions = this.getFallbackSubscriptionData();
      }

      try {
        analytics.conversions = await this.getConversionMetrics(period);
      } catch (error) {
        console.error('Error calculating conversion metrics:', error);
        analytics.conversions = this.getFallbackConversionData();
      }

      try {
        analytics.churn = await this.getChurnAnalytics(period);
      } catch (error) {
        console.error('Error calculating churn analytics:', error);
        analytics.churn = this.getFallbackChurnData();
      }

      try {
        analytics.usage = await this.getUsageAnalytics(period);
      } catch (error) {
        console.error('Error getting usage analytics:', error);
        analytics.usage = this.getFallbackUsageData();
      }

      try {
        analytics.trends = await this.getTrendAnalytics(period);
      } catch (error) {
        console.error('Error getting trend analytics:', error);
        analytics.trends = this.getFallbackTrendData();
      }

      // Cache the results
      this.cache.set(cacheKey, {
        data: analytics,
        timestamp: Date.now()
      });

      return analytics;

    } catch (error) {
      console.error('Error getting subscription analytics:', error);
      return this.getFallbackAnalyticsData();
    }
  }

  /**
   * Revenue analytics
   */
  async getRevenueAnalytics(period) {
    const dateFilter = this.getDateFilter(period);

    try {
      // Monthly Recurring Revenue (MRR)
      const activeSubscriptions = await prisma.user.findMany({
        where: {
          subscriptionStatus: 'active',
          plan: { not: 'FREE' }
        }
      });

      const planRevenue = {
        BASIC: 5,
        STANDARD: 15,
        ENTERPRISE: 99
      };

      const mrr = activeSubscriptions.reduce((total, user) => {
        return total + (planRevenue[user.plan] || 0);
      }, 0);

      // Total revenue in period
      const payments = await prisma.payment.findMany({
        where: {
          status: 'COMPLETED',
          createdAt: dateFilter
        }
      });

      const totalRevenue = payments.reduce((sum, payment) => sum + payment.amount, 0);

      // Revenue by plan
      const revenueByPlan = await prisma.payment.groupBy({
        by: ['plan'],
        where: {
          status: 'COMPLETED',
          createdAt: dateFilter
        },
        _sum: {
          amount: true
        },
        _count: true
      });

      // Daily revenue trend
      const dailyRevenue = await this.getDailyRevenueTrend(dateFilter);

      return {
        mrr,
        totalRevenue,
        revenueByPlan: revenueByPlan.map(item => ({
          plan: item.plan,
          revenue: item._sum.amount || 0,
          count: item._count
        })),
        dailyRevenue,
        averageRevenuePerUser: activeSubscriptions.length > 0 ? mrr / activeSubscriptions.length : 0
      };

    } catch (error) {
      console.error('Error calculating revenue analytics:', error);
      throw error;
    }
  }

  /**
   * Subscription statistics
   */
  async getSubscriptionStats(period) {
    const dateFilter = this.getDateFilter(period);

    try {
      // Total active subscriptions
      const activeSubscriptions = await prisma.user.count({
        where: {
          subscriptionStatus: 'active',
          plan: { not: 'FREE' }
        }
      });

      // New subscriptions in period
      const newSubscriptions = await prisma.subscriptionEvent.count({
        where: {
          eventType: 'created',
          processedAt: dateFilter
        }
      });

      // Cancelled subscriptions in period
      const cancelledSubscriptions = await prisma.subscriptionEvent.count({
        where: {
          eventType: 'plan_change_cancelled',
          processedAt: dateFilter
        }
      });

      // Plan distribution
      const planDistribution = await prisma.user.groupBy({
        by: ['plan'],
        where: {
          plan: { not: 'FREE' },
          subscriptionStatus: 'active'
        },
        _count: true
      });

      // Subscription status breakdown
      const statusBreakdown = await prisma.user.groupBy({
        by: ['subscriptionStatus'],
        where: {
          plan: { not: 'FREE' }
        },
        _count: true
      });

      return {
        active: activeSubscriptions,
        new: newSubscriptions,
        cancelled: cancelledSubscriptions,
        netGrowth: newSubscriptions - cancelledSubscriptions,
        planDistribution: planDistribution.map(item => ({
          plan: item.plan,
          count: item._count,
          percentage: (item._count / activeSubscriptions * 100).toFixed(1)
        })),
        statusBreakdown: statusBreakdown.map(item => ({
          status: item.subscriptionStatus,
          count: item._count
        }))
      };

    } catch (error) {
      console.error('Error calculating subscription stats:', error);
      throw error;
    }
  }

  /**
   * Conversion metrics
   */
  async getConversionMetrics(period) {
    const dateFilter = this.getDateFilter(period);

    try {
      // Free users
      const freeUsers = await prisma.user.count({
        where: {
          plan: 'FREE',
          createdAt: dateFilter
        }
      });

      // Free to paid conversions
      const conversions = await prisma.subscriptionEvent.count({
        where: {
          eventType: 'created',
          previousPlan: 'FREE',
          processedAt: dateFilter
        }
      });

      // Conversion rate
      const conversionRate = freeUsers > 0 ? (conversions / freeUsers * 100).toFixed(2) : 0;

      // Time to conversion (average days from signup to first subscription)
      const conversionEvents = await prisma.subscriptionEvent.findMany({
        where: {
          eventType: 'created',
          previousPlan: 'FREE',
          processedAt: dateFilter
        },
        include: {
          user: {
            select: {
              createdAt: true
            }
          }
        }
      });

      let avgDaysToConvert = 0;
      if (conversionEvents.length > 0) {
        const totalDays = conversionEvents.reduce((sum, event) => {
          const daysDiff = (new Date(event.processedAt) - new Date(event.user.createdAt)) / (1000 * 60 * 60 * 24);
          return sum + daysDiff;
        }, 0);
        avgDaysToConvert = totalDays / conversionEvents.length;
      }

      // Plan upgrade/downgrade patterns
      const planChanges = await prisma.subscriptionEvent.findMany({
        where: {
          eventType: { in: ['plan_changed_immediate', 'plan_changed_scheduled'] },
          processedAt: dateFilter
        },
        select: {
          previousPlan: true,
          newPlan: true
        }
      });

      const upgradeDowngradeStats = this.analyzePlanChanges(planChanges);

      return {
        freeUsers,
        conversions,
        conversionRate: parseFloat(conversionRate),
        averageDaysToConvert: avgDaysToConvert || 0,
        planChanges: upgradeDowngradeStats
      };

    } catch (error) {
      console.error('Error calculating conversion metrics:', error);
      throw error;
    }
  }

  /**
   * Churn analytics
   */
  async getChurnAnalytics(period) {
    const dateFilter = this.getDateFilter(period);

    try {
      // Calculate monthly churn rate
      const startOfPeriod = await prisma.user.count({
        where: {
          plan: { not: 'FREE' },
          subscriptionStatus: 'active',
          createdAt: { lt: dateFilter.gte }
        }
      });

      const churned = await prisma.subscriptionEvent.count({
        where: {
          eventType: 'plan_change_cancelled',
          processedAt: dateFilter
        }
      });

      const churnRate = startOfPeriod > 0 ? (churned / startOfPeriod * 100).toFixed(2) : 0;

      // Churn reasons (if we track them)
      const churnReasons = await this.getChurnReasons(dateFilter);

      // Lifetime value calculation
      const ltv = await this.calculateLifetimeValue();

      return {
        churnedCustomers: churned,
        churnRate: parseFloat(churnRate),
        churnReasons,
        lifetimeValue: ltv,
        retentionRate: (100 - parseFloat(churnRate)).toFixed(2)
      };

    } catch (error) {
      console.error('Error calculating churn analytics:', error);
      throw error;
    }
  }

  /**
   * Usage analytics
   */
  async getUsageAnalytics(period) {
    const dateFilter = this.getDateFilter(period);

    try {
      // Average API usage per plan
      const usageByPlan = await prisma.user.groupBy({
        by: ['plan'],
        where: {
          plan: { not: 'FREE' }
        },
        _avg: {
          apiUsage: true
        },
        _count: true
      });

      // Heavy users (using > 80% of their limit)
      const allPaidUsers = await prisma.user.findMany({
        where: {
          plan: { not: 'FREE' }
        },
        select: {
          apiUsage: true,
          monthlyLimit: true
        }
      });

      const heavyUsers = allPaidUsers.filter(user => 
        user.apiUsage >= (user.monthlyLimit * 0.8)
      ).length;

      // Usage trends
      const usageTrends = await this.getUsageTrends(dateFilter);

      return {
        usageByPlan: usageByPlan.map(item => ({
          plan: item.plan,
          averageUsage: item._avg.apiUsage || 0,
          userCount: item._count
        })),
        heavyUsers,
        usageTrends
      };

    } catch (error) {
      console.error('Error calculating usage analytics:', error);
      throw error;
    }
  }

  /**
   * Trend analytics
   */
  async getTrendAnalytics(period) {
    try {
      const previous_period = this.getPreviousPeriodFilter(period);
      
      const current = await this.getSubscriptionStats(period);
      const previous = await this.getSubscriptionStats(previous_period);

      const trends = {
        activeSubscriptions: {
          current: current.active,
          previous: previous.active,
          change: current.active - previous.active,
          percentageChange: previous.active > 0 ? 
            ((current.active - previous.active) / previous.active * 100).toFixed(1) : 0
        },
        newSubscriptions: {
          current: current.new,
          previous: previous.new,
          change: current.new - previous.new,
          percentageChange: previous.new > 0 ? 
            ((current.new - previous.new) / previous.new * 100).toFixed(1) : 0
        }
      };

      return trends;

    } catch (error) {
      console.error('Error calculating trend analytics:', error);
      throw error;
    }
  }

  /**
   * Helper methods
   */
  getDateFilter(period) {
    const now = new Date();
    let startDate;

    switch(period) {
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }

    return { gte: startDate, lte: now };
  }

  getPreviousPeriodFilter(period) {
    const current = this.getDateFilter(period);
    const periodLength = current.lte.getTime() - current.gte.getTime();
    
    return {
      gte: new Date(current.gte.getTime() - periodLength),
      lte: current.gte
    };
  }

  async getDailyRevenueTrend(dateFilter) {
    try {
      const dailyData = await prisma.payment.findMany({
        where: {
          status: 'COMPLETED',
          createdAt: dateFilter
        },
        select: {
          amount: true,
          createdAt: true
        }
      });

      const dailyRevenue = {};
      dailyData.forEach(payment => {
        const day = payment.createdAt.toISOString().split('T')[0];
        dailyRevenue[day] = (dailyRevenue[day] || 0) + payment.amount;
      });

      return Object.entries(dailyRevenue).map(([date, revenue]) => ({
        date,
        revenue
      }));

    } catch (error) {
      console.error('Error getting daily revenue trend:', error);
      return [];
    }
  }

  analyzePlanChanges(planChanges) {
    const upgrades = planChanges.filter(change => {
      const planValues = { BASIC: 1, STANDARD: 2, ENTERPRISE: 3 };
      return planValues[change.newPlan] > planValues[change.previousPlan];
    });

    const downgrades = planChanges.filter(change => {
      const planValues = { BASIC: 1, STANDARD: 2, ENTERPRISE: 3 };
      return planValues[change.newPlan] < planValues[change.previousPlan];
    });

    return {
      upgrades: upgrades.length,
      downgrades: downgrades.length,
      total: planChanges.length
    };
  }

  async getChurnReasons(dateFilter) {
    // This would require additional data collection
    // For now, return basic categorization
    return [
      { reason: 'Price', count: 0 },
      { reason: 'Features', count: 0 },
      { reason: 'Usage', count: 0 },
      { reason: 'Other', count: 0 }
    ];
  }

  async calculateLifetimeValue() {
    try {
      const avgMonthlyRevenue = await prisma.payment.aggregate({
        where: {
          status: 'COMPLETED'
        },
        _avg: {
          amount: true
        }
      });

      // Simplified LTV calculation (avg monthly revenue * avg lifespan)
      // In practice, you'd calculate actual customer lifespan
      const avgLifespanMonths = 12; // Assumption
      
      return (avgMonthlyRevenue._avg.amount || 0) * avgLifespanMonths;

    } catch (error) {
      console.error('Error calculating LTV:', error);
      return 0;
    }
  }

  async getUsageTrends(dateFilter) {
    // Simplified usage trends - in practice you'd aggregate usage data
    return [];
  }

  /**
   * Clear analytics cache
   */
  clearCache() {
    this.cache.clear();
    console.log('Analytics cache cleared');
  }

  // Fallback data methods for when database tables don't exist or have errors
  getFallbackRevenueData() {
    return {
      totalRevenue: 0,
      monthlyRecurringRevenue: 0,
      averageRevenuePerUser: 0,
      revenueGrowthRate: 0,
      revenueByPlan: {},
      revenueTimeline: []
    };
  }

  getFallbackSubscriptionData() {
    return {
      totalSubscriptions: 0,
      activeSubscriptions: 0,
      newSubscriptions: 0,
      canceledSubscriptions: 0,
      subscriptionsByPlan: { FREE: 0, BASIC: 0, STANDARD: 0, ENTERPRISE: 0 },
      subscriptionTimeline: []
    };
  }

  getFallbackConversionData() {
    return {
      totalFreeUsers: 0,
      conversions: 0,
      conversionRate: 0,
      averageDaysToConvert: 0,
      planChanges: {
        upgrades: 0,
        downgrades: 0,
        popular_upgrades: [],
        popular_downgrades: []
      }
    };
  }

  getFallbackChurnData() {
    return {
      churnRate: 0,
      churnedUsers: 0,
      retainedUsers: 0,
      averageLifetime: 0,
      churnReasons: {},
      cohortRetention: []
    };
  }

  getFallbackUsageData() {
    return {
      usageByPlan: [],
      heavyUsers: 0,
      usageTrends: [],
      averageSessionLength: 0,
      popularFeatures: []
    };
  }

  getFallbackTrendData() {
    return {
      userGrowth: [],
      revenueGrowth: [],
      conversionTrends: [],
      churnTrends: []
    };
  }

  getFallbackAnalyticsData() {
    return {
      revenue: this.getFallbackRevenueData(),
      subscriptions: this.getFallbackSubscriptionData(),
      conversions: this.getFallbackConversionData(),
      churn: this.getFallbackChurnData(),
      usage: this.getFallbackUsageData(),
      trends: this.getFallbackTrendData()
    };
  }
}

module.exports = new SubscriptionAnalyticsService();