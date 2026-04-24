const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? [//'query', 'info',
    'warn', 'error'] : ['error'],
});

// Test database connection
async function connectDatabase({ exitOnFailure = true } = {}) {
  try {
    await prisma.$connect();
    console.log('✅ Database connected successfully');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    if (exitOnFailure) process.exit(1);
    return false;
  }
}

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = prisma;
module.exports.connectDatabase = connectDatabase;
