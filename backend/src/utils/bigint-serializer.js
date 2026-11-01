// BigInt serialization utility for JSON responses

/**
 * Custom JSON stringifier that converts BigInt to string
 */
function replaceBigInt(key, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

const AGENT_TASK_STATE_BLOCK_RE = /```agent-task-state\s*\n([\s\S]*?)\n```/g;

function normalizeAgentTaskStateContent(content) {
  if (typeof content !== 'string' || !content.includes('```agent-task-state')) {
    return content;
  }
  return content.replace(AGENT_TASK_STATE_BLOCK_RE, (fullMatch, jsonText) => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fullMatch;
      }
      let changed = false;
      const normalized = { ...parsed };
      for (const field of ['steps', 'artifacts', 'approvals', 'qualityGates', 'repairs']) {
        if (!Array.isArray(normalized[field])) {
          normalized[field] = [];
          changed = true;
        }
      }
      if (!changed) return fullMatch;
      return `\`\`\`agent-task-state\n${JSON.stringify(normalized)}\n\`\`\``;
    } catch {
      return fullMatch;
    }
  });
}

/**
 * Convert BigInt fields to strings in an object recursively
 */
function serializeBigIntFields(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => serializeBigIntFields(item));
  }
  
  if (typeof obj === 'object' && obj.constructor === Object) {
    const serialized = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'bigint') {
        serialized[key] = Number(value); // Convert to number for smaller values
      } else if (typeof value === 'object') {
        serialized[key] = serializeBigIntFields(value);
      } else if (key === 'content' && typeof value === 'string') {
        serialized[key] = normalizeAgentTaskStateContent(value);
      } else {
        serialized[key] = value;
      }
    }
    return serialized;
  }
  
  if (typeof obj === 'bigint') {
    return Number(obj); // Convert to number for smaller values
  }
  
  return obj;
}

/**
 * Safe JSON stringify that handles BigInt
 */
function safeStringify(obj, space = 0) {
  return JSON.stringify(obj, replaceBigInt, space);
}

/**
 * Express middleware to handle BigInt serialization
 */
function bigintSerializerMiddleware(req, res, next) {
  const originalJson = res.json;
  
  res.json = function(obj) {
    const serialized = serializeBigIntFields(obj);
    return originalJson.call(this, serialized);
  };
  
  next();
}

/**
 * Convert user object BigInt fields to numbers
 */
function serializeUser(user) {
  if (!user) return user;
  
  return {
    ...user,
    apiUsage: user.apiUsage ? Number(user.apiUsage) : 0,
    monthlyLimit: user.monthlyLimit ? Number(user.monthlyLimit) : 0,
    monthlyCallLimit: user.monthlyCallLimit ? Number(user.monthlyCallLimit) : 0
  };
}

/**
 * Convert message object BigInt fields to numbers
 */
function serializeMessage(message) {
  if (!message) return message;
  
  return {
    ...message,
    content: typeof message.content === 'string'
      ? normalizeAgentTaskStateContent(message.content)
      : message.content,
    tokens: message.tokens ? Number(message.tokens) : null
  };
}

/**
 * Convert chat with messages BigInt fields to numbers
 */
function serializeChat(chat) {
  if (!chat) return chat;
  
  return {
    ...chat,
    messages: chat.messages ? chat.messages.map(serializeMessage) : [],
    user: chat.user ? serializeUser(chat.user) : chat.user
  };
}

module.exports = {
  replaceBigInt,
  serializeBigIntFields,
  safeStringify,
  bigintSerializerMiddleware,
  serializeUser,
  serializeMessage,
  serializeChat
};