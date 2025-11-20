const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');
const { serializeChat, serializeBigIntFields } = require('../utils/bigint-serializer');

const router = express.Router();

// Get user's chats
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    const [chats, total] = await Promise.all([
      prisma.chat.findMany({
        where: { userId: req.user.id },
        include: {
          messages: {
            orderBy: { timestamp: 'asc' },
            take: 1 // Get only the first message for preview
          }
        },
        skip: parseInt(skip),
        take: parseInt(limit),
        orderBy: { updatedAt: 'desc' }
      }),
      prisma.chat.count({
        where: { userId: req.user.id }
      })
    ]);

    // Serialize BigInt fields before sending response
    const serializedChats = chats.map(chat => serializeChat(chat));
    
    res.json({
      chats: serializedChats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
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

    const { title, model } = req.body;

    const chat = await prisma.chat.create({
      data: {
        userId: req.user.id,
        title,
        model
      },
      include: {
        messages: true
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
    const chat = await prisma.chat.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      include: {
        messages: {
          orderBy: { timestamp: 'asc' }
        }
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
        }
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
router.post('/:id/messages', [
  body('role').isIn(['USER', 'ASSISTANT']).withMessage('Invalid role'),
  body('content').trim().isLength({ min: 1 }).withMessage('Content is required'),
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

    // Pehle verify karein ke message user ke chat ka hissa hai
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
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

    // Ab feedback update karein
    const updatedMessage = await prisma.message.update({
      where: { id: messageId },
      data: { feedback },
    });

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

    // Check karein ke chat user ka hai
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId: req.user.id }
    });
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    let shareId = chat.shareId;
    // Agar pehle se share nahi hai, to ek naya unique ID banayein
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



// --- Edit a User's Message (Naya aur Behtar Version) ---
router.put('/messages/:messageId', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;
    if (!content || content.trim() === "") {
      return res.status(400).json({ error: "Content cannot be empty." });
    }

    // Transaction shuru karein taake saare operations ek saath hon ya koi na ho
    const result = await prisma.$transaction(async (tx) => {
      // Step 1: Message dhoondein aur verify karein ke user ka hai
      const messageToEdit = await tx.message.findFirst({
        where: {
          id: messageId,
          role: 'USER',
          chat: { userId: req.user.id }
        }
      });

      if (!messageToEdit) {
        // Agar message nahi milta to transaction ko rollback karne ke liye error throw karein
        throw new Error("Message not found or you can't edit it.");
      }

      // Step 2: Is message ke baad wale saare messages ko delete karein
      await tx.message.deleteMany({
        where: {
          chatId: messageToEdit.chatId,
          timestamp: {
            gt: messageToEdit.timestamp // 'gt' matlab 'greater than'
          }
        }
      });

      // Step 3: Original message ko naye content se update karein
      const updatedMessage = await tx.message.update({
        where: { id: messageId },
        data: { content: content.trim() }
      });

      // Step 4: Chat ka 'updatedAt' timestamp bhi update karein
      await tx.chat.update({
        where: { id: messageToEdit.chatId },
        data: { updatedAt: new Date() }
      });

      return updatedMessage;
    });

    // Transaction kamyab hone par naya message wapas bhejein
    res.json({ message: result });

  } catch (error) {
    console.error('Edit message error:', error);
    if (error.message.includes("Message not found")) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// Save shared content to user's account
router.post('/save-shared', authenticateToken, async (req, res) => {
  try {
    const { shareType, shareData, title } = req.body;
    const userId = req.user.id;

    if (!shareType || !shareData) {
      return res.status(400).json({ error: 'Missing required fields' });
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
      // For complete chat sharing, add all messages
      for (const msgData of shareData.chat.messages) {
        const message = await prisma.message.create({
          data: {
            chatId: newChat.id,
            role: msgData.role,
            content: msgData.content,
            files: msgData.files,
            metadata: msgData.metadata,
            timestamp: new Date()
          }
        });
        messages.push(message);
      }
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

    res.json({
      success: true,
      chat: chatWithMessages,
      chatId: newChat.id,
      message: `Shared ${shareType === 'message' ? 'message' : 'conversation'} saved to your account successfully!`
    });

  } catch (error) {
    console.error('Save shared content error:', error);
    res.status(500).json({ error: 'Failed to save shared content' });
  }
});

module.exports = router;