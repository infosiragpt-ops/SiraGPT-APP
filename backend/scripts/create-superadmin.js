const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function createSuperAdmin() {
  try {
    // Check if super admin already exists
    const existingSuperAdmin = await prisma.user.findFirst({
      where: { isSuperAdmin: true }
    });

    if (existingSuperAdmin) {
      console.log('Super admin already exists:', existingSuperAdmin.email);
      return;
    }

    // Create super admin user
    const hashedPassword = await bcrypt.hash('superadmin123', 12);
    
    const superAdmin = await prisma.user.create({
      data: {
        name: 'Super Administrator',
        email: 'superadmin@example.com',
        password: hashedPassword,
        plan: 'ENTERPRISE',
        isAdmin: true,
        isSuperAdmin: true,
        apiUsage: BigInt(0),
        monthlyCallLimit: BigInt(999999),
        monthlyLimit: BigInt(999999)
      }
    });

    console.log('✅ Super admin created successfully!');
    console.log('Email:', superAdmin.email);
    console.log('Password: superadmin123');
    console.log('Please change this password after first login.');

  } catch (error) {
    console.error('❌ Error creating super admin:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createSuperAdmin();