const stripeService = require('../services/stripe');
const prisma = require('../config/database');
const { redactErrorMessage } = require('./secret-redactor');

async function initializeStripeProducts() {
  try {
    console.log('🚀 Initializing Stripe products and prices...');
    
    // Create or update products and prices
    const results = await stripeService.createOrUpdateProducts();
    
    console.log('✅ Stripe products and prices created/updated:');
    
    Object.entries(results).forEach(([planKey, data]) => {
      console.log(`📦 ${planKey}:`);
      console.log(`   Product ID: ${data.product.id}`);
      console.log(`   Price ID: ${data.price.id}`);
      console.log(`   Amount: $${data.price.unit_amount / 100}`);
      console.log(`   Credits: ${data.planData.credits.toLocaleString()}`);
      console.log('');
    });
    
    // Store price IDs in environment or system settings for easy access
    for (const [planKey, data] of Object.entries(results)) {
      const settingKey = `STRIPE_PRICE_${planKey}`;
      
      await prisma.systemSettings.upsert({
        where: { key: settingKey },
        update: { value: data.price.id },
        create: {
          key: settingKey,
          value: data.price.id
        }
      });
      
      console.log(`💾 Saved ${settingKey} = ${data.price.id}`);
    }
    
    console.log('\n🎉 Stripe initialization completed successfully!');
    return results;
    
  } catch (error) {
    console.error(`[stripe-setup] Error initializing Stripe products: ${redactErrorMessage(error)}`);
    throw error;
  }
}

// Helper function to get price ID for a plan.
//
// Resolution order:
//   1. systemSettings.STRIPE_PRICE_<plan>  (persisted by a previous provision)
//   2. process.env.STRIPE_PRICE_<plan>     (operator override)
//   3. demo id when Stripe is NOT configured (local dev without keys)
//   4. auto-provision in Stripe when the key IS configured but nobody ran
//      `scripts/init-stripe.js`: the product/price is created once
//      (idempotent, matched by metadata) and cached in systemSettings so a
//      fresh deployment can sell the plan with only STRIPE_SECRET_KEY.
async function getPriceIdForPlan(plan) {
  const settingKey = `STRIPE_PRICE_${plan}`;
  const setting = await prisma.systemSettings.findUnique({
    where: { key: settingKey }
  });
  
  if (setting?.value) {
    return setting.value;
  }

  if (process.env[settingKey]) {
    return process.env[settingKey];
  }

  if (!stripeService.isConfigured) {
    // For development/demo mode, return a dummy price ID
    const dummyPriceIds = {
      PRO: 'price_demo_pro',
      PRO_MAX: 'price_demo_pro_max', 
      ENTERPRISE: 'price_demo_enterprise'
    };
    
    console.warn(`⚠️  No Stripe price ID found for ${plan}. Using dummy ID for development.`);
    return dummyPriceIds[plan] || 'price_demo_fallback';
  }

  const knownPlan = Boolean(stripeService.plans && stripeService.plans[plan]);
  if (knownPlan && typeof stripeService.ensurePriceForPlan === 'function') {
    const provisioned = await stripeService.ensurePriceForPlan(plan);
    const priceId = provisioned?.price?.id;
    if (priceId) {
      try {
        await prisma.systemSettings.upsert({
          where: { key: settingKey },
          update: { value: priceId },
          create: { key: settingKey, value: priceId }
        });
      } catch (error) {
        // Caching is best-effort: the checkout can proceed with the id we
        // just got; the next call simply re-resolves it from Stripe.
        console.warn(`[stripe-setup] could not persist ${settingKey}: ${redactErrorMessage(error)}`);
      }
      console.log(`[stripe-setup] auto-provisioned ${settingKey} in Stripe`);
      return priceId;
    }
  }

  throw new Error(`Stripe price ID is not configured for plan: ${plan}`);
}

module.exports = {
  initializeStripeProducts,
  getPriceIdForPlan
};
