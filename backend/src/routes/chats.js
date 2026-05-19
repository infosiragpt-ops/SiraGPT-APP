const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');
const { serializeChat, serializeBigIntFields } = require('../utils/bigint-serializer');
const streamCache = require('../services/stream-cache');
const { buildChatListWhere, parseBoolean, parsePositiveInt } = require('../services/chat-scope');
const feedbackLedger = require('../services/agents/feedback-ledger');
const rag = require('../services/rag-service');

const router = express.Router();

const projectChatSelect = {
  id: true,
  name: true,
  description: true,
  instructions: true,
  isStarred: true,
  shareId: true,
  createdAt: true,
  updatedAt: true,
  files: {
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      size: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
  },
  documents: {
    select: {
      id: true,
      title: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 30,
  },
  _count: { select: { files: true, chats: true, memories: true, documents: true } },
};

// GET /api/chats/:chatId/pending-stream
// Returns the server-side cached partial content for an in-flight
// stream so the UI can resume after a tab reload / reconnect.
// See services/stream-cache.js for the lifecycle + TTL.
router.get('/:chatId/pending-stream', authenticateToken, async (req, res) => {
  const snapshot = await streamCache.resume(req.user.id, req.params.chatId);
  if (!snapshot) return res.json({ ok: true, pending: null });
  return res.json({ ok: true, pending: snapshot });
});

// Get user's chats
router.get('/', authenticateToken, async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 10000 });
    const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 100 });
    const includeProjects = parseBoolean(req.query.includeProjects);
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const skip = (page - 1) * limit;

    if (projectId) {
      const ownsProject = await prisma.project.findFirst({
        where: { id: projectId, userId: req.user.id },
        select: { id: true },
      });
      if (!ownsProject) return res.status(404).json({ error: 'Project not found' });
    }

    const where = buildChatListWhere({
      userId: req.user.id,
      projectId: projectId || null,
      includeProjects,
      search,
    });

    const [chats, total] = await Promise.all([
      prisma.chat.findMany({
        where,
        include: {
          messages: {
            orderBy: { timestamp: 'asc' },
            take: 1 // Get only the first message for preview
          },
          customGpt: {
            select: {
              id: true,
              name: true,
              description: true,
              iconUrl: true,
              instructions: true,
              greetingMessage: true,
              modelName: true,
              temperature: true,
              conversationStarters: true,
              visibility: true,
              shareId: true,
            }
          },
          project: { select: projectChatSelect },
        },
        skip: parseInt(skip),
        take: parseInt(limit),
        orderBy: { updatedAt: 'desc' }
      }),
      prisma.chat.count({
        where
      })
    ]);

    // Serialize BigInt fields before sending response
    const serializedChats = chats.map(chat => serializeChat(chat));

    res.json({
      chats: serializedChats,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get chats error:', error);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

// Create new chat
router.post('/', [
  body('title').trim().isLength({ min: 1 }).withMessage('Title is required'),
  body('model').trim().isLength({ min: 1 }).withMessage('Model is required')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { title, model, isWordConnectorChat, isExcelConnectorChat, projectId } = req.body;

    // If a projectId is supplied, verify ownership before associating.
    // Silently dropping a bogus id would create chats orphaned from
    // any project the user actually owns; returning 400 forces the
    // client to surface the error.
    if (projectId) {
      const ownsProject = await prisma.project.findFirst({
        where: { id: projectId, userId: req.user.id },
        select: { id: true },
      });
      if (!ownsProject) {
        return res.status(400).json({ error: 'projectId does not belong to the current user' });
      }
    }

    const chat = await prisma.chat.create({
      data: {
        userId: req.user.id,
        title,
        model,
        isWordConnectorChat: isWordConnectorChat || false,
        isExcelConnectorChat: isExcelConnectorChat || false,
        projectId: projectId || null,
      },
      include: {
        messages: true,
        project: { select: projectChatSelect },
      }
    });

    res.status(201).json({ chat });
  } catch (error) {
    console.error('Create chat error:', error);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

// Get specific chat with messages
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    // ETag short-circuit: compute a cheap fingerprint from chat metadata
    // (latest message timestamp + message count) before pulling the full
    // payload. If If-None-Match matches, return 304 immediately.
    try {
      const fingerprintRow = await prisma.chat.findFirst({
        where: { id: req.params.id, userId: req.user.id },
        select: {
          id: true,
          updatedAt: true,
          _count: { select: { messages: true } },
          messages: {
            orderBy: { timestamp: 'desc' },
            take: 1,
            select: { timestamp: true },
          },
        },
      });
      if (fingerprintRow) {
        const latestTs = fingerprintRow.messages[0]?.timestamp
          ? new Date(fingerprintRow.messages[0].timestamp).getTime()
          : new Date(fingerprintRow.updatedAt || 0).getTime();
        const count = fingerprintRow._count?.messages || 0;
        const etag = `W/"chat-${fingerprintRow.id}-${count}-${latestTs}"`;
        res.setHeader('ETag', etag);
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === etag) {
          return res.status(304).end();
        }
      }
    } catch (e) {
      // Fingerprint failure is non-fatal — fall through to full read.
    }

    const chat = await prisma.chat.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' }
        },
        customGpt: {
          select: {
            id: true,
            name: true,
            description: true,
            iconUrl: true,
            instructions: true,
            greetingMessage: true,
            modelName: true,
            temperature: true,
            conversationStarters: true,
            visibility: true,
            shareId: true,
            knowledgeFiles: {
              select: {
                id: true,
                originalName: true,
                extractedText: true,
              }
            }
          }
        },
        project: { select: projectChatSelect },
      }
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Serialize BigInt fields before sending response
    const serializedChat = serializeChat(chat);
    res.json({ chat: serializedChat });
  } catch (error) {
    console.error('Get chat error:', error);
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

// Update chat
router.put('/:id', [
  body('title').optional().trim().isLength({ min: 1 }),
  body('model').optional().trim().isLength({ min: 1 })
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const updateData = {};
    if (req.body.title) updateData.title = req.body.title;
    if (req.body.model) updateData.model = req.body.model;

    const chat = await prisma.chat.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      data: updateData
    });

    if (chat.count === 0) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const updatedChat = await prisma.chat.findUnique({
      where: { id: req.params.id },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' }
        },
        project: { select: projectChatSelect },
      }
    });

    res.json({ chat: updatedChat });
  } catch (error) {
    console.error('Update chat error:', error);
    res.status(500).json({ error: 'Failed to update chat' });
  }
});

// Delete chat
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const deletedChat = await prisma.chat.deleteMany({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (deletedChat.count === 0) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    res.json({ message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Delete chat error:', error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

// Add message to chat
// Mirrors MAX_CHAT_INPUT_CHARS in lib/chat-input-normalize.ts so the
// backend rejects pastes that bypass the frontend cap (curl-direct
// callers, replay attacks, broken clients). 100 k chars ≈ 200 KB at
// UTF-8 worst case, which is well under the Express JSON body limit.
// Override via SIRAGPT_MAX_MESSAGE_CHARS for tenant-specific tuning.
const MAX_MESSAGE_CONTENT_CHARS = (() => {
  const fromEnv = Number(process.env.SIRAGPT_MAX_MESSAGE_CHARS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 100_000;
})();

router.post('/:id/messages', [
  body('role').isIn(['USER', 'ASSISTANT']).withMessage('Invalid role'),
  body('content')
    .trim()
    .isLength({ min: 1 })
    .withMessage('Content is required')
    .isLength({ max: MAX_MESSAGE_CONTENT_CHARS })
    .withMessage(`Content exceeds ${MAX_MESSAGE_CONTENT_CHARS} characters`),
  body('tokens').optional().isInt({ min: 0 }),
  body('files').optional().isArray()
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Verify chat belongs to user
    const chat = await prisma.chat.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const { role, content, tokens, files } = req.body;

    const message = await prisma.message.create({
      data: {
        chatId: req.params.id,
        role,
        content,
        tokens,
        // tools: [{ "type": "image_generation" }],

        files: files || null
      }
    });

    // Update chat's updatedAt timestamp
    await prisma.chat.update({
      where: { id: req.params.id },
      data: { updatedAt: new Date() }
    });

    // Track API usage if it's an assistant message
    if (role === 'ASSISTANT' && tokens) {
      await prisma.apiUsage.create({
        data: {
          userId: req.user.id,
          model: chat.model,
          tokens,
          cost: tokens * 0.001
        }
      });

      // Update user's API usage
      await prisma.user.update({
        where: { id: req.user.id },
        data: {
          apiUsage: {
            increment: tokens
          }
        }
      });
    }

    res.status(201).json({ message });
  } catch (error) {
    console.error('Create message error:', error);
    res.status(500).json({ error: 'Failed to create message' });
  }
});


// const openai = new OpenAI(
//   { apiKey: process.env.OPENAI_API_KEY }
// );

// router.post('/:id/messages', [
//   body('role').isIn(['USER', 'ASSISTANT']).withMessage('Invalid role'),
//   body('content').trim().isLength({ min: 1 }).withMessage('Content is required'),
//   body('tokens').optional().isInt({ min: 0 }),
//   body('files').optional().isArray()
// ], authenticateToken, async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({ errors: errors.array() });
//     }

//     // Check if chat belongs to user
//     const chat = await prisma.chat.findFirst({
//       where: {
//         id: req.params.id,
//         userId: req.user.id
//       }
//     });

//     if (!chat) {
//       return res.status(404).json({ error: 'Chat not found' });
//     }

//     const { role, content, tokens, files } = req.body;
//     let newMessage;

//     if (role === 'USER') {
//       // Save user's original message
//       newMessage = await prisma.message.create({
//         data: {
//           chatId: req.params.id,
//           role,
//           content,
//           tokens: tokens || 0,
//           files: files || null
//         }
//       });

//       // Check if user wants an image
//       const lowerContent = content.toLowerCase();
//       if (lowerContent.includes('image') || lowerContent.includes('photo') || lowerContent.includes('draw')) {
//         // Generate image from OpenAI
//         const imgRes = await openai.images.generate({
//           prompt: content,
//           n: 1,
//           size: '512x512'
//         });
//         const imageUrl = imgRes.data[0].url;

//         // Save assistant image message
//         await prisma.message.create({
//           data: {
//             chatId: req.params.id,
//             role: 'ASSISTANT',
//             content: imageUrl,
//             tokens: 0,
//             tools: [{ type: "image_generation" }]
//           }
//         });
//       } else {
//         // Normal text completion from OpenAI
//         const completion = await openai.chat.completions.create({
//           model: chat.model || 'gpt-4o',
//           messages: await getChatHistoryAsOpenAIMessages(req.params.id)
//         });

//         const replyContent = completion.choices[0].message.content;

//         // Save assistant reply message
//         await prisma.message.create({
//           data: {
//             chatId: req.params.id,
//             role: 'ASSISTANT',
//             content: replyContent,
//             tokens: completion.usage.total_tokens,
//             tools: null
//           }
//         });

//         // Track usage
//         await prisma.apiUsage.create({
//           data: {
//             userId: req.user.id,
//             model: chat.model,
//             tokens: completion.usage.total_tokens,
//             cost: completion.usage.total_tokens * 0.001
//           }
//         });

//         await prisma.user.update({
//           where: { id: req.user.id },
//           data: { apiUsage: { increment: completion.usage.total_tokens } }
//         });
//       }
//     }

//     // Update chat's updatedAt timestamp
//     await prisma.chat.update({
//       where: { id: req.params.id },
//       data: { updatedAt: new Date() }
//     });

//     res.status(201).json({ message: newMessage });
//   } catch (error) {
//     console.error('Create message error:', error);
//     res.status(500).json({ error: 'Failed to create message' });
//   }
// });

async function getChatHistoryAsOpenAIMessages(chatId) {
  const history = await prisma.message.findMany({
    where: { chatId },
    orderBy: { createdAt: 'asc' }
  });
  return history.map(m => ({
    role: m.role === 'USER' ? 'user' : 'assistant',
    content: m.content
  }));
}


// Clear chat messages
router.delete('/:id/messages', authenticateToken, async (req, res) => {
  try {
    // Verify chat belongs to user
    const chat = await prisma.chat.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Delete all messages
    await prisma.message.deleteMany({
      where: { chatId: req.params.id }
    });

    // Update chat
    await prisma.chat.update({
      where: { id: req.params.id },
      data: {
        title: 'New Chat',
        updatedAt: new Date()
      }
    });

    res.json({ message: 'Chat cleared successfully' });
  } catch (error) {
    console.error('Clear chat error:', error);
    res.status(500).json({ error: 'Failed to clear chat' });
  }
});


router.post('/messages/:messageId/feedback', [
  body('feedback').isIn(['liked', 'disliked']).withMessage('Invalid feedback value'),
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { messageId } = req.params;
    const { feedback } = req.body;

    // Primero verificar que el mensaje pertenezca a un chat del usuario
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        chatId: true,
        role: true,
        content: true,
        timestamp: true,
        chat: {
          select: {
            userId: true
          }
        }
      }
    });

    if (!message || message.chat.userId !== req.user.id) {
      return res.status(404).json({ error: 'Message not found or access denied' });
    }

    // Actualizar el feedback
    const updatedMessage = await prisma.message.update({
      where: { id: messageId },
      data: { feedback },
    });

    if (message.role === 'ASSISTANT') {
      setImmediate(async () => {
        try {
          const priorUser = await prisma.message.findFirst({
            where: {
              chatId: message.chatId,
              role: 'USER',
              timestamp: { lt: message.timestamp },
            },
            orderBy: { timestamp: 'desc' },
            select: { content: true },
          });

          await feedbackLedger.record({
            userId: req.user.id,
            runId: message.id,
            agent: 'chat',
            request: priorUser?.content || '',
            response: message.content || updatedMessage.content || '',
            helpful: feedback === 'liked',
            embedder: texts => rag.embed(texts),
          });
        } catch (ledgerErr) {
          console.warn('[chats] feedback ledger update failed:', ledgerErr.message || ledgerErr);
        }
      });
    }

    res.status(200).json({ message: updatedMessage });

  } catch (error) {
    console.error('Add feedback error:', error);
    res.status(500).json({ error: 'Failed to add feedback' });
  }
});

// Clear specifi messages
router.delete('/messages/:messageId/deleteMessage', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    console.log(messageId);

    const userId = req.user.id;
    const message = await prisma.message.findUnique({
      where: {
        id: messageId,
      },
      select: {
        chat: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!message || message.chat.userId !== userId) {
      return res.status(404).json({ error: 'Message not found or access denied.' });
    }

    await prisma.message.delete({
      where: {
        id: messageId,
      },
    });

    res.json({ message: 'Message cleared successfully' });


  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete the message due to a server error.' });
  }
});


router.post('/:chatId/share', authenticateToken, async (req, res) => {
  try {
    const { chatId } = req.params;

    // Verificar que el chat pertenezca al usuario
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId: req.user.id }
    });
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    let shareId = chat.shareId;
    // Si aún no existe un shareId, generar uno nuevo único
    if (!shareId) {
      shareId = uuidv4();
      await prisma.chat.update({
        where: { id: chatId },
        data: {
          isShared: true,
          shareId: shareId
        }
      });
    }

    // Return just the shareId, let frontend construct the full URL
    const shareableLink = shareId;
    res.json({ shareableLink });

  } catch (error) {
    console.error('Share chat error:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// Share individual message with context
router.post('/:chatId/messages/:messageId/share', authenticateToken, async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    console.log('messageId', messageId, chatId);

    // Check if chat belongs to user
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId: req.user.id },
      include: { messages: true }
    });
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Find the message and get its context (user message + assistant response)
    const messageIndex = chat.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const targetMessage = chat.messages[messageIndex];
    let userMessage, assistantMessage;

    if (targetMessage.role === 'ASSISTANT') {
      // If sharing an assistant message, find the preceding user message
      assistantMessage = targetMessage;
      userMessage = messageIndex > 0 ? chat.messages[messageIndex - 1] : null;
    } else if (targetMessage.role === 'USER') {
      // If sharing a user message, find the following assistant message
      userMessage = targetMessage;
      assistantMessage = messageIndex < chat.messages.length - 1 ? chat.messages[messageIndex + 1] : null;
    }

    if (!userMessage || !assistantMessage) {
      return res.status(400).json({ error: 'Cannot share incomplete message pair' });
    }

    // Create or get existing share record for this message
    let messageShare = await prisma.messageShare.findFirst({
      where: { messageId: targetMessage.id }
    });

    if (!messageShare) {
      const shareId = uuidv4();
      messageShare = await prisma.messageShare.create({
        data: {
          id: shareId,
          messageId: targetMessage.id,
          chatId: chatId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          sharedAt: new Date()
        }
      });
    }

    const shareableLink = messageShare.id;
    res.json({ shareableLink });

  } catch (error) {
    console.error('Share message error:', error);
    res.status(500).json({ error: 'Failed to create message share link' });
  }
});



// --- Editar el mensaje de un usuario (versión mejorada) ---
router.put('/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;
    if (!content || content.trim() === "") {
      return res.status(400).json({ error: "Content cannot be empty." });
    }

    // Iniciar una transacción para que todas las operaciones se apliquen atómicamente
    const result = await prisma.$transaction(async (tx) => {
      // Paso 1: Localizar el mensaje y verificar que pertenezca al usuario
      const messageToEdit = await tx.message.findFirst({
        where: {
          id: messageId,
          role: 'USER',
          chat: { userId: req.user.id }
        }
      });

      if (!messageToEdit) {
        // Si el mensaje no existe, lanzar un error para forzar el rollback de la transacción
        throw new Error("Message not found or you can't edit it.");
      }

      // Paso 2: Eliminar todos los mensajes posteriores a éste
      await tx.message.deleteMany({
        where: {
          chatId: messageToEdit.chatId,
          timestamp: {
            gt: messageToEdit.timestamp // 'gt' significa 'greater than' (mayor que)
          }
        }
      });

      // Paso 3: Actualizar el mensaje original con el nuevo contenido
      const updatedMessage = await tx.message.update({
        where: { id: messageId },
        data: { content: content.trim() }
      });

      // Paso 4: Actualizar también el timestamp 'updatedAt' del chat
      await tx.chat.update({
        where: { id: messageToEdit.chatId },
        data: { updatedAt: new Date() }
      });

      return updatedMessage;
    });

    // Si la transacción se completa con éxito, devolver el mensaje actualizado
    res.json({ message: result });

  } catch (error) {
    console.error('Edit message error:', error);
    if (error.message.includes("Message not found")) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// In-memory cache for deduplication (consider using Redis in production)
const saveOperationCache = new Map();

// Save shared content to user's account
router.post('/save-shared', authenticateToken, async (req, res) => {
  try {
    const { shareType, shareData, title } = req.body;
    const userId = req.user.id;

    if (!shareType || !shareData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create a deduplication key based on user, share type, and content hash
    const contentHash = shareType === 'message'
      ? `${shareData.userMessage?.content || ''}${shareData.assistantMessage?.content || ''}`
      : `${shareData.chat?.messages?.map(m => m.content).join('') || ''}`;

    const deduplicationKey = `${userId}-${shareType}-${contentHash.substring(0, 100)}`;

    // Check if this operation was performed recently (within 10 seconds)
    const now = Date.now();
    const recentOperation = saveOperationCache.get(deduplicationKey);

    if (recentOperation && (now - recentOperation.timestamp) < 10000) {
      console.log('Duplicate save operation detected, returning existing result');
      return res.json(recentOperation.result);
    }

    // Create a new chat for the user
    const chatTitle = title || (shareType === 'message' ? 'Shared Message' : 'Shared Conversation');
    const model = shareData.chatModel || shareData.chat?.model || 'gpt-3.5-turbo';

    const newChat = await prisma.chat.create({
      data: {
        userId: userId,
        title: chatTitle,
        model: model,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });

    // Add messages to the chat based on share type
    let messages = [];
    if (shareType === 'message') {
      // For shared messages, add both user and assistant message
      if (shareData.userMessage) {
        const userMsg = await prisma.message.create({
          data: {
            chatId: newChat.id,
            role: shareData.userMessage.role,
            content: shareData.userMessage.content,
            files: shareData.userMessage.files,
            metadata: shareData.userMessage.metadata,
            timestamp: new Date()
          }
        });
        messages.push(userMsg);
      }

      if (shareData.assistantMessage) {
        const assistantMsg = await prisma.message.create({
          data: {
            chatId: newChat.id,
            role: shareData.assistantMessage.role,
            content: shareData.assistantMessage.content,
            files: shareData.assistantMessage.files,
            metadata: shareData.assistantMessage.metadata,
            timestamp: new Date()
          }
        });
        messages.push(assistantMsg);
      }
    } else if (shareType === 'complete' && shareData.chat?.messages) {
      // For complete chat sharing, batch all messages into a single
      // createMany roundtrip (previously this was a N+1 per-message
      // create loop). We preserve original ordering by spacing the
      // timestamps a millisecond apart so the subsequent findUnique
      // include returns them in deterministic order.
      const baseTs = Date.now();
      const rows = shareData.chat.messages.map((msgData, idx) => ({
        chatId: newChat.id,
        role: msgData.role,
        content: msgData.content,
        files: msgData.files,
        metadata: msgData.metadata,
        timestamp: new Date(baseTs + idx),
      }));
      if (rows.length > 0) {
        await prisma.message.createMany({ data: rows });
      }
      messages = rows;
    }

    // Return the new chat with its messages
    const chatWithMessages = await prisma.chat.findUnique({
      where: { id: newChat.id },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    const result = {
      success: true,
      chat: chatWithMessages,
      chatId: newChat.id,
      message: `Shared ${shareType === 'message' ? 'message' : 'conversation'} saved to your account successfully!`
    };

    // Cache the result for deduplication
    saveOperationCache.set(deduplicationKey, {
      timestamp: now,
      result: result
    });

    // Clean up old cache entries (keep only last 100 entries and remove entries older than 1 minute)
    if (saveOperationCache.size > 100) {
      const cutoffTime = now - 60000; // 1 minute ago
      for (const [key, value] of saveOperationCache.entries()) {
        if (value.timestamp < cutoffTime) {
          saveOperationCache.delete(key);
        }
      }
    }

    res.json(result);

  } catch (error) {
    console.error('Save shared content error:', error);
    res.status(500).json({ error: 'Failed to save shared content' });
  }
});

router.put('/:id/word-content', [
  body('content').isString().withMessage('Content must be a string'),
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { content } = req.body;
    const { id } = req.params;

    const chat = await prisma.chat.findFirst({
      where: {
        id: id,
        userId: req.user.id
      }
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const updatedChat = await prisma.chat.update({
      where: { id: id },
      data: { wordContent: content }
    });

    res.json({ message: 'Word content updated successfully', chat: updatedChat });
  } catch (error) {
    console.error('Update word content error:', error);
    res.status(500).json({ error: 'Failed to update word content' });
  }
});

module.exports = router;
