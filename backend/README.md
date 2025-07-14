# OpenWebUI Backend

Complete backend API for the OpenWebUI platform with full functionality including authentication, chat management, file processing, payments, and admin features.

## 🚀 Features

### Authentication & User Management
- JWT-based authentication with secure sessions
- User registration and login
- Password hashing with bcrypt
- Role-based access control (Admin/User)
- Profile management and settings

### Chat System
- Real-time chat management
- Message history and persistence
- Multiple AI model support
- Token usage tracking
- File attachments in messages

### File Processing
- Multi-format file upload support
- Document processing (PDF, Word, Excel, PowerPoint)
- Image OCR with Tesseract.js
- Text extraction and indexing
- Thumbnail generation for images
- File management and storage

### Payment Integration
- Stripe payment processing
- PayPal integration
- MercadoPago support (Latin America)
- Subscription management
- Payment history and tracking

### Admin Panel
- User management and analytics
- Payment monitoring
- System statistics
- File management
- API usage tracking

### AI Integration
- Multiple AI model support
- Token usage tracking and limits
- Cost calculation
- File context in AI conversations

## 🛠️ Setup Instructions

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Environment Configuration
```bash
cp .env.example .env
# Edit .env with your configuration
```

### 3. Database Setup
```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# Seed with demo data
npm run db:setup
```

### 4. Start Development Server
```bash
npm run dev
```

The backend will be available at `http://localhost:5000`

## 📁 Project Structure

```
backend/
├── src/
│   ├── config/
│   │   └── database.js          # Database configuration
│   ├── middleware/
│   │   ├── auth.js              # Authentication middleware
│   │   └── upload.js            # File upload middleware
│   ├── routes/
│   │   ├── auth.js              # Authentication routes
│   │   ├── chats.js             # Chat management
│   │   ├── files.js             # File operations
│   │   ├── ai.js                # AI generation
│   │   ├── payments.js          # Payment processing
│   │   ├── admin.js             # Admin operations
│   │   └── users.js             # User management
│   ├── services/
│   │   └── fileProcessor.js     # File processing service
│   └── server.js                # Main server file
├── prisma/
│   └── schema.prisma            # Database schema
├── scripts/
│   └── setup-db.js              # Database seeding
└── uploads/                     # File storage directory
```

## 🔌 API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout
- `POST /api/auth/refresh` - Refresh token

### Chats
- `GET /api/chats` - Get user's chats
- `POST /api/chats` - Create new chat
- `GET /api/chats/:id` - Get specific chat
- `PUT /api/chats/:id` - Update chat
- `DELETE /api/chats/:id` - Delete chat
- `POST /api/chats/:id/messages` - Add message
- `DELETE /api/chats/:id/messages` - Clear chat

### Files
- `POST /api/files/upload` - Upload files
- `GET /api/files` - Get user's files
- `GET /api/files/:id` - Get file details
- `DELETE /api/files/:id` - Delete file

### AI
- `POST /api/ai/generate` - Generate AI response
- `GET /api/ai/models` - Get available models

### Payments
- `POST /api/payments/stripe` - Create Stripe payment
- `POST /api/payments/paypal` - Create PayPal payment
- `POST /api/payments/mercadopago` - Create MercadoPago payment
- `GET /api/payments` - Get user payments

### Users
- `GET /api/users/profile` - Get user profile
- `PUT /api/users/profile` - Update profile
- `PUT /api/users/password` - Change password
- `GET /api/users/usage` - Get usage statistics
- `DELETE /api/users/account` - Delete account

### Admin (Requires admin role)
- `GET /api/admin/users` - Get all users
- `PUT /api/admin/users/:id` - Update user
- `DELETE /api/admin/users/:id` - Delete user
- `GET /api/admin/analytics` - Get analytics
- `GET /api/admin/payments` - Get all payments
- `GET /api/admin/stats` - Get system stats

## 🔒 Security Features

- JWT token authentication
- Password hashing with bcrypt
- Rate limiting
- CORS protection
- Helmet security headers
- Input validation with express-validator
- File type validation
- SQL injection prevention with Prisma

## 📊 File Processing

Supports processing of:
- **Documents**: PDF, Word (.doc, .docx), Excel (.xls, .xlsx), PowerPoint (.ppt, .pptx)
- **Images**: JPEG, PNG, GIF, WebP (with OCR)
- **Text**: Plain text, CSV
- **Audio**: MP3, WAV, OGG
- **Video**: MP4, MPEG, QuickTime

## 💳 Payment Providers

### Stripe
- Credit card processing
- Subscription management
- Webhook handling

### PayPal
- PayPal account payments
- Express checkout
- Subscription billing

### MercadoPago
- Latin America payment processing
- Local payment methods
- Installment payments

## 🔧 Configuration

### Environment Variables
```env
# Server
PORT=5000
NODE_ENV=development

# Database
DATABASE_URL="postgresql://..."

# JWT
JWT_SECRET="your-secret-key"

# File Upload
MAX_FILE_SIZE=10485760
UPLOAD_DIR="uploads"

# Payment Providers
STRIPE_SECRET_KEY="sk_test_..."
PAYPAL_CLIENT_ID="..."
MERCADOPAGO_ACCESS_TOKEN="..."

# AI APIs (Optional)
OPENAI_API_KEY="sk-..."
ANTHROPIC_API_KEY="sk-ant-..."
```

## 🚀 Production Deployment

1. Set up PostgreSQL database
2. Configure environment variables
3. Run database migrations
4. Set up file storage (AWS S3, etc.)
5. Configure payment webhooks
6. Deploy to your preferred platform

## 📝 Demo Credentials

After running `npm run db:setup`:

**Admin Account:**
- Email: admin@example.com
- Password: password

**Demo Users:**
- Email: user1@example.com to user20@example.com
- Password: password

## 🐛 Troubleshooting

### Database Issues
```bash
# Reset database
npm run db:push -- --force-reset

# Regenerate client
npm run db:generate
```

### File Upload Issues
- Check upload directory permissions
- Verify file size limits
- Check available disk space

### Payment Issues
- Verify API keys are correct
- Check webhook endpoints
- Monitor payment provider logs

## 📞 Support

For issues and questions:
- Check the logs for error details
- Verify environment configuration
- Test API endpoints with Postman
- Check database connectivity