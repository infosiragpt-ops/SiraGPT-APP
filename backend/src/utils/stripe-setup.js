const stripeService = require('../services/stripe');
const prisma = require('../config/database');

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
    console.error('❌ Error initializing Stripe products:', error);
    throw error;
  }
}

// Helper function to get price ID for a plan
async function getPriceIdForPlan(plan) {
  const setting = await prisma.systemSettings.findUnique({
    where: { key: `STRIPE_PRICE_${plan}` }
  });
  
  if (!setting) {
    // For development/demo mode, return a dummy price ID
    const dummyPriceIds = {
      PRO: 'price_demo_pro',
      PRO_MAX: 'price_demo_pro_max', 
      ENTERPRISE: 'price_demo_enterprise'
    };
    
    console.warn(`⚠️  No Stripe price ID found for ${plan}. Using dummy ID for development.`);
    return dummyPriceIds[plan] || 'price_demo_fallback';
  }
  
  return setting.value;
}

module.exports = {
  initializeStripeProducts,
  getPriceIdForPlan
};