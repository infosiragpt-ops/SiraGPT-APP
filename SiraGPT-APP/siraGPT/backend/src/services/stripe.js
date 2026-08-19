const Stripe = require('stripe');

class StripeService {
  constructor() {
    this.isConfigured = !!process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_...';
    this.demoAllowed = process.env.NODE_ENV !== 'production'
      && process.env.ALLOW_STRIPE_DEMO === 'true';

    if (!this.isConfigured) {
      if (process.env.NODE_ENV === 'production') {
        // Loud, single boot warning. Operators need to see this in
        // PM2 logs immediately — running prod without Stripe means
        // every checkout attempt will 503 below.
        console.error(
          '🚨 [stripe] STRIPE_SECRET_KEY is NOT set in production. '
          + 'All payment endpoints will return 503. Set STRIPE_SECRET_KEY now.'
        );
      } else if (this.demoAllowed) {
        console.warn('⚠️  Stripe not configured — DEMO mode enabled (ALLOW_STRIPE_DEMO=true). Do NOT use in production.');
      } else {
        console.warn('⚠️  Stripe not configured. Set STRIPE_SECRET_KEY in .env for real payments, or ALLOW_STRIPE_DEMO=true for local demo simulation.');
      }
      this.stripe = null;
    } else {
      this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: '2023-10-16',
      });
    }
    
    // Define subscription plans
    this.plans = {
      PRO: {
        name: 'Go Plan',
        price: 500, // $5.00 in cents
        credits: 500000,
        features: ['500,000 tokens per month', 'All AI models', 'Priority support', 'Advanced features']
      },
      PRO_MAX: {
        name: 'Plus Plan',
        price: 2000, // $20.00 in cents
        credits: 1000000,
        features: ['1,000,000 tokens per month', 'All AI models', 'Priority support', 'Advanced features', 'Enhanced rate limits']
      },
      ENTERPRISE: {
        name: 'Pro Plan',
        price: 20000, // $200.00 in cents
        credits: 10000000,
        features: ['10,000,000 tokens per month', 'All features', 'Dedicated support', 'Custom integrations', 'SLA guaranteed']
      }
    };
  }

  async createOrUpdateProducts() {
    if (!this.isConfigured) {
      throw new Error('Stripe is not configured. Please set STRIPE_SECRET_KEY in your environment variables.');
    }
    
    const results = {};
    
    for (const [planKey, planData] of Object.entries(this.plans)) {
      try {
        // Create or update product
        const products = await this.stripe.products.list({
          active: true,
          limit: 100
        });
        
        let product = products.data.find(p => p.metadata.plan === planKey);
        
        if (!product) {
          product = await this.stripe.products.create({
            name: planData.name,
            description: `${planData.name} subscription with ${planData.credits.toLocaleString()} monthly API calls`,
            metadata: {
              plan: planKey,
              credits: planData.credits.toString()
            }
          });
        }

        // Create or update price
        const prices = await this.stripe.prices.list({
          product: product.id,
          active: true
        });
        
        let price = prices.data.find(p => 
          p.unit_amount === planData.price && 
          p.recurring?.interval === 'month'
        );
        
        if (!price) {
          price = await this.stripe.prices.create({
            product: product.id,
            unit_amount: planData.price,
            currency: 'usd',
            recurring: {
              interval: 'month'
            },
            metadata: {
              plan: planKey
            }
          });
        }

        results[planKey] = {
          product,
          price,
          planData
        };
      } catch (error) {
        console.error(`Error creating product/price for ${planKey}:`, error);
        throw error;
      }
    }
    
    return results;
  }

  async createCustomer(email, name, userId) {
    if (!this.isConfigured) {
      throw new Error('Stripe is not configured. Please set STRIPE_SECRET_KEY in your environment variables.');
    }
    
    try {
      const customer = await this.stripe.customers.create({
        email,
        name,
        metadata: {
          userId
        }
      });
      return customer;
    } catch (error) {
      console.error('Error creating Stripe customer:', error);
      throw error;
    }
  }

  async createCheckoutSession(priceId, customerId, userId, plan, successUrl, cancelUrl) {
    if (!this.isConfigured) {
      throw new Error('Stripe is not configured. Please set STRIPE_SECRET_KEY in your environment variables.');
    }
    
    try {
      const session = await this.stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{
          price: priceId,
          quantity: 1,
        }],
        mode: 'subscription',
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          userId,
          plan
        },
        subscription_data: {
          metadata: {
            userId,
            plan
          }
        }
      });
      
      return session;
    } catch (error) {
      console.error('Error creating checkout session:', error);
      throw error;
    }
  }

  async createPaymentIntent(amount, customerId, userId, plan) {
    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        customer: customerId,
        metadata: {
          userId,
          plan
        },
        automatic_payment_methods: {
          enabled: true,
        },
      });
      
      return paymentIntent;
    } catch (error) {
      console.error('Error creating payment intent:', error);
      throw error;
    }
  }

  async retrieveCustomer(customerId) {
    try {
      return await this.stripe.customers.retrieve(customerId);
    } catch (error) {
      console.error('Error retrieving customer:', error);
      throw error;
    }
  }

  async retrieveSubscription(subscriptionId) {
    try {
      return await this.stripe.subscriptions.retrieve(subscriptionId);
    } catch (error) {
      console.error('Error retrieving subscription:', error);
      throw error;
    }
  }

  async cancelSubscription(subscriptionId) {
    try {
      return await this.stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true
      });
    } catch (error) {
      console.error('Error canceling subscription:', error);
      throw error;
    }
  }

  async reactivateSubscription(subscriptionId) {
    try {
      return await this.stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false
      });
    } catch (error) {
      console.error('Error reactivating subscription:', error);
      throw error;
    }
  }

  async getUpcomingInvoice(customerId) {
    try {
      return await this.stripe.invoices.retrieveUpcoming({
        customer: customerId
      });
    } catch (error) {
      console.error('Error retrieving upcoming invoice:', error);
      throw error;
    }
  }

  async listCustomerSubscriptions(customerId) {
    try {
      return await this.stripe.subscriptions.list({
        customer: customerId,
        status: 'all'
      });
    } catch (error) {
      console.error('Error listing subscriptions:', error);
      throw error;
    }
  }

  constructWebhookEvent(payload, signature) {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
    }
    
    try {
      return this.stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error('Error constructing webhook event:', error);
      throw error;
    }
  }
}

module.exports = new StripeService();
