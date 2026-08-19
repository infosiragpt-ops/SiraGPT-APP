'use strict';

class GmailUserClientError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'GmailUserClientError';
    this.code = code;
    this.status = status;
  }
}

async function loadGmailClientForUser({
  prisma,
  userId,
  now = () => Date.now(),
  createClient = () => require('./gmail').createGmailService(),
  decrypt = null,
  encrypt = null,
}) {
  if (!prisma?.user?.findUnique || !userId) {
    throw new GmailUserClientError('gmail_user_required', 'Gmail user is required.', 400);
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { gmailTokens: true },
  });
  if (!user?.gmailTokens) {
    throw new GmailUserClientError(
      'gmail_not_connected',
      'Gmail no está conectado. Conecta la cuenta en Recursos.',
      409,
    );
  }
  const decryptToken = decrypt || require('../utils/encryption').decrypt;
  const encryptToken = encrypt || require('../utils/encryption').encrypt;
  let tokens;
  try {
    tokens = JSON.parse(decryptToken(user.gmailTokens));
  } catch {
    throw new GmailUserClientError(
      'gmail_tokens_invalid',
      'Las credenciales de Gmail no son válidas. Vuelve a conectar la cuenta.',
      409,
    );
  }

  let client = createClient();
  const expiry = Number(tokens.expiresAt || tokens.expiry_date) || 0;
  if (expiry && expiry <= now()) {
    const refreshed = await client.refreshTokens(tokens);
    if (!refreshed) {
      throw new GmailUserClientError(
        'gmail_tokens_expired',
        'La conexión de Gmail expiró. Vuelve a autorizarla.',
        409,
      );
    }
    tokens = refreshed;
    await prisma.user.update({
      where: { id: userId },
      data: { gmailTokens: encryptToken(JSON.stringify(tokens)) },
    });
    // Keep one OAuth client per request even across refresh.
    client = createClient();
  }
  client.setCredentials(tokens);
  return { client, tokens };
}

module.exports = {
  GmailUserClientError,
  loadGmailClientForUser,
};
