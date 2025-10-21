const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const gmailService = require('../services/gmail');
const prisma = require('../config/database');

const router = express.Router();

// Helper function to get user's Gmail tokens
async function getUserGmailTokens(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { gmailTokens: true }
  });

  if (!user?.gmailTokens) {
    throw new Error('Gmail not connected. Please connect Gmail in settings.');
  }

  return JSON.parse(user.gmailTokens);
}

// Check Gmail connection status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { gmailTokens: true }
    });

    const isConnected = !!user?.gmailTokens;
    
    res.json({
      connected: isConnected,
      status: isConnected ? 'connected' : 'disconnected'
    });
  } catch (error) {
    console.error('Gmail status check error:', error);
    res.status(500).json({ error: 'Failed to check Gmail status' });
  }
});

// Connect endpoint removed - use /api/auth/gmail directly

// Send email
router.post('/send', authenticateToken, async (req, res) => {
  try {
    const { to, subject, body } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, body' });
    }

    // Get user's Gmail tokens
    const tokens = await getUserGmailTokens(req.user.id);
    gmailService.setCredentials(tokens);

    const result = await gmailService.sendEmail({ to, subject, body });

    res.json({
      success: true,
      message: `Email sent successfully to ${to}`,
      messageId: result.messageId,
      threadId: result.threadId
    });
  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get emails
router.get('/emails', authenticateToken, async (req, res) => {
  try {
    const { query = '', limit = 10 } = req.query;

    // Get user's Gmail tokens
    const tokens = await getUserGmailTokens(req.user.id);
    gmailService.setCredentials(tokens);

    const emails = await gmailService.getEmails({
      query,
      maxResults: parseInt(limit)
    });

    res.json({
      success: true,
      emails,
      count: emails.length
    });
  } catch (error) {
    console.error('Get emails error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete email
router.delete('/email/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;

    // Get user's Gmail tokens
    const tokens = await getUserGmailTokens(req.user.id);
    gmailService.setCredentials(tokens);

    const result = await gmailService.deleteEmail({ messageId });

    res.json({
      success: true,
      message: `Email deleted successfully`,
      messageId: result.messageId
    });
  } catch (error) {
    console.error('Delete email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reply to email
router.post('/reply', authenticateToken, async (req, res) => {
  try {
    const { threadId, messageId, body } = req.body;

    if (!threadId || !messageId || !body) {
      return res.status(400).json({ error: 'Missing required fields: threadId, messageId, body' });
    }

    // Get user's Gmail tokens
    const tokens = await getUserGmailTokens(req.user.id);
    gmailService.setCredentials(tokens);

    const result = await gmailService.replyToEmail({ threadId, messageId, body });

    res.json({
      success: true,
      message: `Reply sent successfully`,
      messageId: result.messageId,
      threadId: result.threadId
    });
  } catch (error) {
    console.error('Reply email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search emails
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    // Get user's Gmail tokens
    const tokens = await getUserGmailTokens(req.user.id);
    gmailService.setCredentials(tokens);

    const emails = await gmailService.searchEmails({
      query: q,
      maxResults: parseInt(limit)
    });

    res.json({
      success: true,
      emails,
      count: emails.length,
      query: q
    });
  } catch (error) {
    console.error('Search emails error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark email as read/unread
router.patch('/email/:messageId/mark', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { read = true } = req.body;

    // Get user's Gmail tokens
    const tokens = await getUserGmailTokens(req.user.id);
    gmailService.setCredentials(tokens);

    const result = await gmailService.markEmail({ messageId, read });

    res.json({
      success: true,
      message: `Email marked as ${read ? 'read' : 'unread'}`,
      messageId: result.messageId
    });
  } catch (error) {
    console.error('Mark email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get email thread
router.get('/thread/:threadId', authenticateToken, async (req, res) => {
  try {
    const { threadId } = req.params;

    // Get user's Gmail tokens
    const tokens = await getUserGmailTokens(req.user.id);
    gmailService.setCredentials(tokens);

    const thread = await gmailService.getThread({ threadId });

    res.json({
      success: true,
      thread
    });
  } catch (error) {
    console.error('Get thread error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;