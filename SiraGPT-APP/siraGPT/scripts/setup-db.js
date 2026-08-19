const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
  console.log('Setting up database...')

  // Create admin user
  const hashedPassword = await bcrypt.hash('password', 12)
  
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      name: 'Admin User',
      password: hashedPassword,
      plan: 'ENTERPRISE',
      isAdmin: true,
      apiUsage: 15420,
      monthlyLimit: 100000,
    },
  })

  console.log('Admin user created:', adminUser.email)

  // Create some demo users
  for (let i = 1; i <= 10; i++) {
    await prisma.user.upsert({
      where: { email: `user${i}@example.com` },
      update: {},
      create: {
        email: `user${i}@example.com`,
        name: `User ${i}`,
        password: hashedPassword,
        plan: i % 3 === 0 ? 'ENTERPRISE' : i % 2 === 0 ? 'PRO' : 'FREE',
        isAdmin: false,
        apiUsage: Math.floor(Math.random() * 10000),
        monthlyLimit: i % 3 === 0 ? 100000 : i % 2 === 0 ? 50000 : 10000,
      },
    })
  }

  console.log('Demo users created')

  // Create some demo payments
  const users = await prisma.user.findMany()
  
  for (let i = 0; i < 20; i++) {
    const user = users[Math.floor(Math.random() * users.length)]
    const plans = ['PRO', 'ENTERPRISE']
    const plan = plans[Math.floor(Math.random() * plans.length)]
    
    await prisma.payment.create({
      data: {
        userId: user.id,
        amount: plan === 'PRO' ? 29 : 99,
        plan,
        provider: Math.random() > 0.5 ? 'STRIPE' : 'PAYPAL',
        status: Math.random() > 0.1 ? 'COMPLETED' : 'PENDING',
      },
    })
  }

  console.log('Demo payments created')

  // Create some demo API usage
  for (let i = 0; i < 100; i++) {
    const user = users[Math.floor(Math.random() * users.length)]
    const models = ['ChatGPT', 'Claude', 'Grok', 'DeepSeek', 'Gemini']
    const model = models[Math.floor(Math.random() * models.length)]
    
    await prisma.apiUsage.create({
      data: {
        userId: user.id,
        model,
        tokens: Math.floor(Math.random() * 1000) + 100,
        cost: Math.random() * 0.1,
      },
    })
  }

  console.log('Demo API usage created')
  console.log('Database setup complete!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })