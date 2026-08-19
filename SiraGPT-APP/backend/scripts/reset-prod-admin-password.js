#!/usr/bin/env node
'use strict';

/**
 * Rotate an existing production admin credential.
 * Run on the VPS where DATABASE_URL is configured:
 *
 *   cd /opt/siragpt/backend
 *   RESET_ADMIN_EMAIL='admin@example.com' \
 *     RESET_ADMIN_PASSWORD='<strong-random-secret>' \
 *     node scripts/reset-prod-admin-password.js
 *
 * Or inside the backend container:
 *
 *   docker compose -f docker-compose.prod.yml exec backend \
 *     node scripts/reset-prod-admin-password.js
 */

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const MIN_ADMIN_PASSWORD_LENGTH = 24;

function readResetConfig(env = process.env) {
  return {
    email: String(env.RESET_ADMIN_EMAIL || '').trim().toLowerCase(),
    password: String(env.RESET_ADMIN_PASSWORD || ''),
  };
}

function validateResetConfig({ email, password }) {
  if (!email || !email.includes('@')) {
    throw new Error('RESET_ADMIN_EMAIL is required');
  }
  if (!password || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(
      `RESET_ADMIN_PASSWORD is required and must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`,
    );
  }
}

async function rotateAdminCredential({ prisma, config, hashPassword = bcrypt.hash }) {
  validateResetConfig(config);
  const hash = await hashPassword(config.password, 12);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { email: config.email },
      data: {
        password: hash,
        updatedAt: new Date(),
      },
      select: { id: true },
    });
    const revoked = await tx.session.deleteMany({
      where: { userId: user.id },
    });
    return {
      rotated: 1,
      sessionsRevoked: revoked.count,
    };
  });
}

async function main() {
  const config = readResetConfig();
  validateResetConfig(config);
  const prisma = new PrismaClient();
  try {
    const result = await rotateAdminCredential({ prisma, config });
    console.log(JSON.stringify({ ok: true, ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : 'RESET_FAILED';
    console.error(`[reset-prod-admin] FAILED (${code})`);
    process.exit(1);
  });
}

module.exports = {
  MIN_ADMIN_PASSWORD_LENGTH,
  readResetConfig,
  validateResetConfig,
  rotateAdminCredential,
};
