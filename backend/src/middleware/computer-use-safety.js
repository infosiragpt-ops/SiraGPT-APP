const express = require('express');
const router = express.Router();

// Middleware for Computer Use safety checks
const computerUseSafetyCheck = (req, res, next) => {
  const { task } = req.body;
  
  if (!task) {
    return res.status(400).json({
      success: false,
      error: 'Task description is required'
    });
  }
  
  // Check for potentially harmful tasks
  const harmfulKeywords = [
    'delete', 'remove', 'format', 'destroy', 'hack', 'crack', 'password',
    'personal information', 'credit card', 'bank account', 'social security'
  ];
  
  const taskLower = task.toLowerCase();
  const containsHarmfulKeywords = harmfulKeywords.some(keyword => 
    taskLower.includes(keyword)
  );
  
  if (containsHarmfulKeywords) {
    return res.status(403).json({
      success: false,
      error: 'Task contains potentially harmful keywords and cannot be executed',
      safetyViolation: true
    });
  }
  
  // Check task length
  if (task.length > 500) {
    return res.status(400).json({
      success: false,
      error: 'Task description is too long. Please keep it under 500 characters.'
    });
  }
  
  next();
};

// Rate limiting for Computer Use requests
const computerUseRateLimit = {};
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 5;

const computerUseRateLimiter = (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!computerUseRateLimit[clientIp]) {
    computerUseRateLimit[clientIp] = {
      requests: 1,
      windowStart: now
    };
    return next();
  }
  
  const clientData = computerUseRateLimit[clientIp];
  
  // Reset window if expired
  if (now - clientData.windowStart > RATE_LIMIT_WINDOW) {
    clientData.requests = 1;
    clientData.windowStart = now;
    return next();
  }
  
  // Check rate limit
  if (clientData.requests >= MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      success: false,
      error: 'Too many Computer Use requests. Please wait before trying again.',
      retryAfter: Math.ceil((RATE_LIMIT_WINDOW - (now - clientData.windowStart)) / 1000)
    });
  }
  
  clientData.requests++;
  next();
};

// Session timeout management
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

const cleanupExpiredSessions = () => {
  const now = Date.now();
  
  try {
    const { activeSessions } = require('../routes/computer-use');
    
    // Check if activeSessions exists and is a Map
    if (!activeSessions || typeof activeSessions.entries !== 'function') {
      console.log('Active sessions not initialized or not a Map');
      return;
    }
    
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.createdAt && now - session.createdAt > SESSION_TIMEOUT) {
        console.log(`Cleaning up expired session: ${sessionId}`);
        
        // Close browser if it exists
        if (session.browser) {
          session.browser.close().catch(console.error);
        }
        
        activeSessions.delete(sessionId);
      }
    }
  } catch (error) {
    console.log('Error during session cleanup:', error.message);
  }
};

// Clean up expired sessions every 5 minutes. Do not keep node:test or
// short-lived scripts alive solely because this module was required.
const cleanupInterval = setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
cleanupInterval.unref?.();

module.exports = {
  computerUseSafetyCheck,
  computerUseRateLimiter,
  cleanupExpiredSessions
};
