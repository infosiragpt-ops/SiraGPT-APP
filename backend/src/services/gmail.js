const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

class GmailService {
  constructor() {
    this.oauth2Client = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  // Set credentials for a user
  setCredentials(tokens) {
    // Ensure tokens are in the correct format for Google OAuth2Client
    const credentials = {
      access_token: tokens.accessToken || tokens.access_token,
      refresh_token: tokens.refreshToken || tokens.refresh_token,
      token_type: tokens.tokenType || tokens.token_type || 'Bearer',
      expiry_date: tokens.expiresAt || tokens.expiry_date,
      scope: tokens.scope // Include scope information
    };
    
    console.log('Setting credentials:', { 
      hasAccessToken: !!credentials.access_token,
      hasRefreshToken: !!credentials.refresh_token,
      expiryDate: credentials.expiry_date ? new Date(credentials.expiry_date) : 'none',
      scope: credentials.scope
    });
    
    if (!credentials.refresh_token) {
      console.warn('⚠️ No refresh token available. User may need to re-authenticate with consent.');
    }
    
    this.oauth2Client.setCredentials(credentials);
  }

  // Refresh tokens
  async refreshTokens(tokens) {
    try {
      // Set initial credentials with refresh token
      const initialCredentials = {
        access_token: tokens.accessToken || tokens.access_token,
        refresh_token: tokens.refreshToken || tokens.refresh_token,
        token_type: tokens.tokenType || tokens.token_type || 'Bearer'
      };
      
      this.oauth2Client.setCredentials(initialCredentials);
      
      console.log('Refreshing tokens with refresh_token:', !!initialCredentials.refresh_token);
      
      // Get new access token
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      
      console.log('Token refresh successful, new expiry:', new Date(credentials.expiry_date));
      
      return {
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token || tokens.refreshToken || tokens.refresh_token,
        scope: tokens.scope || 'gmail',
        tokenType: credentials.token_type || 'Bearer',
        expiresAt: credentials.expiry_date // Google provides expiry_date
      };
    } catch (error) {
      console.error('Error refreshing Gmail tokens:', error);
      return null; // Return null to indicate refresh failed
    }
  }

  // Check if required Gmail scopes are present
  hasRequiredScopes(tokens) {
    // Log only the scope string / key names — never the raw token object.
    console.log('Checking Gmail token scopes...', tokens && tokens.scope ? tokens.scope : (tokens ? Object.keys(tokens) : null));
    const requiredScopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify'
    ];
    
    const tokenScope = tokens.scope || '';
    const hasAllScopes = requiredScopes.every(scope => tokenScope.includes(scope));
    
    console.log('Scope check:', {
      tokenScope,
      hasAllScopes,
      missingScopes: requiredScopes.filter(scope => !tokenScope.includes(scope))
    });
    
    return hasAllScopes;
  }

  // Get Gmail client
  getGmailClient() {
    // Validate that credentials are set
    const credentials = this.oauth2Client.credentials;
    if (!credentials || !credentials.access_token) {
      throw new Error('Gmail credentials not properly set. Missing access token.');
    }
    
    return google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  // Send an email
  async sendEmail({ to, subject, body, from = 'me' }) {
    try {
      const gmail = this.getGmailClient();

      // Convert line breaks to HTML for proper display in Gmail
      const htmlBody = body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
      const formattedBody = `<p>${htmlBody}</p>`;

      // Create email content
      const email = [
        'Content-Type: text/html; charset="UTF-8"',
        'MIME-Version: 1.0',
        `To: ${to}`,
        `Subject: ${subject}`,
        '',
        formattedBody
      ].join('\n');

      // Encode email
      const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const response = await gmail.users.messages.send({
        userId: from,
        requestBody: {
          raw: encodedEmail
        }
      });

      return {
        success: true,
        messageId: response.data.id,
        threadId: response.data.threadId
      };
    } catch (error) {
      console.error('Error sending email:', error);
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  // Get emails
  async getEmails({ query = '', maxResults = 10, userId = 'me', unreadOnly = false, readOnly = false }) {
    try {
      const gmail = this.getGmailClient();

      // Build query string
      let searchQuery = query;
      if (unreadOnly) {
        searchQuery = searchQuery ? `${searchQuery} is:unread` : 'is:unread';
      } else if (readOnly) {
        searchQuery = searchQuery ? `${searchQuery} is:read` : 'is:read';
      }

      // List messages
      const listResponse = await gmail.users.messages.list({
        userId,
        q: searchQuery,
        maxResults
      });

      if (!listResponse.data.messages) {
        return [];
      }

      // Get detailed information for each message. allSettled (not all) so one
      // failing message — a 429 from the parallel fan-out, a 404 if it moved in
      // the list→get window, or a transient network error — doesn't throw away
      // the other N-1 messages that fetched successfully.
      const settled = await Promise.allSettled(
        listResponse.data.messages.map(async (message) => {
          const messageResponse = await gmail.users.messages.get({
            userId,
            id: message.id,
            format: 'full'
          });

          const headers = messageResponse.data.payload.headers;
          const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

          // Extract body text
          let body = '';
          let isHtml = false;

          if (messageResponse.data.payload.body?.data) {
            body = Buffer.from(messageResponse.data.payload.body.data, 'base64').toString();
            isHtml = messageResponse.data.payload.mimeType === 'text/html';
          } else if (messageResponse.data.payload.parts) {
            // Handle multipart messages - prefer plain text, fallback to HTML
            let textPart = messageResponse.data.payload.parts.find(part => part.mimeType === 'text/plain');
            if (!textPart) {
              textPart = messageResponse.data.payload.parts.find(part => part.mimeType === 'text/html');
              isHtml = true;
            }

            if (textPart?.body?.data) {
              body = Buffer.from(textPart.body.data, 'base64').toString();
            }
          }

          // Clean up HTML if necessary
          if (isHtml && body) {
            // Simple HTML to text conversion
            body = body
              // Remove script and style elements completely
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              // Remove HTML tags but keep content
              .replace(/<[^>]*>/g, ' ')
              // Decode HTML entities
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              // Clean up whitespace
              .replace(/\s+/g, ' ')
              .trim();
          }

          return {
            id: message.id,
            threadId: messageResponse.data.threadId,
            subject: getHeader('Subject'),
            from: getHeader('From'),
            to: getHeader('To'),
            date: getHeader('Date'),
            body: body.substring(0, 500) + (body.length > 500 ? '...' : ''), // Truncate for summary
            snippet: messageResponse.data.snippet,
            labelIds: messageResponse.data.labelIds || [],
            isUnread: messageResponse.data.labelIds?.includes('UNREAD') || false
          };
        })
      );
      for (const r of settled) {
        if (r.status === 'rejected') {
          console.warn('Failed to fetch a Gmail message:', (r.reason && r.reason.message) || r.reason);
        }
      }
      const emails = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);

      return emails;
    } catch (error) {
      console.error('Error getting emails:', error);
      throw new Error(`Failed to get emails: ${error.message}`);
    }
  }

  // Delete an email
  async deleteEmail({ messageId, userId = 'me' }) {
    try {
      const gmail = this.getGmailClient();

      await gmail.users.messages.delete({
        userId,
        id: messageId
      });

      return {
        success: true,
        messageId
      };
    } catch (error) {
      console.error('Error deleting email:', error);
      throw new Error(`Failed to delete email: ${error.message}`);
    }
  }

  // Reply to an email
  async replyToEmail({ threadId, messageId, body, userId = 'me' }) {
    try {
      const gmail = this.getGmailClient();

      // Get original message for context
      const originalMessage = await gmail.users.messages.get({
        userId,
        id: messageId,
        format: 'full'
      });

      const headers = originalMessage.data.payload.headers;
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const originalFrom = getHeader('From');
      const originalSubject = getHeader('Subject');
      const replySubject = originalSubject.startsWith('Re: ') ? originalSubject : `Re: ${originalSubject}`;

      // Create reply email
      const email = [
        'Content-Type: text/html; charset="UTF-8"',
        'MIME-Version: 1.0',
        `To: ${originalFrom}`,
        `Subject: ${replySubject}`,
        `In-Reply-To: ${getHeader('Message-ID')}`,
        `References: ${getHeader('References') || ''} ${getHeader('Message-ID')}`,
        '',
        body
      ].join('\n');

      // Encode email
      const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const response = await gmail.users.messages.send({
        userId,
        requestBody: {
          raw: encodedEmail,
          threadId
        }
      });

      return {
        success: true,
        messageId: response.data.id,
        threadId: response.data.threadId
      };
    } catch (error) {
      console.error('Error replying to email:', error);
      throw new Error(`Failed to reply to email: ${error.message}`);
    }
  }

  // Mark email as read/unread
  async markEmail({ messageId, read = true, userId = 'me' }) {
    try {
      const gmail = this.getGmailClient();

      const labelsToAdd = read ? [] : ['UNREAD'];
      const labelsToRemove = read ? ['UNREAD'] : [];

      await gmail.users.messages.modify({
        userId,
        id: messageId,
        requestBody: {
          addLabelIds: labelsToAdd,
          removeLabelIds: labelsToRemove
        }
      });

      return {
        success: true,
        messageId,
        read
      };
    } catch (error) {
      console.error('Error marking email:', error);
      throw new Error(`Failed to mark email: ${error.message}`);
    }
  }

  // Star or unstar an email
  async starEmail({ messageId, starred = true, userId = 'me' }) {
    try {
      const gmail = this.getGmailClient();

      const labelsToAdd = starred ? ['STARRED'] : [];
      const labelsToRemove = starred ? [] : ['STARRED'];

      await gmail.users.messages.modify({
        userId,
        id: messageId,
        requestBody: {
          addLabelIds: labelsToAdd,
          removeLabelIds: labelsToRemove
        }
      });

      return {
        success: true,
        messageId,
        starred
      };
    } catch (error) {
      console.error('Error starring email:', error);
      throw new Error(`Failed to update star status: ${error.message}`);
    }
  }

  // Archive or move back to inbox (archive=true removes INBOX label)
  async archiveEmail({ messageId, archive = true, userId = 'me' }) {
    try {
      const gmail = this.getGmailClient();

      // Archiving in Gmail = remove INBOX label. Unarchive = add INBOX back.
      const labelsToAdd = archive ? [] : ['INBOX'];
      const labelsToRemove = archive ? ['INBOX'] : [];

      await gmail.users.messages.modify({
        userId,
        id: messageId,
        requestBody: {
          addLabelIds: labelsToAdd,
          removeLabelIds: labelsToRemove
        }
      });

      return {
        success: true,
        messageId,
        archived: archive
      };
    } catch (error) {
      console.error('Error archiving email:', error);
      throw new Error(`Failed to update archive status: ${error.message}`);
    }
  }

  // Search emails
  async searchEmails({ query, maxResults = 10, userId = 'me' }) {
    try {
      return await this.getEmails({ query, maxResults, userId });
    } catch (error) {
      console.error('Error searching emails:', error);
      throw new Error(`Failed to search emails: ${error.message}`);
    }
  }

  // Create draft email
  async createDraft({ to, subject, body, from = 'me' }) {
    try {
      const gmail = this.getGmailClient();

      // Convert line breaks to HTML for proper display in Gmail
      const htmlBody = body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
      const formattedBody = `<p>${htmlBody}</p>`;

      // Create email content
      const email = [
        'Content-Type: text/html; charset="UTF-8"',
        'MIME-Version: 1.0',
        `To: ${to}`,
        `Subject: ${subject}`,
        '',
        formattedBody
      ].join('\n');

      // Encode email
      const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const response = await gmail.users.drafts.create({
        userId: from,
        requestBody: {
          message: {
            raw: encodedEmail
          }
        }
      });

      return {
        success: true,
        draftId: response.data.id,
        messageId: response.data.message.id
      };
    } catch (error) {
      console.error('Error creating draft:', error);
      throw new Error(`Failed to create draft: ${error.message}`);
    }
  }

  // Get email thread
  async getThread({ threadId, userId = 'me' }) {
    try {
      const gmail = this.getGmailClient();

      const threadResponse = await gmail.users.threads.get({
        userId,
        id: threadId,
        format: 'full'
      });

      const messages = threadResponse.data.messages.map(message => {
        const headers = message.payload.headers;
        const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        // Extract body text
        let body = '';
        if (message.payload.body?.data) {
          body = Buffer.from(message.payload.body.data, 'base64').toString();
        } else if (message.payload.parts) {
          const textPart = message.payload.parts.find(
            part => part.mimeType === 'text/plain' || part.mimeType === 'text/html'
          );
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString();
          }
        }

        return {
          id: message.id,
          subject: getHeader('Subject'),
          from: getHeader('From'),
          to: getHeader('To'),
          date: getHeader('Date'),
          body,
          snippet: message.snippet
        };
      });

      return {
        threadId,
        messages
      };
    } catch (error) {
      console.error('Error getting thread:', error);
      throw new Error(`Failed to get thread: ${error.message}`);
    }
  }
}

module.exports = new GmailService();