const prisma = require('../config/database');
// const emailService = require('./email'); // Commented out temporarily

class UsageMonitorService {
  constructor() {
    this.warningThresholds = [0.8, 0.9, 1.0]; // 80%, 90%, 100%
  }

  /**
   * Check user's usage and send alerts if thresholds are crossed
   */
  async checkUsageAndAlert(userId) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) return;

      const usagePercentage = user.apiUsage / user.monthlyLimit;
      const callUsagePercentage = user.monthlyCallLimit > 0 ? user.monthlyCallLimit / (user.plan === 'FREE' ? 3 : 1000) : 0;

      // Check API usage alerts
      await this.checkApiUsageAlerts(user, usagePercentage);
      
      // Check call limit alerts  
      await this.checkCallLimitAlerts(user, callUsagePercentage);

      return {
        apiUsage: {
          current: user.apiUsage,
          limit: user.monthlyLimit,
          percentage: usagePercentage
        },
        callUsage: {
          current: user.monthlyCallLimit,
          limit: user.plan === 'FREE' ? 3 : 1000,
          percentage: callUsagePercentage
        }
      };

    } catch (error) {
      console.error('Error checking usage:', error);
      throw error;
    }
  }

  async checkApiUsageAlerts(user, usagePercentage) {
    // Check if user has crossed any threshold
    const lastAlertSent = await this.getLastAlertSent(user.id, 'api_usage');
    
    for (const threshold of this.warningThresholds) {
      if (usagePercentage >= threshold && (!lastAlertSent || lastAlertSent.threshold < threshold)) {
        await this.sendUsageAlert(user, threshold, 'api_usage', {
          current: user.apiUsage,
          limit: user.monthlyLimit,
          percentage: usagePercentage
        });

        // Record alert sent
        await this.recordAlertSent(user.id, 'api_usage', threshold);
      }
    }
  }

  async checkCallLimitAlerts(user, callUsagePercentage) {
    if (user.plan === 'FREE') {
      const callThreshold = user.monthlyCallLimit / 3;
      
      if (callThreshold >= 0.8) {
        const lastAlertSent = await this.getLastAlertSent(user.id, 'call_usage');
        
        if (!lastAlertSent || new Date() - new Date(lastAlertSent.sentAt) > 24 * 60 * 60 * 1000) {
          await this.sendUsageAlert(user, callThreshold, 'call_usage', {
            current: user.monthlyCallLimit,
            limit: 3,
            percentage: callThreshold
          });

          await this.recordAlertSent(user.id, 'call_usage', callThreshold);
        }
      }
    }
  }

  async sendUsageAlert(user, threshold, type, usage) {
    const percentage = Math.round(threshold * 100);
    
    try {
      // Email notification
      // if (emailService.isConfigured) {
      //   await emailService.sendUsageAlert(user, {
      //     type,
      //     threshold: percentage,
      //     usage
      //   });
      // } // Commented out temporarily

      // In-app notification (store in database for UI to show)
      await this.createInAppNotification(user.id, {
        type: 'usage_warning',
        title: `${percentage}% Usage Alert`,
        message: type === 'api_usage' 
          ? `You've used ${percentage}% of your monthly API limit (${usage.current.toLocaleString()}/${usage.limit.toLocaleString()})`
          : `You've used ${usage.current} of ${usage.limit} monthly calls`,
        severity: percentage >= 100 ? 'critical' : percentage >= 90 ? 'warning' : 'info'
      });

      console.log(`Usage alert sent to user ${user.id}: ${percentage}% ${type}`);
      
    } catch (error) {
      console.error('Error sending usage alert:', error);
    }
  }

  async createInAppNotification(userId, notification) {
    return await prisma.notification.create({
      data: {
        userId,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        severity: notification.severity,
        read: false,
        createdAt: new Date()
      }
    });
  }

  async getLastAlertSent(userId, alertType) {
    return await prisma.usageAlert.findFirst({
      where: {
        userId,
        alertType
      },
      orderBy: {
        sentAt: 'desc'
      }
    });
  }

  async recordAlertSent(userId, alertType, threshold) {
    return await prisma.usageAlert.create({
      data: {
        userId,
        alertType,
        threshold,
        sentAt: new Date()
      }
    });
  }

  /**
   * Reset monthly usage and alerts (called at the start of each billing cycle)
   */
  async resetMonthlyUsage(userId) {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: {
          apiUsage: 0,
          monthlyCallLimit: 0
        }
      });

      // Clear usage alerts for the new period
      await prisma.usageAlert.deleteMany({
        where: {
          userId,
          sentAt: {
            lt: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
          }
        }
      });

      console.log(`Monthly usage reset for user ${userId}`);
      
    } catch (error) {
      console.error('Error resetting monthly usage:', error);
      throw error;
    }
  }

  /**
   * Get usage statistics for analytics
   */
  async getUsageStats(userId, period = 'current_month') {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          apiUsages: {
            where: period === 'current_month' ? {
              timestamp: {
                gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
              }
            } : {},
            orderBy: { timestamp: 'desc' },
            take: 100
          }
        }
      });

      if (!user) throw new Error('User not found');

      // Decimal/BigInt-safe coercion: Prisma surfaces money/usage
      // columns as Decimal.js or BigInt depending on the driver, and
      // either one throws "Cannot mix BigInt and other types" the
      // moment it touches a plain Number 0. Funnel everything through
      // Number() before arithmetic.
      const asNumber = (v) => {
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'bigint') return Number(v);
        if (typeof v.toNumber === 'function') return v.toNumber();
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      const usageByDay = {};
      user.apiUsages.forEach(usage => {
        const day = usage.timestamp.toISOString().split('T')[0];
        if (!usageByDay[day]) {
          usageByDay[day] = { tokens: 0, cost: 0, calls: 0 };
        }
        usageByDay[day].tokens += asNumber(usage.tokens);
        usageByDay[day].cost += asNumber(usage.cost);
        usageByDay[day].calls += 1;
      });

      return {
        currentUsage: {
          apiCalls: user.apiUsage,
          monthlyCalls: user.monthlyCallLimit,
          limit: user.monthlyLimit,
          plan: user.plan
        },
        dailyBreakdown: usageByDay,
        projectedUsage: this.calculateProjectedUsage(user),
        recommendations: this.getUsageRecommendations(user)
      };

    } catch (error) {
      console.error('Error getting usage stats:', error);
      throw error;
    }
  }

  calculateProjectedUsage(user) {
    // user.apiUsage / user.monthlyLimit can be BigInt depending on the
    // schema; coerce to plain Number before arithmetic so the math
    // doesn't blow up with "Cannot mix BigInt and other types".
    const apiUsage = Number(user.apiUsage || 0);
    const monthlyLimit = Number(user.monthlyLimit || 0);
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const daysPassed = new Date().getDate();
    const dailyAverage = apiUsage / daysPassed;
    const projectedMonthly = dailyAverage * daysInMonth;

    return {
      projectedTotal: Math.round(projectedMonthly),
      dailyAverage: Math.round(dailyAverage),
      willExceedLimit: projectedMonthly > monthlyLimit,
      exceedBy: projectedMonthly > monthlyLimit ? Math.round(projectedMonthly - monthlyLimit) : 0
    };
  }

  getUsageRecommendations(user) {
    const recommendations = [];
    const apiUsage = Number(user.apiUsage || 0);
    const monthlyLimit = Number(user.monthlyLimit || 0);
    const usagePercentage = monthlyLimit > 0 ? apiUsage / monthlyLimit : 0;

    if (usagePercentage > 0.8 && user.plan === 'FREE') {
      recommendations.push({
        type: 'upgrade',
        message: 'Consider upgrading to Basic plan for 10,000 API calls/month',
        action: 'upgrade_to_basic'
      });
    }

    if (usagePercentage > 0.9 && user.plan === 'BASIC') {
      recommendations.push({
        type: 'upgrade',
        message: 'Consider upgrading to Standard plan for 30,000 API calls/month',
        action: 'upgrade_to_standard'
      });
    }

    if (usagePercentage < 0.3 && user.plan !== 'FREE') {
      recommendations.push({
        type: 'optimize',
        message: 'You are using less than 30% of your plan. Consider optimizing your usage.',
        action: 'view_usage_tips'
      });
    }

    return recommendations;
  }
}

module.exports = new UsageMonitorService();