const prisma = require('../config/database');
const { validateActiveSession } = require('../services/active-session-validator');

function extractToken(req) {
  const authHeader = req?.headers?.authorization;
  const match = typeof authHeader === 'string'
    ? authHeader.match(/^\s*Bearer\s+([^\s]+)\s*$/i)
    : null;
  return match?.[1] || req?.cookies?.token || null;
}

function createOptionalAuth({
  prismaClient = prisma,
  jwtSecret = process.env.JWT_SECRET,
  validateSession = validateActiveSession,
} = {}) {
  return async function optionalAuthMiddleware(req, _res, next) {
    try {
      const token = extractToken(req);
      if (!token) return next();

      const validated = await validateSession({
        token,
        request: req,
        prismaClient,
        jwtSecret,
      });
      req.user = validated.user;
      req.token = token;
      req.userSession = validated.session;
      return next();
    } catch {
      // Optional authentication deliberately degrades to anonymous, but the
      // centralized validator still revokes expired/compromised/inactive rows.
      return next();
    }
  };
}

const optionalAuth = createOptionalAuth();

module.exports = { optionalAuth, createOptionalAuth, extractToken };