const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient(
);

async function main() {
  console.log('🚀 Setting up database...');

  try {
    // Create admin user
    const hashedPassword = await bcrypt.hash('password', 12);

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
    });

    console.log('✅ Admin user created:', adminUser.email);

    // Create demo users
    const demoUsers = [];
    for (let i = 1; i <= 20; i++) {
      const user = await prisma.user.upsert({
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
      });
      demoUsers.push(user);
    }

    console.log('✅ Demo users created');

    // Create demo chats and messages
    for (let i = 0; i < 10; i++) {
      const user = demoUsers[Math.floor(Math.random() * demoUsers.length)];
      const models = ['ChatGPT', 'Claude', 'Grok', 'DeepSeek', 'Gemini'];
      const model = models[Math.floor(Math.random() * models.length)];

      const chat = await prisma.chat.create({
        data: {
          userId: user.id,
          title: `Demo Chat ${i + 1}`,
          model,
        },
      });

      // Add some messages to each chat
      for (let j = 0; j < Math.floor(Math.random() * 5) + 2; j++) {
        await prisma.message.create({
          data: {
            chatId: chat.id,
            role: j % 2 === 0 ? 'USER' : 'ASSISTANT',
            content: j % 2 === 0
              ? `This is a demo user message ${j + 1}`
              : `This is a demo AI response ${j + 1} from ${model}`,
            tokens: j % 2 === 1 ? Math.floor(Math.random() * 500) + 100 : null,
          },
        });
      }
    }

    console.log('✅ Demo chats and messages created');

    // Create demo payments
    for (let i = 0; i < 30; i++) {
      const user = demoUsers[Math.floor(Math.random() * demoUsers.length)];
      const plans = ['PRO', 'ENTERPRISE'];
      const plan = plans[Math.floor(Math.random() * plans.length)];
      const providers = ['STRIPE', 'PAYPAL', 'MERCADOPAGO'];
      const provider = providers[Math.floor(Math.random() * providers.length)];

      await prisma.payment.create({
        data: {
          userId: user.id,
          amount: plan === 'PRO' ? 29 : 99,
          plan,
          provider,
          status: Math.random() > 0.1 ? 'COMPLETED' : 'PENDING',
          providerId: `demo_${provider.toLowerCase()}_${Date.now()}_${i}`,
        },
      });
    }

    console.log('✅ Demo payments created');

    // Create demo API usage
    for (let i = 0; i < 100; i++) {
      const user = demoUsers[Math.floor(Math.random() * demoUsers.length)];
      const models = ['ChatGPT', 'Claude', 'Grok', 'DeepSeek', 'Gemini'];
      const model = models[Math.floor(Math.random() * models.length)];

      await prisma.apiUsage.create({
        data: {
          userId: user.id,
          model,
          tokens: Math.floor(Math.random() * 1000) + 100,
          cost: Math.random() * 0.1,
          timestamp: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
        },
      });
    }

    console.log('✅ Demo API usage created');

    // Create some demo files
    for (let i = 0; i < 15; i++) {
      const user = demoUsers[Math.floor(Math.random() * demoUsers.length)];
      const fileTypes = [
        { mime: 'application/pdf', ext: 'pdf' },
        { mime: 'image/jpeg', ext: 'jpg' },
        { mime: 'text/plain', ext: 'txt' },
        { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' }
      ];
      const fileType = fileTypes[Math.floor(Math.random() * fileTypes.length)];

      await prisma.file.create({
        data: {
          userId: user.id,
          filename: `demo-file-${i + 1}.${fileType.ext}`,
          originalName: `Demo File ${i + 1}.${fileType.ext}`,
          mimeType: fileType.mime,
          size: Math.floor(Math.random() * 1000000) + 10000,
          path: `/uploads/${user.id}/demo-file-${i + 1}.${fileType.ext}`,
          extractedText: `This is demo extracted text from file ${i + 1}`,
        },
      });
    }

    console.log('✅ Demo files created');

    // Create default AI models
    const defaultModels = [
      {
        name: 'chatgpt',
        displayName: 'ChatGPT',
        provider: 'OpenAI',
        description: 'GPT-4 and GPT-3.5 Turbo models'
      },
      {
        name: 'claude',
        displayName: 'Claude',
        provider: 'Anthropic',
        description: 'Claude 3 Opus and Sonnet models'
      },
      {
        name: 'grok',
        displayName: 'Grok',
        provider: 'xAI',
        description: 'Grok-2 model by xAI'
      },
      {
        name: 'gemini',
        displayName: 'Gemini',
        provider: 'Google',
        description: 'Gemini Pro model'
      }
    ];

    for (const model of defaultModels) {
      await prisma.aiModel.upsert({
        where: { name: model.name },
        update: {},
        create: model
      });
    }

    console.log('✅ Default AI models created');

    console.log('🎉 Database setup complete!');
    console.log('');
    console.log('Demo credentials:');
    console.log('📧 Email: admin@example.com');
    console.log('🔑 Password: password');
    console.log('');
    console.log('You can also use any of the demo users:');
    console.log('📧 Email: user1@example.com to user20@example.com');
    console.log('🔑 Password: password');

  } catch (error) {
    console.error('❌ Database setup failed:', error);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });