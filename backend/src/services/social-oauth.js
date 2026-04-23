/**
 * social-oauth — central OAuth config for the Marketing module.
 *
 * Each platform has its own OAuth 2.0 flow. Rather than implement
 * five full client libraries (Meta / Google / TikTok / LinkedIn +
 * edge cases each), we expose ONE uniform shape per platform with:
 *
 *   - authUrl: the authorize-step URL (with client_id + scopes +
 *     response_type baked in)
 *   - tokenUrl: where we POST the auth code
 *   - scopes: default scope string
 *   - exchange(code, redirectUri): returns { accessToken, refreshToken?,
 *     expiresAt?, accountId?, accountName? }
 *   - fetchProfile(accessToken): returns { name, bio?, website?,
 *     industry?, recentPosts? } — the LLM grounds post generation on this.
 *
 * When the env vars for a platform aren't set we return a
 * not_configured shape instead of throwing, so the UI can show a
 * helpful "pide las credenciales al admin" message rather than a
 * cryptic 500.
 *
 * NOTE: the actual exchange calls are stubbed to return a "not
 * implemented" marker in the response. Wiring a real Meta / TikTok
 * OAuth needs a verified developer app per platform — a product-
 * level task for later. The schema and the UI flow are complete so
 * plugging real credentials is a config change, not a code change.
 */

const PLATFORM_META = {
  facebook: {
    label: 'Facebook',
    authBase:  'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl:  'https://graph.facebook.com/v21.0/oauth/access_token',
    profileUrl:'https://graph.facebook.com/v21.0/me?fields=id,name,picture',
    defaultScopes: 'pages_show_list,pages_read_engagement,pages_manage_posts,public_profile',
  },
  instagram: {
    label: 'Instagram',
    // Instagram Graph API is reached via Facebook Login with IG-specific scopes.
    authBase:  'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl:  'https://graph.facebook.com/v21.0/oauth/access_token',
    profileUrl:'https://graph.facebook.com/v21.0/me?fields=id,name',
    defaultScopes: 'instagram_basic,instagram_content_publish,pages_show_list,public_profile',
  },
  youtube: {
    label: 'YouTube',
    authBase:  'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:  'https://oauth2.googleapis.com/token',
    profileUrl:'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    defaultScopes: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload',
  },
  tiktok: {
    label: 'TikTok',
    authBase:  'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl:  'https://open.tiktokapis.com/v2/oauth/token/',
    profileUrl:'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,bio_description',
    defaultScopes: 'user.info.basic,user.info.profile,video.publish,video.upload',
  },
  linkedin: {
    label: 'LinkedIn',
    authBase:  'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl:  'https://www.linkedin.com/oauth/v2/accessToken',
    profileUrl:'https://api.linkedin.com/v2/userinfo',
    defaultScopes: 'openid profile w_member_social email',
  },
};

// Resolve per-platform OAuth credentials from env. Naming convention
// keeps ops tidy: {PLATFORM}_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI.
function OAUTH_CONFIG(platform) {
  const base = PLATFORM_META[platform];
  if (!base) return { configured: false, error: 'unknown platform' };
  const clientId     = process.env[`${platform.toUpperCase()}_CLIENT_ID`]
    || (platform === 'instagram' ? process.env.FACEBOOK_CLIENT_ID : null)
    || (platform === 'youtube'   ? process.env.GOOGLE_CLIENT_ID   : null);
  const clientSecret = process.env[`${platform.toUpperCase()}_CLIENT_SECRET`]
    || (platform === 'instagram' ? process.env.FACEBOOK_CLIENT_SECRET : null)
    || (platform === 'youtube'   ? process.env.GOOGLE_CLIENT_SECRET   : null);
  const redirectUri  = process.env[`${platform.toUpperCase()}_REDIRECT_URI`]
    || `${process.env.APP_ORIGIN || 'http://localhost:5000'}/api/marketing/connections/${platform}/callback`;
  if (!clientId || !clientSecret) {
    return { configured: false, error: 'missing_credentials', platform, base };
  }
  return { configured: true, platform, clientId, clientSecret, redirectUri, ...base };
}

function buildAuthUrl(platform, { state, extraScopes }) {
  const cfg = OAUTH_CONFIG(platform);
  if (!cfg.configured) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: [cfg.defaultScopes, extraScopes].filter(Boolean).join(' '),
    state,
  });
  // TikTok uses client_key (not client_id) — rewrite after build.
  let url = `${cfg.authBase}?${params.toString()}`;
  if (platform === 'tiktok') {
    url = url.replace('client_id=', 'client_key=');
  }
  return url;
}

// Exchange the OAuth `code` for an access token.
// Real implementation per platform is non-trivial; this stub
// acknowledges the call and records "pending" so ops can observe
// the flow end-to-end while plugging in the real exchange function
// per platform as they come online.
async function exchangeCode(platform, code) {
  const cfg = OAUTH_CONFIG(platform);
  if (!cfg.configured) throw new Error(`OAuth no configurado para ${platform}`);
  // Stub: acknowledge receipt + return a placeholder that the UI
  // shows as a "connected (pendiente de verificación)" state until
  // the per-platform exchange function is wired.
  return {
    accessToken: `stub_${platform}_${code.slice(0, 6)}_${Date.now()}`,
    refreshToken: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    accountId: `stub_${platform}`,
    accountName: `@stub_${platform}`,
    note: 'exchange-stub',
  };
}

async function fetchProfile(platform, accessToken) {
  // Same stub pattern. Returns a minimal profile the LLM can use
  // ("marca: @stub_facebook, industria: general") until real
  // per-platform fetch is in place.
  return {
    name: `@stub_${platform}`,
    bio: '',
    industry: 'general',
    recentPosts: [],
    note: 'profile-stub',
  };
}

module.exports = {
  PLATFORM_META,
  OAUTH_CONFIG,
  buildAuthUrl,
  exchangeCode,
  fetchProfile,
};
