const jwt = require('jsonwebtoken');
const prisma = require('../config/database');

async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.cookies?.token;
    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const session = await prisma.session.findUnique({
      where: { token },
      include: { user: true }
    });

    if (!session || session.expiresAt < new Date()) {
      if (session) await prisma.session.delete({ where: { id: session.id } });
      return next(); // Treat as anonymous silently
    }

    req.user = session.user;
    req.token = token;
    return next();
  } catch {
    // Ignore errors; proceed as anonymous
    return next();
  }
}

module.exports = { optionalAuth };