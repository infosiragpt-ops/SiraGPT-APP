#!/usr/bin/env node

require('dotenv').config();
const { initializeStripeProducts } = require('../src/utils/stripe-setup');

async function main() {
  try {
    console.log('🚀 Starting Stripe products initialization...');
    
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is required');
      process.exit(1);
    }

    await initializeStripeProducts();
    
    console.log('✅ Stripe initialization completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error during Stripe initialization:', error);
    process.exit(1);
  }
}

main();