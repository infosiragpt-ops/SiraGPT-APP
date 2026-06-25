const stripeService = require('./stripe');
const prisma = require('../config/database');
const { logger } = require('../middleware/logger');
const { redactErrorMessage } = require('../utils/secret-redactor');
const { monthlyLimitForStripePlan } = require('./plan-credits-catalog');

function logProrationError(operation, error, context = {}) {
  if (error?.isStripeOperationalError || stripeService.isStripeLikeError?.(error)) return;
  logger.error({
    operation,
    error: {
      name: error?.name || 'Error',
      message: redactErrorMessage(error),
      code: error?.code || undefined,
    },
    ...context,
  }, `proration.${operation}.failed`);
}

function logProrationWarning(operation, error, context = {}) {
  logger.warn({
    operation,
    error: {
      name: error?.name || 'Error',
      message: redactErrorMessage(error),
      code: error?.code || undefined,
    },
    ...context,
  }, `proration.${operation}.warning`);
}

class ProrationService {
  constructor() {
    this.taxRate = 0; // Set tax rate if applicable
  }

  /**
   * Calculate prorated amount for plan change
   */
  async calculateProration(userId, newPlan, changeDate = new Date()) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user || !user.stripeSubscriptionId) {
        throw new Error('User has no active subscription');
      }

      // Get current subscription from Stripe
      const subscription = await stripeService.retrieveSubscription(user.stripeSubscriptionId);
      
      const currentPeriodStart = new Date(subscription.current_period_start * 1000);
      const currentPeriodEnd = new Date(subscription.current_period_end * 1000);
      const totalPeriodDays = Math.ceil((currentPeriodEnd - currentPeriodStart) / (1000 * 60 * 60 * 24));
      const remainingDays = Math.ceil((currentPeriodEnd - changeDate) / (1000 * 60 * 60 * 24));

      // Plan pricing (in cents)
      const planPricing = {
        'PRO': 500,        // $5.00
        'PRO_MAX': 2000,   // $20.00
        'ENTERPRISE': 20000 // $200.00
      };

      const currentPlanPrice = planPricing[user.plan];
      const newPlanPrice = planPricing[newPlan];

      // Calculate unused portion of current plan
      const unusedAmount = (currentPlanPrice * remainingDays) / totalPeriodDays;

      // Calculate prorated amount for new plan
      const newPlanProrated = (newPlanPrice * remainingDays) / totalPeriodDays;

      // Net amount (positive = charge, negative = credit)
      const netAmount = newPlanProrated - unusedAmount;

      return {
        currentPlan: user.plan,
        newPlan,
        currentPlanPrice: currentPlanPrice / 100,
        newPlanPrice: newPlanPrice / 100,
        totalPeriodDays,
        remainingDays,
        unusedAmount: unusedAmount / 100,
        newPlanProrated: newPlanProrated / 100,
        netAmount: netAmount / 100,
        isUpgrade: newPlanPrice > currentPlanPrice,
        isDowngrade: newPlanPrice < currentPlanPrice,
        changeDate: changeDate.toISOString(),
        currentPeriodEnd: currentPeriodEnd.toISOString()
      };

    } catch (error) {
      logProrationError('calculate', error, { userId, newPlan });
      throw error;
    }
  }

  /**
   * Execute plan change with proration
   */
  async changePlan(userId, newPlan, immediate = true) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user || !user.stripeSubscriptionId) {
        throw new Error('User has no active subscription');
      }

      // Don't allow changing to the same plan
      if (user.plan === newPlan) {
        throw new Error('User is already on this plan');
      }

      // Calculate proration
      const proration = await this.calculateProration(userId, newPlan);

      // Get new plan's price ID
      const newPriceId = await this.getPriceIdForPlan(newPlan);

      if (!newPriceId) {
        throw new Error(`Price ID not found for plan: ${newPlan}`);
      }

      // Update subscription in Stripe
      let stripeResult;
      if (immediate) {
        // Immediate change with proration
        stripeResult = await this.executeImmediatePlanChange(user, newPlan, newPriceId, proration);
      } else {
        // Change at next billing cycle
        stripeResult = await this.scheduleNextCyclePlanChange(user, newPlan, newPriceId);
      }

      // Update database — ADD the new plan's baseline grant to the existing
      // monthlyLimit, mirroring the Stripe webhook's credit-grant semantics
      // (routes/payments.js). The grant comes from the shared plan-credits
      // catalog so proration and the webhook can never diverge — they
      // previously granted 5× different amounts for PRO/PRO_MAX (500k vs 100k).
      // `monthlyLimit` is BigInt in Prisma, so BOTH operands must be BigInt:
      // `bigint + number` throws, which used to crash every immediate plan
      // change *after* Stripe had already charged the customer.
      const currentUser = await prisma.user.findUnique({ where: { id: userId } });
      const currentLimit = typeof currentUser?.monthlyLimit === 'bigint'
        ? currentUser.monthlyLimit
        : BigInt(currentUser?.monthlyLimit ?? 0);
      const newTotalLimit = currentLimit + monthlyLimitForStripePlan(newPlan);

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          plan: newPlan,
          monthlyLimit: newTotalLimit,
          subscriptionStatus: 'active'
          // monthlyCallLimit: NOT UPDATED - preserve current usage
        }
      });

      // Record the plan change event
      await prisma.subscriptionEvent.create({
        data: {
          userId,
          eventType: immediate ? 'plan_changed_immediate' : 'plan_changed_scheduled',
          previousPlan: user.plan,
          newPlan,
          eventData: {
            proration,
            stripeSubscriptionId: user.stripeSubscriptionId,
            immediate
          }
        }
      });

      // Create notification
      await prisma.notification.create({
        data: {
          userId,
          type: 'plan_changed',
          title: `Plan ${immediate ? 'Changed' : 'Change Scheduled'}`,
          message: immediate 
            ? `Your plan has been changed to ${newPlan}. ${proration.netAmount >= 0 ? `Additional charge: $${proration.netAmount.toFixed(2)}` : `Credit applied: $${Math.abs(proration.netAmount).toFixed(2)}`}`
            : `Your plan will change to ${newPlan} on your next billing cycle.`,
          severity: 'info',
          metadata: { proration, immediate }
        }
      });

      return {
        success: true,
        user: updatedUser,
        proration,
        stripeResult,
        immediate
      };

    } catch (error) {
      logProrationError('changePlan', error, { userId, newPlan, immediate });
      throw error;
    }
  }

  /**
   * Execute immediate plan change with proration
   */
  async executeImmediatePlanChange(user, newPlan, newPriceId, proration) {
    try {
      const subscription = await stripeService.retrieveSubscription(user.stripeSubscriptionId);

      // Update the subscription with new price
      const updatedSubscription = await stripeService.updateSubscription(
        user.stripeSubscriptionId,
        {
          items: [{
            id: subscription.items.data[0].id,
            price: newPriceId,
          }],
          proration_behavior: 'create_prorations', // This creates prorations automatically
          billing_cycle_anchor: 'unchanged' // Keep same billing cycle
        },
        'executeImmediatePlanChange'
      );

      return updatedSubscription;

    } catch (error) {
      logProrationError('executeImmediatePlanChange', error, { userId: user.id, newPlan });
      throw error;
    }
  }

  /**
   * Schedule plan change for next billing cycle
   */
  async scheduleNextCyclePlanChange(user, newPlan, newPriceId) {
    try {
      const subscription = await stripeService.retrieveSubscription(user.stripeSubscriptionId);

      // Schedule the change for the next billing cycle
      const scheduledChange = await stripeService.updateSubscription(
        user.stripeSubscriptionId,
        {
          items: [{
            id: subscription.items.data[0].id,
            price: newPriceId,
          }],
          proration_behavior: 'none', // No prorations for next-cycle changes
        },
        'scheduleNextCyclePlanChange'
      );

      return scheduledChange;

    } catch (error) {
      logProrationError('scheduleNextCyclePlanChange', error, { userId: user.id, newPlan });
      throw error;
    }
  }

  /**
   * Get price ID for a plan from system settings
   */
  async getPriceIdForPlan(plan) {
    try {
      const setting = await prisma.systemSettings.findUnique({
        where: { key: `STRIPE_PRICE_${plan}` }
      });

      return setting?.value;
    } catch (error) {
      logProrationError('getPriceIdForPlan', error, { plan });
      return null;
    }
  }

  /**
   * Preview plan change without executing it
   */
  async previewPlanChange(userId, newPlan) {
    try {
      const proration = await this.calculateProration(userId, newPlan);
      
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      // Get upcoming invoice preview from Stripe
      let upcomingInvoice = null;
      if (user.stripeCustomerId) {
        try {
          const newPriceId = await this.getPriceIdForPlan(newPlan);
          const subscription = await stripeService.retrieveSubscription(user.stripeSubscriptionId);

          upcomingInvoice = await stripeService.retrieveUpcomingInvoice({
            customer: user.stripeCustomerId,
            subscription: user.stripeSubscriptionId,
            subscription_items: [{
              id: subscription.items.data[0].id,
              price: newPriceId,
            }],
            subscription_proration_behavior: 'create_prorations'
          });
        } catch (error) {
          logProrationWarning('previewUpcomingInvoice', error, { userId, newPlan });
        }
      }

      return {
        proration,
        upcomingInvoice: upcomingInvoice ? {
          subtotal: upcomingInvoice.subtotal / 100,
          total: upcomingInvoice.total / 100,
          amountDue: upcomingInvoice.amount_due / 100,
          lines: upcomingInvoice.lines.data.map(line => ({
            description: line.description,
            amount: line.amount / 100,
            period: {
              start: new Date(line.period.start * 1000),
              end: new Date(line.period.end * 1000)
            }
          }))
        } : null,
        recommendations: this.getPlanChangeRecommendations(proration)
      };

    } catch (error) {
      logProrationError('previewPlanChange', error, { userId, newPlan });
      throw error;
    }
  }

  /**
   * Get recommendations for plan changes
   */
  getPlanChangeRecommendations(proration) {
    const recommendations = [];

    if (proration.isUpgrade && proration.remainingDays < 7) {
      recommendations.push({
        type: 'timing',
        message: 'Consider waiting for your next billing cycle to minimize prorated charges.',
        action: 'schedule_next_cycle'
      });
    }

    if (proration.isDowngrade && proration.remainingDays > 20) {
      recommendations.push({
        type: 'timing', 
        message: 'You can downgrade now and receive a credit for unused time.',
        action: 'change_immediately'
      });
    }

    if (Math.abs(proration.netAmount) < 1.00) {
      recommendations.push({
        type: 'cost',
        message: 'The prorated amount is minimal, you can change anytime.',
        action: 'change_immediately'
      });
    }

    return recommendations;
  }

  /**
   * Cancel scheduled plan change
   */
  async cancelScheduledPlanChange(userId) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user || !user.stripeSubscriptionId) {
        throw new Error('User has no active subscription');
      }

      // Get current subscription
      const subscription = await stripeService.retrieveSubscription(user.stripeSubscriptionId);
      
      // Check if there are any scheduled changes
      const pendingUpdates = subscription.pending_update;
      
      if (!pendingUpdates) {
        throw new Error('No scheduled plan changes found');
      }

      // Cancel the pending update (this removes the scheduled change)
      await stripeService.updateSubscription(
        user.stripeSubscriptionId,
        { pending_update: null },
        'cancelScheduledPlanChange'
      );

      // Record the cancellation
      await prisma.subscriptionEvent.create({
        data: {
          userId,
          eventType: 'plan_change_cancelled',
          eventData: {
            cancelledUpdate: pendingUpdates
          }
        }
      });

      return {
        success: true,
        message: 'Scheduled plan change has been cancelled'
      };

    } catch (error) {
      logProrationError('cancelScheduledPlanChange', error, { userId });
      throw error;
    }
  }
}

module.exports = new ProrationService();
