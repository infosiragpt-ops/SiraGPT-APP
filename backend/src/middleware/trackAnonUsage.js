const crypto = require('crypto');
const prisma = require('../config/database');

const ANON_COOKIE = 'anon_id';
const DEFAULT_LIMIT = parseInt(process.env.ANON_FREE_QUERIES || '5', 10);

async function trackAnonUsage(req, res, next) {
  // Skip if authenticated
  if (req.user) return next();

  try {
    const headerAnon = req.get('x-anon-id');
    let anonId = req.cookies?.[ANON_COOKIE] || headerAnon;

    if (!anonId) {
      anonId = crypto.randomUUID();
    }

    // Always (re)set cookie
    res.cookie(ANON_COOKIE, anonId, {
      httpOnly: true,
      sameSite: process.env.CROSS_ORIGIN_ANON ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production' || !!process.env.CROSS_ORIGIN_ANON,
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    let record = await prisma.anonymousUsage.findUnique({ where: { anonId } });
    if (!record) {
      record = await prisma.anonymousUsage.create({
        data: {
          anonId,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'] || null
        }
      });
    }

    if (record.usedQueries >= DEFAULT_LIMIT) {
      return res.status(401).json({
        error: 'Anonymous free query limit reached. Please log in to continue.',
        code: 'ANON_LIMIT_REACHED',
        limit: DEFAULT_LIMIT
      });
    }

    record = await prisma.anonymousUsage.update({
      where: { anonId },
      data: { usedQueries: { increment: 1 } }
    });

    const remaining = Math.max(DEFAULT_LIMIT - record.usedQueries, 0);
    res.setHeader('X-Anon-Limit', DEFAULT_LIMIT);
    res.setHeader('X-Anon-Remaining', remaining);

    req.anonymous = {
      anonId,
      limit: DEFAULT_LIMIT,
      used: record.usedQueries,
      remaining
    };

    return next();
  } catch (e) {
    console.error('trackAnonUsage error:', e);
    return res.status(500).json({ error: 'Anonymous usage tracking failed' });
  }
}

module.exports = { trackAnonUsage };