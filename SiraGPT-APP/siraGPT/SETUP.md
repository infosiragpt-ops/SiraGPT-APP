# Setup Instructions

## Prerequisites

Make sure you have the following installed:
- Node.js 18+ 
- npm or yarn
- Git

## Installation Steps

1. **Download/Clone the project**
   \`\`\`bash
   # If you downloaded the zip, extract it
   # If cloning from git:
   git clone <your-repo-url>
   cd openwebui-platform
   \`\`\`

2. **Install dependencies**
   \`\`\`bash
   npm install
   # or
   yarn install
   \`\`\`

3. **Create environment file**
   \`\`\`bash
   cp .env.local.example .env.local
   \`\`\`

4. **Edit environment variables** (optional for demo)
   \`\`\`bash
   # Open .env.local and add your API keys
   OPENAI_API_KEY=your_key_here
   ANTHROPIC_API_KEY=your_key_here
   # etc...
   \`\`\`

5. **Start development server**
   \`\`\`bash
   npm run dev
   # or
   yarn dev
   \`\`\`

6. **Open in browser**
   Navigate to http://localhost:3000

## Demo Login

- **Admin**: admin@example.com / password
- **User**: Create new account or use any email with "password"

## Common Issues & Solutions

### Issue: "Module not found" errors
**Solution**: Run `npm install` again and make sure all dependencies are installed.

### Issue: "Cannot find module '@/components/ui/...'"
**Solution**: Make sure the `tsconfig.json` file has the correct path mapping.

### Issue: Styling not working
**Solution**: Make sure `tailwind.config.js` and `postcss.config.js` are in the root directory.

### Issue: Build errors
**Solution**: 
\`\`\`bash
# Clear Next.js cache
rm -rf .next
npm run build
\`\`\`

### Issue: Port already in use
**Solution**: 
\`\`\`bash
# Use different port
npm run dev -- -p 3001
\`\`\`

## File Structure Check

Make sure you have these key files:
\`\`\`
├── package.json
├── tailwind.config.js
├── postcss.config.js
├── tsconfig.json
├── next.config.js
├── app/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   └── ui/
├── lib/
│   └── utils.ts
└── hooks/
\`\`\`

## Deployment

### Vercel (Recommended)
1. Push code to GitHub
2. Connect to Vercel
3. Deploy automatically

### Manual Build
\`\`\`bash
npm run build
npm start
\`\`\`

## Need Help?

If you're still getting errors:
1. Delete `node_modules` and `package-lock.json`
2. Run `npm install` again
3. Make sure you're using Node.js 18+
4. Check that all files are in the correct locations
