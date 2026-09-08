const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { loadGmailClientForUser } = require('../services/gmail-user-client');
const { requireHumanApproval } = require('../services/codex/company-operations/external-actions');
const prisma = require('../config/database');

const router = express.Router();

// Clamp a user-supplied `limit` to a sane positive integer (radix-10; NaN / 0 /
// blank → default). A bare parseInt(req.query.limit) returned NaN for 'abc'
// (default params don't rescue NaN) and auto-detected hex for '0x10' — both
// reached the Gmail API's maxResults and 500'd / mis-counted.
function clampMaxResults(raw, def = 10, max = 100) {
  const n = Number.parseInt(String(raw), 10);
  return Math.max(1, Math.min(max, n || def));
}

async function getUserGmailClient(userId) {
  const loaded = await loadGmailClientForUser({ prisma, userId });
  return loaded.client;
}

function rejectDirectGmailMutation(req, res, kind) {
  const gate = requireHumanApproval({ kind, actorId: req.user?.id || null });
  return res.status(403).json({
    success: false,
    code: gate.reason,
    status: 'pending_review',
    message: 'Email output requires a persisted action and explicit human approval.',
  });
}

// Check Gmail connection status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { gmailTokens: true }
    });

    let isConnected = false;
    let isExpired = false;
    
    if (user?.gmailTokens) {
      try {
        const { decrypt } = require('../utils/encryption');
        const tokens = JSON.parse(decrypt(user.gmailTokens));
        isConnected = true;
        
        // Check if tokens are expired
        if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
          isExpired = true;
        }
      } catch (error) {
        console.error('Error decrypting Gmail tokens:', error);
        isConnected = false;
      }
    }
    
    res.json({
      connected: isConnected,
      expired: isExpired,
      status: isConnected ? (isExpired ? 'expired' : 'connected') : 'disconnected'
    });
  } catch (error) {
    console.error('Gmail status check error:', error);
    res.status(500).json({ error: 'Failed to check Gmail status' });
  }
});

// Connect endpoint removed - use /api/auth/gmail directly

// Send email
router.post('/send', authenticateToken, async (req, res) => {
  return rejectDirectGmailMutation(req, res, 'email_send');
});

// Get emails
router.get('/emails', authenticateToken, async (req, res) => {
  try {
    const { query = '', limit = 10 } = req.query;

    const gmailService = await getUserGmailClient(req.user.id);

    const emails = await gmailService.getEmails({
      query,
      maxResults: clampMaxResults(limit)
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
  return rejectDirectGmailMutation(req, res, 'email_delete');
});

// Reply to email
router.post('/reply', authenticateToken, async (req, res) => {
  return rejectDirectGmailMutation(req, res, 'email_reply');
});

// Forwarding was never allowed to bypass the company action gate. Keep the
// legacy route shape so clients receive a deterministic block instead of
// falling through to a provider call.
router.post('/forward', authenticateToken, async (req, res) => (
  rejectDirectGmailMutation(req, res, 'email_forward')
));

// Search emails
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const gmailService = await getUserGmailClient(req.user.id);

    const emails = await gmailService.searchEmails({
      query: q,
      maxResults: clampMaxResults(limit)
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
  return rejectDirectGmailMutation(req, res, 'email_mark');
});

// Star/Unstar email
router.patch('/email/:messageId/star', authenticateToken, async (req, res) => {
  return rejectDirectGmailMutation(req, res, 'email_star');
});

// Archive/Unarchive email
router.patch('/email/:messageId/archive', authenticateToken, async (req, res) => {
  return rejectDirectGmailMutation(req, res, 'email_archive');
});

// Get email thread
router.get('/thread/:threadId', authenticateToken, async (req, res) => {
  try {
    const { threadId } = req.params;

    const gmailService = await getUserGmailClient(req.user.id);

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
module.exports.clampMaxResults = clampMaxResults;
module.exports.getUserGmailClient = getUserGmailClient;
