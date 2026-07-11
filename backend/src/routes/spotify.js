const express = require('express');
const router = express.Router();
const spotifyService = require('../services/spotify-mcp');
const { encrypt } = require('../utils/encryption');
const prisma = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { getSpotifyPostCallbackURL } = require('../config/oauth-url-policy');
const {
  isOAuthStateInfrastructureError,
  sendOAuthStateUnavailable,
} = require('../services/auth/oauth-state-http');

// Route to get Spotify connection URL
router.get('/connect', authenticateToken, async (req, res) => {
  try {
    const authorizeURL = await spotifyService.connect(req.user.id);
    res.json({ url: authorizeURL });
  } catch (error) {
    if (isOAuthStateInfrastructureError(error)) {
      return sendOAuthStateUnavailable(res, { provider: 'spotify', error });
    }
    return res.status(500).json({ error: 'Failed to get Spotify connection URL' });
  }
});

// Route to handle Spotify callback
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  // Recover the user id from the SIGNED state — never trust a raw id in the
  // query, or an attacker could overwrite another user's Spotify tokens.
  let userId;
  try {
    userId = await spotifyService.verifyState(state);
  } catch (error) {
    if (isOAuthStateInfrastructureError(error)) {
      return sendOAuthStateUnavailable(res, { provider: 'spotify', error });
    }
    return res.redirect(getSpotifyPostCallbackURL('invalid_state'));
  }
  if (!userId) {
    return res.redirect(getSpotifyPostCallbackURL('invalid_state'));
  }
  try {
    const { access_token, refresh_token } = await spotifyService.handleCallback(code);

    // Never log raw OAuth tokens — only their presence.
    console.log('[spotify] callback ok, tokens received:', !!access_token, !!refresh_token);

    const tokensToStore = {
      access_token: access_token,
      refresh_token: refresh_token,
      // Aap yahan expiry time bhi save kar sakte hain agar zaroorat ho
    };

    await prisma.user.update({
      where: { id: userId },
      data: {
        // Stored as AES-CBC ciphertext (`<iv>:<ct>`). Read path in
        // services/spotify-mcp.js handles both this and the legacy
        // plain-JSON shape so existing connected users keep working.
        spotifyTokens: encrypt(JSON.stringify(tokensToStore)),
      },
    });

    // User ko frontend par redirect karein
    return res.redirect(getSpotifyPostCallbackURL('connected'));

  } catch (error) {
    console.log('Error during Spotify callback:', error?.message || 'spotify_callback_failed');
    return res.redirect(getSpotifyPostCallbackURL('error'));

  }

});

// Route to process Spotify commands
router.post('/command', authenticateToken, async (req, res) => {
  const { prompt, chatId } = req.body;
  const userId = req.user.id;

  try {
    const result = await spotifyService.processCommand(prompt, userId);

    if (chatId) {
      await prisma.message.create({
        data: {
          chatId,
          role: 'USER',
          content: prompt,
        },
      });
      // await prisma.message.create({
      //   data: {
      //     chatId,
      //     role: 'ASSISTANT',
      //     content: result.generalResponse || "Here are your Spotify results:",
      //     metadata: {
      //       type: 'spotify_results',
      //       data: result
      //     },
      //   },
      // });
      if (result.requiresConnection) {
        await prisma.message.create({
          data: {
            chatId,
            role: 'ASSISTANT',
            content: "your Spotify account",
            metadata: {
              type: 'spotify_connection_required',
              showConnectionCard: true
            },
          },
        });
      } else {
        await prisma.message.create({
          data: {
            chatId,
            role: 'ASSISTANT',
            content: result.generalResponse || "Here are your Spotify results:",
            metadata: {
              type: 'spotify_results',
              data: result
            },
          },
        });
      }
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to process Spotify command' });
  }
});

router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user && user.spotifyTokens) {
      res.json({ isConnected: true });
    } else {
      res.json({ isConnected: false });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to get Spotify status' });
  }
});

module.exports = router;
