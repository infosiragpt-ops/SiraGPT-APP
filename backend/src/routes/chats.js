const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const OpenAI = require('openai');


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

    res.json({
      chats,
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

    res.json({ chat });
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
        tools: [{ "type": "image_generation" }],

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

module.exports = router;