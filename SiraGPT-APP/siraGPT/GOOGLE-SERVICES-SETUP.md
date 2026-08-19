# Google Calendar & Drive Integration Setup Guide

This guide will help you set up Google Calendar and Google Drive integration using OpenAI's MCP (Model Context Protocol) connectors.

## 📋 Prerequisites

- OpenAI API Key with access to GPT-4o or later models
- Google Cloud Console account
- PostgreSQL database

## 🔧 Step 1: Google Cloud Console Setup

### 1.1 Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Note your Project ID

### 1.2 Enable Required APIs

Enable the following APIs in your Google Cloud project:

1. **Google Calendar API**
   - Go to [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - Click "Enable"

2. **Google Drive API**
   - Go to [Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - Click "Enable"

### 1.3 Configure OAuth Consent Screen

1. Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
2. Select "External" user type (or "Internal" if using Google Workspace)
3. Fill in required information:
   - App name: Your App Name
   - User support email: Your email
   - Developer contact: Your email
4. Click "Save and Continue"
5. Add the following scopes:
   ```
   https://www.googleapis.com/auth/calendar
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/drive
   https://www.googleapis.com/auth/drive.file
   https://www.googleapis.com/auth/drive.readonly
   https://www.googleapis.com/auth/drive.metadata.readonly
   ```
6. Add test users (your email addresses) if in testing mode
7. Click "Save and Continue"

### 1.4 Create OAuth 2.0 Credentials

1. Go to [Credentials](https://console.cloud.google.com/apis/credentials)
2. Click "Create Credentials" → "OAuth client ID"
3. Select "Web application"
4. Configure:
   - **Name**: Your App OAuth Client
   - **Authorized JavaScript origins**:
     ```
     http://localhost:3000
     http://localhost:5000
     https://yourdomain.com (for production)
     ```
   - **Authorized redirect URIs**:
     ```
     http://localhost:5000/api/auth/google-services/callback
     https://yourdomain.com/api/auth/google-services/callback (for production)
     ```
5. Click "Create"
6. **Save your Client ID and Client Secret** - you'll need these for environment variables

## 🔐 Step 2: Environment Variables

Add the following to your `backend/.env` file:

```env
# Google OAuth Configuration (Reuse the same credentials for all Google services)
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:5000/api/auth/google-services/callback

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here

# Database
PRISMA_DATABASE_URL=postgresql://user:password@localhost:5432/your_database

# Server Configuration
BASE_URL=http://localhost:5000
FRONTEND_URL=http://localhost:3000
PORT=5000
```

**Important Notes:**
- Use the same `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for Gmail, Calendar, and Drive
- Update URLs for production deployment
- Keep your credentials secure and never commit them to version control

## 📦 Step 3: Install Dependencies

The required dependencies are already included in your project:

```bash
cd backend
npm install
```

Key dependencies:
- `openai` - OpenAI SDK for MCP connectors
- `google-auth-library` - Google OAuth authentication
- `@prisma/client` - Database ORM

## 🗄️ Step 4: Database Migration

The database schema has been updated. If needed, run:

```bash
cd backend
npx prisma db push
```

This adds the `googleServicesTokens` field to the User model.

## 🚀 Step 5: Start the Application

### Backend
```bash
cd backend
npm run dev
```

### Frontend
```bash
npm run dev
```

## 💡 How It Works

### Architecture Overview

```
User Request → Frontend → Backend API Route → Google MCP Service → OpenAI MCP
                                                      ↓
                                            Google Calendar/Drive APIs
                                                      ↓
                                                 Response → User
```

### Key Components

1. **Google MCP Service** (`backend/src/services/google-mcp.js`)
   - Manages OAuth tokens
   - Processes natural language requests
   - Calls OpenAI with MCP tool configurations
   - Handles Google Calendar and Drive operations

2. **Auth Routes** (`backend/src/routes/auth.js`)
   - `/api/auth/google-services` - Initiates OAuth flow
   - `/api/auth/google-services/callback` - Handles OAuth callback
   - `/api/auth/google-services/status` - Checks connection status
   - `/api/auth/google-services/disconnect` - Disconnects account

3. **AI Routes** (`backend/src/routes/ai.js`)
   - `/api/ai/generate-google-services` - Processes natural language requests
   - Auto-detects whether to use Calendar, Drive, or both
   - Returns formatted responses with data

## 🎯 Usage Examples

### Natural Language Requests

**Google Calendar:**
```
"Show my meetings for tomorrow"
"Create a meeting with John at 3 PM next Monday"
"What's on my calendar this week?"
"Find all meetings with Sarah"
```

**Google Drive:**
```
"List my recent documents"
"Find all PDF files in my Drive"
"Search for files about project Alpha"
"Show me files shared with me"
```

**Combined:**
```
"Check my calendar and find related documents"
"What meetings do I have and what files are associated?"
```

### How MCP Works

OpenAI's Model Context Protocol (MCP) enables the AI to:

1. **Understand Intent**: Analyzes natural language to determine what action to take
2. **Execute Actions**: Calls Google APIs through MCP connectors
3. **Format Results**: Returns human-readable responses

The MCP connector configuration:
```javascript
{
  type: "mcp",
  server_label: "google_calendar",
  connector_id: "connector_googlecalendar",
  authorization: `Bearer ${accessToken}`,
  require_approval: "never"
}
```

## 🔒 Security Best Practices

1. **Token Storage**: OAuth tokens are encrypted and stored in PostgreSQL
2. **Environment Variables**: Never commit `.env` files to version control
3. **HTTPS**: Use HTTPS in production for OAuth callbacks
4. **Token Refresh**: Tokens are automatically refreshed when expired
5. **Scopes**: Only request necessary OAuth scopes

## 🐛 Troubleshooting

### "Google connection has expired"
- **Solution**: Reconnect your Google account through the UI
- **Reason**: OAuth tokens expire and need refresh

### "Google Services connection required"
- **Solution**: Click the connection button in the chat interface
- **Reason**: User hasn't connected their Google account yet

### "Failed to get access token"
- **Solution**: Check that OAuth credentials are correct in `.env`
- **Reason**: Invalid Google OAuth configuration

### API Errors
- **Solution**: Ensure Calendar and Drive APIs are enabled in Google Cloud Console
- **Reason**: APIs not activated for your project

### OAuth Callback Issues
- **Solution**: Verify redirect URI matches exactly in Google Console
- **Reason**: Mismatch between configured and actual redirect URIs

## 📊 Testing the Integration

### Test Calendar Operations:
1. Connect your Google account
2. Ask: "What meetings do I have today?"
3. Create a test event: "Create a meeting tomorrow at 2 PM"
4. Verify in your Google Calendar

### Test Drive Operations:
1. Connect your Google account
2. Ask: "List my recent files"
3. Search: "Find documents about project"
4. Verify results match your Drive contents

## 🔄 Production Deployment

### Update Environment Variables:
```env
GOOGLE_REDIRECT_URI=https://yourdomain.com/api/auth/google-services/callback
BASE_URL=https://yourdomain.com
FRONTEND_URL=https://yourdomain.com
```

### Update Google Cloud Console:
1. Add production URLs to Authorized origins and redirect URIs
2. Switch OAuth consent screen to "In production" (if needed)
3. Complete app verification if required by Google

## 📚 Additional Resources

- [OpenAI MCP Documentation](https://platform.openai.com/docs/guides/model-context-protocol)
- [Google Calendar API](https://developers.google.com/calendar/api)
- [Google Drive API](https://developers.google.com/drive/api)
- [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)

## 🎉 Features

✅ **Natural Language Processing**: Ask questions in plain English (or any language)
✅ **Smart Intent Detection**: Automatically determines whether to use Calendar, Drive, or both
✅ **Secure OAuth**: Industry-standard Google OAuth 2.0
✅ **Auto Token Refresh**: Seamless token management
✅ **Rich Responses**: Formatted, easy-to-read results
✅ **Error Handling**: Graceful error messages and reconnection prompts
✅ **Multi-language Support**: Works in any language you speak

## 💬 Support

If you encounter issues:
1. Check this documentation
2. Verify environment variables
3. Check Google Cloud Console configuration
4. Review server logs for detailed error messages
5. Ensure all required APIs are enabled

---

**Note**: This integration uses OpenAI's hosted MCP connectors, which means Google API calls are made through OpenAI's infrastructure with your OAuth tokens. Your data remains secure and private.
