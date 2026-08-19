#!/usr/bin/env node

// Script to update existing users from old plans to new plans
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function updateExistingUsers() {
  try {
    console.log('🔄 Starting user plan migration...');

    // Get all users with old plans
    const usersToUpdate = await prisma.user.findMany({
      where: {
        plan: {
          in: ['BASIC', 'STANDARD']
        }
      }
    });

    console.log(`📊 Found ${usersToUpdate.length} users to update`);

    let updatedCount = 0;

    for (const user of usersToUpdate) {
      let newPlan;
      let newMonthlyLimit = user.monthlyLimit;

      // Map old plans to new plans
      if (user.plan === 'BASIC') {
        newPlan = 'PRO';
        // Update monthly limit if it's still the old default
        if (Number(user.monthlyLimit) <= 10000) {
          newMonthlyLimit = 500000; // 500k tokens for Pro
        }
      } else if (user.plan === 'STANDARD') {
        newPlan = 'PRO_MAX';
        // Update monthly limit if it's still the old default
        if (Number(user.monthlyLimit) <= 30000) {
          newMonthlyLimit = 1000000; // 1M tokens for Pro Max
        }
      }

      if (newPlan) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            plan: newPlan,
            monthlyLimit: BigInt(newMonthlyLimit)
          }
        });

        console.log(`✅ Updated user ${user.email}: ${user.plan} → ${newPlan} (${newMonthlyLimit} tokens)`);
        updatedCount++;
      }
    }

    console.log(`🎉 Successfully updated ${updatedCount} users!`);

    // Also update any payments table if it exists
    try {
      const paymentsUpdated = await prisma.payment.updateMany({
        where: { plan: 'BASIC' },
        data: { plan: 'PRO' }
      });
      
      const paymentsUpdated2 = await prisma.payment.updateMany({
        where: { plan: 'STANDARD' },
        data: { plan: 'PRO_MAX' }
      });

      console.log(`💳 Updated ${paymentsUpdated.count + paymentsUpdated2.count} payment records`);
    } catch (paymentError) {
      console.log('ℹ️  No payment records to update or payments table doesn\'t exist');
    }

    // Summary report
    const finalCounts = await prisma.user.groupBy({
      by: ['plan'],
      _count: {
        plan: true
      }
    });

    console.log('\n📈 Final user plan distribution:');
    finalCounts.forEach(({ plan, _count }) => {
      console.log(`  ${plan}: ${_count.plan} users`);
    });

  } catch (error) {
    console.error('❌ Error updating users:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  updateExistingUsers()
    .then(() => {
      console.log('\n✅ User migration completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ User migration failed:', error);
      process.exit(1);
    });
}

module.exports = { updateExistingUsers };