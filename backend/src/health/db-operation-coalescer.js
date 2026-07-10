'use strict';

const DATABASE_OPERATION = 'database';
const MIGRATIONS_OPERATION = 'migrations';

// A Prisma client owns its connection pool, so it is also the correct lifetime
// boundary for coalescing health queries. Weak keys avoid retaining clients
// after tests, hot reloads, or shutdown.
const inflightByPrisma = new WeakMap();

function isWeakMapKey(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function coalescePrismaHealthOperation(prisma, operationName, operation) {
  if (!isWeakMapKey(prisma)) {
    throw new TypeError('coalescePrismaHealthOperation: Prisma client object required');
  }
  if (typeof operationName !== 'string' || !operationName) {
    throw new TypeError('coalescePrismaHealthOperation: operationName required');
  }
  if (typeof operation !== 'function') {
    throw new TypeError('coalescePrismaHealthOperation: operation function required');
  }

  let operations = inflightByPrisma.get(prisma);
  if (!operations) {
    operations = new Map();
    inflightByPrisma.set(prisma, operations);
  }
  const existing = operations.get(operationName);
  if (existing) return existing;

  const pending = Promise.resolve().then(operation);
  operations.set(operationName, pending);

  const cleanup = () => {
    if (operations.get(operationName) !== pending) return;
    operations.delete(operationName);
    if (operations.size === 0) inflightByPrisma.delete(prisma);
  };
  // Attach both handlers immediately. Callers may time out before Prisma does;
  // a later rejection is still observed and releases the coalescer entry.
  pending.then(cleanup, cleanup);
  return pending;
}

function runCoalescedDatabasePing(prisma) {
  return coalescePrismaHealthOperation(prisma, DATABASE_OPERATION, () => {
    if (typeof prisma.$queryRawUnsafe === 'function') {
      return prisma.$queryRawUnsafe('SELECT 1 as ok');
    }
    if (typeof prisma.$queryRaw === 'function') {
      return prisma.$queryRaw`SELECT 1 as ok`;
    }
    throw new TypeError('database health probe requires Prisma $queryRawUnsafe or $queryRaw');
  });
}

module.exports = {
  DATABASE_OPERATION,
  MIGRATIONS_OPERATION,
  coalescePrismaHealthOperation,
  runCoalescedDatabasePing,
};
