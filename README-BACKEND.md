# OpenWebUI Backend Setup

This is a complete backend implementation for the OpenWebUI platform with full functionality including authentication, chat management, payments, and admin features.

## Features

### 🔐 Authentication System
- JWT-based authentication
- Session management
- Password hashing with bcrypt
- Protected routes and middleware

### 💬 Chat System
- Real-time chat management
- Message history
- Multiple AI model support
- Token tracking and usage limits

### 💳 Payment Integration
- Stripe integration for subscriptions
- PayPal support
- MercadoPago for Latin America
- Webhook handling for payment events

### 👥 User Management
- User registration and login
- Plan management (Free, Pro, Enterprise)
- API usage tracking
- Monthly limits enforcement

### 🛡️ Admin Panel
- User management
- Payment tracking
- Analytics dashboard
- System monitoring

### 📊 Analytics
- User statistics
- Revenue tracking
- API usage metrics
- Model performance data

## Setup Instructions

### 1. Environment Variables

Copy `.env.local.example` to `.env.local` and fill in your values:

```bash
cp .env.local.example .env.local
```

### 2. Database Setup

Set up a PostgreSQL database and update the `DATABASE_URL` in your `.env.local` file.

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# Seed database with demo data
npm run db:setup
```

### 3. Start Development Server

```bash
npm run dev
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `GET /api/auth/me` - Get current user

### Chats
- `GET /api/chats` - Get user's chats
- `POST /api/chats` - Create new chat
- `GET /api/chats/[id]` - Get specific chat
- `PUT /api/chats/[id]` - Update chat
- `DELETE /api/chats/[id]` - Delete chat
- `POST /api/chats/[id]/messages` - Add message to chat

### AI Generation
- `POST /api/ai/generate` - Generate AI response

### Payments
- `POST /api/payments/stripe` - Create Stripe payment
- `POST /api/payments/stripe/webhook` - Stripe webhook handler

### Admin (Requires admin privileges)
- `GET /api/admin/users` - Get all users
- `GET /api/admin/analytics` - Get analytics data
- `GET /api/admin/payments` - Get all payments

## Database Schema

The application uses Prisma ORM with PostgreSQL. Key models include:

- **User** - User accounts with plans and usage tracking
- **Chat** - Chat conversations
- **Message** - Individual messages in chats
- **Payment** - Payment transactions
- **ApiUsage** - API usage tracking
- **Session** - User sessions

## Payment Integration

### Stripe Setup
1. Create a Stripe account
2. Get your API keys from the Stripe dashboard
3. Set up webhooks for payment events
4. Add keys to `.env.local`

### PayPal Setup
1. Create a PayPal developer account
2. Create an application
3. Get client ID and secret
4. Add to `.env.local`

## Security Features

- Password hashing with bcrypt
- JWT token authentication
- Session management
- Protected API routes
- Admin-only endpoints
- Input validation with Zod
- SQL injection prevention with Prisma

## Monitoring and Analytics

The backend provides comprehensive analytics including:
- User growth and activity
- Revenue tracking
- API usage by model
- Payment status monitoring
- System performance metrics

## Demo Credentials

After running `npm run db:setup`, you can use:
- **Email**: admin@example.com
- **Password**: password

## Production Deployment

1. Set up a production PostgreSQL database
2. Update environment variables for production
3. Set up Stripe webhooks for your production domain
4. Deploy to your preferred platform (Vercel, Railway, etc.)

## Troubleshooting

### Database Issues
```bash
# Reset database
npx prisma db push --force-reset

# Regenerate client
npx prisma generate
```

### Authentication Issues
- Check JWT_SECRET is set
- Verify token expiration
- Check middleware configuration

### Payment Issues
- Verify Stripe webhook endpoints
- Check API keys are correct
- Monitor webhook logs in Stripe dashboard