const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const aiService = require('../services/ai-service'); // Import JS AIService
const router = express.Router();

// Get available models
router.get('/models', async (req, res) => {
  try {
    const models = await prisma.aiModel.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        displayName: true,
        provider: true,
        description: true
      },
      orderBy: { createdAt: 'asc' }
    });

    res.json({ models });
  } catch (error) {
    console.error('Get AI models error:', error);
    res.status(500).json({ error: 'Failed to fetch AI models' });
  }
});

// AI Service Integration
async function generateAIResponse(model, prompt, files = []) {
  // This is where you'd integrate with actual AI services
  // For now, we'll simulate a response

  let fileContext = '';
  if (files && files.length > 0) {
    fileContext = '\n\nAttached files:\n' + files.map(f => `- ${f.name}: ${f.extractedText || 'File content'}`).join('\n');
  }

  const responses = [
    `Hello! I'm ${model}. I understand you're asking about: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}". Here's my response based on my training data.${fileContext}`,
    `That's an interesting question! As ${model}, I can help you with that. Let me provide you with a comprehensive answer.${fileContext}`,
    `Great question! Using ${model}, I can analyze this topic and provide you with detailed insights.${fileContext}`,
    `I'd be happy to help you with that inquiry. Based on my knowledge as ${model}, here's what I can tell you.${fileContext}`,
    `Thank you for your question. As an AI assistant powered by ${model}, I'll do my best to provide you with accurate information.${fileContext}`,
  ];

  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));

  const content = responses[Math.floor(Math.random() * responses.length)];
  const tokens = content.length + prompt.length;

  return { content, tokens };
}

// // Generate AI response
// router.post('/generate', [
//   body('model').trim().isLength({ min: 1 }).withMessage('Model is required'),
//   body('prompt').trim().isLength({ min: 1 }).withMessage('Prompt is required'),
//   body('chatId').optional().isString(),
//   body('files').optional().isArray()
// ], authenticateToken, async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({ errors: errors.array() });
//     }

//     const { model, prompt, chatId, files } = req.body;

//     // Check user's monthly limit
//     if (req.user.apiUsage >= req.user.monthlyLimit) {
//       return res.status(429).json({ 
//         error: 'Monthly API limit exceeded',
//         usage: {
//           current: req.user.apiUsage,
//           limit: req.user.monthlyLimit
//         }
//       });
//     }

//     // Process files if provided
//     let processedFiles = [];
//     if (files && files.length > 0) {
//       for (const fileId of files) {
//         const file = await prisma.file.findFirst({
//           where: {
//             id: fileId,
//             userId: req.user.id
//           }
//         });

//         if (file) {
//           processedFiles.push({
//             id: file.id,
//             name: file.originalName,
//             extractedText: file.extractedText
//           });
//         }
//       }
//     }

//     // Generate AI response
//     const { content, tokens } = await generateAIResponse(model, prompt, processedFiles);

//     // If chatId is provided, save messages to chat
//     if (chatId) {
//       // Verify chat belongs to user
//       const chat = await prisma.chat.findFirst({
//         where: {
//           id: chatId,
//           userId: req.user.id
//         }
//       });

//       if (!chat) {
//         return res.status(404).json({ error: 'Chat not found' });
//       }

//       // Save user message
//       const userMessage = await prisma.message.create({
//         data: {
//           chatId,
//           role: 'USER',
//           content: prompt,
//           files: processedFiles.length > 0 ? processedFiles : null
//         }
//       });

//       // Save assistant message
//       const assistantMessage = await prisma.message.create({
//         data: {
//           chatId,
//           role: 'ASSISTANT',
//           content,
//           tokens
//         }
//       });

//       // Update chat
//       await prisma.chat.update({
//         where: { id: chatId },
//         data: { 
//           updatedAt: new Date(),
//           title: chat.title === 'New Chat' ? prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '') : chat.title,
//         }
//       });
//     }

//     // Track API usage
//     await prisma.apiUsage.create({
//       data: {
//         userId: req.user.id,
//         model,
//         tokens,
//         cost: tokens * 0.001
//       }
//     });

//     // Update user's API usage
//     const updatedUser = await prisma.user.update({
//       where: { id: req.user.id },
//       data: {
//         apiUsage: {
//           increment: tokens
//         }
//       }
//     });

//     res.json({
//       content,
//       tokens,
//       files: processedFiles,
//       usage: {
//         current: updatedUser.apiUsage,
//         limit: updatedUser.monthlyLimit
//       }
//     });
//   } catch (error) {
//     console.error('AI generation error:', error);
//     res.status(500).json({ error: 'AI generation failed' });
//   }
// });

// Generate AI response (text or image)
router.post(
  '/generate',
  [
    body('model').trim().isLength({ min: 1 }).withMessage('Model is required'),
    body('prompt').trim().isLength({ min: 1 }).withMessage('Prompt is required'),
    body('chatId').optional().isString(),
    body('files').optional().isArray(),
    body('type').optional().isIn(['text', 'image']).withMessage('Type must be text or image'),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { model, prompt, chatId, files, type = 'text' } = req.body;
      const userId = req.user.id;

      // Check user's monthly limit
      if (req.user.apiUsage >= req.user.monthlyLimit) {
        return res.status(429).json({
          error: 'Monthly API limit exceeded',
          usage: {
            current: req.user.apiUsage,
            limit: req.user.monthlyLimit,
          },
        });
      }

      // Process files if provided
      let processedFiles = [];
      if (files && files.length > 0) {
        for (const fileId of files) {
          const file = await prisma.file.findFirst({
            where: {
              id: fileId,
              userId,
            },
          });
          if (file) {
            processedFiles.push({
              id: file.id,
              name: file.originalName,
              extractedText: file.extractedText,
            });
          }
        }
      }

      let content, tokens;
      if (type === 'image') {

        // Image generation
        if (model !== 'dall-e-3') {
          return res.status(400).json({ error: 'Image generation only supported with dall-e-3' });
        }
        content = await aiService.generateImageResponse('ChatGPT', model, prompt);
        tokens = 1000; // Fixed token count for image generation (adjust as needed)
      } else {
        // Text generation
        const fileContext = processedFiles.length > 0
          ? '\n\nAttached files:\n' + processedFiles.map(f => `- ${f.name}: ${f.extractedText || 'File content'}`).join('\n')
          : '';
        content = await aiService.generateResponse('ChatGPT', model, prompt + fileContext);
        tokens = content.length + prompt.length + fileContext.length;
      }

      // Save messages to chat if chatId provided
      if (chatId) {
        const chat = await prisma.chat.findFirst({
          where: {
            id: chatId,
            userId,
          },
        });

        if (!chat) {
          return res.status(404).json({ error: 'Chat not found' });
        }

        // Save user message
        await prisma.message.create({
          data: {
            chatId,
            role: 'USER',
            content: prompt,
            files: processedFiles.length > 0 ? processedFiles : null,
          },
        });

        // Save assistant message
        await prisma.message.create({
          data: {
            chatId,
            role: 'ASSISTANT',
            content,
            tokens,
          },
        });

        // Update chat title
        await prisma.chat.update({
          where: { id: chatId },
          data: {
            updatedAt: new Date(),
            title: chat.title === 'New Chat' ? prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '') : chat.title,
          },
        });
      }

      // Track API usage
      await prisma.apiUsage.create({
        data: {
          userId,
          model,
          tokens,
          cost: tokens * 0.001, // Adjust cost calculation as needed
        },
      });

      // Update user's API usage
      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          apiUsage: {
            increment: tokens,
          },
        },
      });

      res.json({
        content,
        tokens,
        files: processedFiles,
        usage: {
          current: updatedUser.apiUsage,
          limit: updatedUser.monthlyLimit,
        },
      });
    } catch (error) {
      console.error('AI generation error:', error);
      res.status(500).json({ error: error.message || 'AI generation failed' });
    }
  }
);

// Get available models
router.get('/models', (req, res) => {
  const models = [
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      description: 'GPT-4 & GPT-3.5 Turbo',
      provider: 'OpenAI',
      available: true
    },
    {
      id: 'claude',
      name: 'Claude',
      description: 'Claude 3 Opus & Sonnet',
      provider: 'Anthropic',
      available: true
    },
    {
      id: 'grok',
      name: 'Grok',
      description: 'xAI Grok-2',
      provider: 'xAI',
      available: true
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      description: 'DeepSeek AI',
      provider: 'DeepSeek',
      available: true
    },
    {
      id: 'gemini',
      name: 'Gemini',
      description: 'Google Gemini Pro',
      provider: 'Google',
      available: true
    }
  ];

  res.json({ models });
});

module.exports = router;