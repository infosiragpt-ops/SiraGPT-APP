'use strict';

/**
 * /api/integrations/slack — user-facing Slack Incoming Webhook config.
 *
 *   POST /api/integrations/slack/connect   { webhookUrl, channelName?, isEnabled? }
 *   POST /api/integrations/slack/test
 *   GET  /api/integrations/slack
 *   DELETE /api/integrations/slack
 *
 * The webhook URL is encrypted at rest via slack-integration.encryptToken.
 * `test` posts a small Block-kit message so the user can verify the URL
 * before flipping isEnabled = true.
 */

const express = require('express');
const { authenticateToken } = require('../../middleware/auth');
const prisma = require('../../config/database');
const slack = require('../../services/slack-integration');

const router = express.Router();

function isSlackWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'hooks.slack.com' || u.hostname.endsWith('.slack.com');
  } catch { return false; }
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    channelName: row.channelName || null,
    isEnabled: !!row.isEnabled,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    lastEventAt: row.lastEventAt
      ? (row.lastEventAt instanceof Date ? row.lastEventAt.toISOString() : row.lastEventAt)
      : null,
    webhookUrl: row.webhookUrl ? 'https://hooks.slack.com/services/•••' : null,
  };
}

router.post('/connect', authenticateToken, async (req, res) => {
  const { webhookUrl, channelName = null, isEnabled = true } = req.body || {};
  if (!isSlackWebhookUrl(webhookUrl)) {
    return res.status(400).json({ error: 'webhookUrl must be a valid https://hooks.slack.com URL' });
  }
  try {
    const encrypted = slack.encryptToken(webhookUrl);
    const existing = await prisma.slackIntegration.findFirst({ where: { userId: req.user.id } });
    let row;
    if (existing) {
      row = await prisma.slackIntegration.update({
        where: { id: existing.id },
        data: { webhookUrl: encrypted, channelName, isEnabled: !!isEnabled },
      });
    } else {
      row = await prisma.slackIntegration.create({
        data: {
          userId: req.user.id,
          webhookUrl: encrypted,
          channelName,
          isEnabled: !!isEnabled,
        },
      });
    }
    return res.status(201).json({ slack: serialize(row) });
  } catch (err) {
    console.error('[integrations/slack] connect failed:', err.message);
    return res.status(500).json({ error: 'failed to connect Slack' });
  }
});

router.post('/test', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.slackIntegration.findFirst({ where: { userId: req.user.id } });
    if (!existing) return res.status(404).json({ error: 'no Slack integration configured' });
    const decrypted = slack.decryptToken(existing.webhookUrl);
    if (!decrypted) return res.status(500).json({ error: 'failed to decrypt stored webhook' });
    const out = await slack.sendEventNotification({
      webhookUrl: decrypted,
      event: 'integrations.slack.test',
      userId: req.user.id,
      payload: { message: 'SiraGPT Slack integration test ping.' },
    });
    if (out.ok && existing.id) {
      prisma.slackIntegration.update({
        where: { id: existing.id },
        data: { lastEventAt: new Date() },
      }).catch(() => {});
    }
    return res.json({ ok: out.ok, status: out.status });
  } catch (err) {
    console.error('[integrations/slack] test failed:', err.message);
    return res.status(500).json({ error: 'failed to test Slack' });
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    const row = await prisma.slackIntegration.findFirst({ where: { userId: req.user.id } });
    return res.json({ slack: serialize(row) });
  } catch (err) {
    console.error('[integrations/slack] get failed:', err.message);
    return res.status(500).json({ error: 'failed to load Slack config' });
  }
});

router.delete('/', authenticateToken, async (req, res) => {
  try {
    await prisma.slackIntegration.deleteMany({ where: { userId: req.user.id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[integrations/slack] delete failed:', err.message);
    return res.status(500).json({ error: 'failed to delete Slack config' });
  }
});

module.exports = router;
