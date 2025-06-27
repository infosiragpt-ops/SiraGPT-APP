# OpenWebUI Platform

A comprehensive AI platform supporting multiple LLM APIs with text, image, audio & video generation capabilities.

## Features

- 🤖 **Multi-LLM Support**: ChatGPT, Claude, Grok, DeepSeek, Gemini
- 💬 **Real-time Chat**: Interactive chat interface with AI responses
- 👥 **User Management**: Complete authentication and user profiles
- 🔧 **Admin Panel**: Comprehensive admin dashboard with analytics
- 💳 **Payment Integration**: PayPal and MercadoPago support
- 📊 **Analytics**: Detailed usage statistics and reporting
- 🎨 **Modern UI**: Beautiful, responsive design with dark/light themes
- 🔒 **Secure**: Role-based access control and data protection

## Quick Start

1. **Clone the repository**
   \`\`\`bash
   git clone <repository-url>
   cd openwebui-platform
   \`\`\`

2. **Install dependencies**
   \`\`\`bash
   npm install
   \`\`\`

3. **Set up environment variables**
   \`\`\`bash
   cp .env.local.example .env.local
   # Edit .env.local with your API keys
   \`\`\`

4. **Run the development server**
   \`\`\`bash
   npm run dev
   \`\`\`

5. **Open your browser**
   Navigate to [http://localhost:3000](http://localhost:3000)

## Demo Credentials

- **Admin User**: admin@example.com / password
- **Regular User**: Create a new account or use any email with "password"

## Environment Variables

Create a `.env.local` file with the following variables:

\`\`\`env
# AI APIs
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
GROQ_API_KEY=your_groq_api_key

# Database (optional - uses mock data by default)
DATABASE_URL=your_database_url

# Payment Providers (optional)
PAYPAL_CLIENT_ID=your_paypal_client_id
MERCADOPAGO_ACCESS_TOKEN=your_mercadopago_token
\`\`\`

## Project Structure

\`\`\`
├── app/                    # Next.js app directory
│   ├── admin/             # Admin panel pages
│   ├── auth/              # Authentication pages
│   ├── chat/              # Chat interface
│   └── globals.css        # Global styles
├── components/            # React components
│   ├── ui/               # UI components
│   └── ...               # Feature components
├── lib/                  # Utility libraries
│   ├── auth-context.tsx  # Authentication context
│   ├── chat-context.tsx  # Chat management
│   ├── database.ts       # Database operations
│   └── ai-service.ts     # AI service integration
└── public/               # Static assets
\`\`\`

## Key Components

### Authentication System
- Complete login/register flow
- Role-based access control
- Persistent sessions
- User profile management

### Chat Interface
- Multi-LLM support
- Real-time messaging
- Chat history
- Model switching

### Admin Panel
- User management
- Payment tracking
- Analytics dashboard
- System monitoring

### AI Integration
- OpenAI GPT models
- Anthropic Claude
- xAI Grok
- DeepSeek AI
- Google Gemini

## Deployment

### Vercel (Recommended)

1. **Connect your repository to Vercel**
2. **Set environment variables in Vercel dashboard**
3. **Deploy automatically on push**

### Manual Deployment

1. **Build the project**
   \`\`\`bash
   npm run build
   \`\`\`

2. **Start the production server**
   \`\`\`bash
   npm start
   \`\`\`

## Database Integration

The platform currently uses a mock database for demonstration. To integrate with a real database:

1. **Choose your database** (Supabase, Neon, PostgreSQL, etc.)
2. **Update the database connection** in `lib/database.ts`
3. **Run migrations** to create the required tables
4. **Update environment variables**

## Payment Integration

To enable real payments:

1. **Set up PayPal Developer Account**
2. **Configure MercadoPago (for Latin America)**
3. **Add API keys to environment variables**
4. **Test in sandbox mode first**

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support and questions:
- Create an issue on GitHub
- Check the documentation
- Join our community discussions

## Roadmap

- [ ] Real-time collaboration
- [ ] File upload and processing
- [ ] Voice chat integration
- [ ] Mobile app
- [ ] API marketplace
- [ ] Custom model training
- [ ] Enterprise SSO
- [ ] Advanced analytics

---

Built with ❤️ using Next.js, React, and Tailwind CSS
