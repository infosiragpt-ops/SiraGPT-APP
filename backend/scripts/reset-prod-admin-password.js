#!/usr/bin/env node
'use strict';

/**
 * Reset / create the production admin account (admin@gmail.com).
 * Run on the VPS where DATABASE_URL is configured:
 *
 *   cd /opt/siragpt/backend
 *   RESET_ADMIN_PASSWORD='YourNewPassword' node scripts/reset-prod-admin-password.js
 *
 * Or inside the backend container:
 *
 *   docker compose -f docker-compose.prod.yml exec backend \
 *     node scripts/reset-prod-admin-password.js
 */

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const ADMIN_EMAIL = (process.env.RESET_ADMIN_EMAIL || 'admin@gmail.com').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.RESET_ADMIN_PASSWORD || 'Admin@SiraGPT2024';
const ADMIN_ID = 'prod_admin_admin_gmail_com';

async function main() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    console.error('[reset-prod-admin] RESET_ADMIN_PASSWORD must be at least 8 characters');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const user = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      name: 'Administrador',
      password: hash,
      plan: 'ENTERPRISE',
      isAdmin: true,
      isSuperAdmin: true,
      apiUsage: 0,
      monthlyCallLimit: 999999,
      monthlyLimit: 999999,
      emailVerifiedAt: new Date(),
      twoFactorEnabled: false,
      totpEnabled: false,
    },
    update: {
      password: hash,
      plan: 'ENTERPRISE',
      isAdmin: true,
      isSuperAdmin: true,
      deletedAt: null,
      emailVerifiedAt: new Date(),
      twoFactorEnabled: false,
      totpEnabled: false,
      updatedAt: new Date(),
    },
  });

  console.log(`[reset-prod-admin] OK — ${user.email} (id=${user.id})`);
  console.log('[reset-prod-admin] Use the password from RESET_ADMIN_PASSWORD (default: Admin@SiraGPT2024)');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[reset-prod-admin] FAILED:', err?.message || err);
  process.exit(1);
});
