const SpotifyWebApi = require('spotify-web-api-node');
const jwt = require('jsonwebtoken');
const { encrypt, decrypt } = require('../utils/encryption');
const prisma = require('../config/database');

// OAuth `state` must be a SIGNED token, not the bare userId — otherwise an
// attacker who completes the consent flow can tamper `state` to a victim's id
// and overwrite the victim's stored Spotify tokens (account-linking CSRF).
// Mirrors github-oauth.service.js signState/verifyState.
const SPOTIFY_STATE_TTL_SECONDS = 600;
function signState(userId) {
  return jwt.sign({ uid: String(userId), kind: 'spotify_oauth' }, process.env.JWT_SECRET, {
    expiresIn: SPOTIFY_STATE_TTL_SECONDS,
  });
}
function verifyState(state) {
  try {
    const decoded = jwt.verify(String(state || ''), process.env.JWT_SECRET);
    if (!decoded || decoded.kind !== 'spotify_oauth' || !decoded.uid) return null;
    return String(decoded.uid);
  } catch {
    return null;
  }
}

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI,
});

// Defensive read for User.spotifyTokens. New writes are AES-CBC
// encrypted (format `<iv_hex>:<ciphertext_hex>`). Pre-fix rows were
// stored as plain JSON and start with `{`. Prefer decrypt; fall back
// to plaintext so existing connected users don't get forced through
// a re-auth flow — the next refresh write upgrades them transparently.
function readSpotifyTokens(stored) {
  if (typeof stored !== 'string' || stored.length === 0) {
    throw new Error('Empty Spotify tokens');
  }
  if (stored.startsWith('{')) {
    return JSON.parse(stored);
  }
  return JSON.parse(decrypt(stored));
}

// Helper function to analyze user intent using OpenAI
async function analyzeIntent(message) {
  const systemPrompt = `You are a Spotify assistant. Analyze the user's message and determine their intent.
    
    Respond with a JSON object containing:
    - type: one of 'search_tracks', 'search_artists', 'search_playlists', 'get_recommendations', 'get_history', or 'general'
    - query: the search query or artist name (empty string if not applicable)
    - limit: the number of items to return (default to 5 if not specified, 20 for history)
    - confidence: a number between 0 and 1 indicating how confident you are about the intent
    
    Examples:
    - "Show me 10 songs by The Weeknd" -> {"type": "search_tracks", "query": "The Weeknd", "limit": 10, "confidence": 0.95}
    - "Find 3 playlists for workout" -> {"type": "search_playlists", "query": "workout", "limit": 3, "confidence": 0.9}
    - "Show me songs by The Weeknd" -> {"type": "search_tracks", "query": "The Weeknd", "limit": 5, "confidence": 0.95}
    - "Show my listening history" -> {"type": "get_history", "query": "", "limit": 20, "confidence": 0.98}
    - "What have I been listening to?" -> {"type": "get_history", "query": "", "limit": 20, "confidence": 0.95}
    - "What's your favorite color?" -> {"type": "general", "query": "", "limit": null, "confidence": 0.8}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
      // Bound the call so a stalled OpenAI socket can't hang the Spotify
      // chat request forever; the catch below degrades gracefully on abort.
      signal: AbortSignal.timeout(Number(process.env.SPOTIFY_MCP_OPENAI_TIMEOUT_MS) || 15000),
    });

    const data = await response.json();
    const content = data.choices[0].message.content;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return { type: "general", query: "", confidence: 0.5 };
  } catch (error) {
    console.error("OpenAI Intent Analysis Error:", error);
    return { type: "general", query: "", confidence: 0 };
  }
}

// Helper function to generate a general response using OpenAI
async function generateResponse(message, conversationHistory = []) {
  try {
    const messages = [
      ...conversationHistory.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      { role: "user", content: message },
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages,
        temperature: 0.7,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(Number(process.env.SPOTIFY_MCP_OPENAI_TIMEOUT_MS) || 15000),
    });

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI Response Generation Error:", error);
    return "Sorry, I encountered an error while processing your request.";
  }
}

const spotifyService = {
  async connect(userId) {
    const scopes = [
      'user-read-private',
      'user-read-email',
      'playlist-read-private',
      'user-library-read',
      'user-top-read',
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-recently-played'
    ];
    const authorizeURL = spotifyApi.createAuthorizeURL(scopes, signState(userId));
    return authorizeURL;
  },

  async handleCallback(code) {
    try {
      const data = await spotifyApi.authorizationCodeGrant(code);
      const { access_token, refresh_token } = data.body;
      return { access_token, refresh_token };
    } catch (error) {
      console.error('Error during Spotify callback:', error);
      throw new Error('Failed to handle Spotify callback');
    }
  },

  async makeSpotifyApiCall(apiCall, userId, tokens) {
    try {
      return await apiCall();
    } catch (error) {
      if (error.statusCode === 401) {
        console.log("Access token expired. Refreshing now...");
        try {
          spotifyApi.setRefreshToken(tokens.refresh_token);
          const data = await spotifyApi.refreshAccessToken();
          const newAccessToken = data.body['access_token'];
          console.log("New access token obtained.");

          spotifyApi.setAccessToken(newAccessToken);

          const updatedTokens = {
            access_token: newAccessToken,
            refresh_token: tokens.refresh_token,
          };
          await prisma.user.update({
            where: { id: userId },
            data: { spotifyTokens: encrypt(JSON.stringify(updatedTokens)) },
          });

          console.log("Retrying the original command with the new token...");
          return await apiCall();
        } catch (refreshError) {
          console.error("Could not refresh the access token!", refreshError);
          throw new Error("Could not refresh Spotify connection. Please reconnect manually.");
        }
      }
      console.error("A different error occurred:", error);
      throw new Error("An unexpected error occurred with Spotify.");
    }
  },

  async searchTracks(query, limit = 5) {
    const data = await spotifyApi.searchTracks(query, { limit });
    return { tracks: data.body.tracks.items };
  },

  async searchArtists(query, limit = 5) {
    const data = await spotifyApi.searchArtists(query, { limit });
    return { artists: data.body.artists.items };
  },

  async searchPlaylists(query, limit = 5) {
    const data = await spotifyApi.searchPlaylists(query, { limit });
    return { playlists: data.body.playlists.items };
  },

  async getRecommendations(seedArtist, limit = 5) {
    const artistSearch = await spotifyApi.searchArtists(seedArtist, { limit: 1 });
    if (!artistSearch.body.artists.items.length) {
      return { tracks: [] };
    }
    const artistId = artistSearch.body.artists.items[0].id;

    const data = await spotifyApi.getRecommendations({ seed_artists: [artistId], limit });
    return { tracks: data.body.tracks };
  },

  async getRecentlyPlayed(limit = 20) {
    const data = await spotifyApi.getMyRecentlyPlayedTracks({ limit });
    return { tracks: data.body.items.map(item => item.track) };
  },

  async processCommand(prompt, userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.spotifyTokens) {
      return { requiresConnection: true };
    }
    const tokens = readSpotifyTokens(user.spotifyTokens);
    spotifyApi.setAccessToken(tokens.access_token);
    spotifyApi.setRefreshToken(tokens.refresh_token);

    const intent = await analyzeIntent(prompt);

    const apiCallWrapper = (apiCall) => this.makeSpotifyApiCall(apiCall, userId, tokens);

    switch (intent.type) {
      case 'search_tracks':
        return await apiCallWrapper(() => this.searchTracks(intent.query, intent.limit));
      case 'search_artists':
        return await apiCallWrapper(() => this.searchArtists(intent.query, intent.limit));
      case 'search_playlists':
        return await apiCallWrapper(() => this.searchPlaylists(intent.query, intent.limit));
      case 'get_recommendations':
        return await apiCallWrapper(() => this.getRecommendations(intent.query, intent.limit));
      case 'get_history':
        return await apiCallWrapper(() => this.getRecentlyPlayed(intent.limit));
      case 'general':
      default:
        const response = await generateResponse(prompt);
        return { generalResponse: response };
    }
  },
};

module.exports = spotifyService;
module.exports.signState = signState;
module.exports.verifyState = verifyState;
