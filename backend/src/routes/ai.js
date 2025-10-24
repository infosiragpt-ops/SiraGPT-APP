const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const aiService = require('../services/ai-service');
const OpenAI = require('openai');
const usageService = require("../services/usage-service");
const { optionalAuth } = require('../middleware/optionalAuth');
const { trackAnonUsage } = require('../middleware/trackAnonUsage');
const googleMCPService = require('../services/google-mcp');
const router = express.Router();
const cookie = require('cookie');
const crypto = require('crypto');


// Dependencies ko file ke top par import karen
const fs = require('fs').promises;
const fsSync = require('fs'); // ✅ For synchronous file operations
const path = require('path');

// Initialize OpenAI client
// const openai = new OpenAI({
//   apiKey: process.env.GEMINI_API_KEY,
//   baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",

// });
// // const openai = new OpenAI({
// //   apiKey: process.env.OPENAI_API_KEY
// // });
// ✅ Get available AI models
router.get('/models', async (req, res) => {
  try {
    const { type } = req.query; // Query se 'type' hasil karein (e.g., ?type=TEXT)

    const whereClause = {
      isActive: true,
    };

    if (type && (type === 'TEXT' || type === 'IMAGE')) {
      whereClause.type = type; // Agar type di gai hai to us par filter karein
    }


    const models = await prisma.aiModel.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        displayName: true,
        provider: true,
        description: true,
        type: true, // Type bhi select karein
        icon: true  // Icon bhi select karein
      },
      orderBy: { createdAt: 'asc' }
    });
    res.json({ models });
  } catch (error) {
    console.error('Get AI models error:', error);
    res.status(500).json({ error: 'Failed to fetch AI models' });
  }
});
// ...existing imports...

// Add helper: count ApiUsage records (completed calls) for current calendar month
// Add this helper close to the top with other helpers/imports:
//if want to use api usage for free plan
async function countMonthlyApiCalls(userId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const count = await prisma.apiUsage.count({
    where: {
      userId,
      timestamp: {
        gte: startOfMonth,
        lt: startOfNextMonth
      }
    }
  });
  return count;
}

// ...existing code...
/*
router.post(
  '/generate',
  [
    body('model').trim().notEmpty().withMessage('Model is required'),
    // body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('messages').isArray({ min: 1 }).withMessage('Messages array is required'),

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

      const { model, messages, chatId, files } = req.body;
      const userId = req.user.id;

      const userPrompt = messages[messages.length - 1].content;
      console.log("linints", req.user.apiUsage, req.user.monthlyLimit);

      // Decide karein ki text generate karna hai ya image
      const type = userPrompt.toLowerCase().includes('image') || userPrompt.toLowerCase().includes('photo') ? 'image' : 'text';

      // ✅ Check monthly limit
      if (req.user.apiUsage >= req.user.monthlyLimit) {
        return res.status(429).json({
          error: 'Monthly API limit exceeded',
          usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
        });
      }

      // ✅ Process attached files
      let processedFiles = [];
      if (files && files.length > 0) {
        processedFiles = await Promise.all(
          files.map(async (fileId) => {
            const file = await prisma.file.findFirst({
              where: { id: fileId, userId }
            });
            return file ? {
              id: file.id,
              name: file.originalName,
              extractedText: file.extractedText
            } : null;
          })
        ).then(results => results.filter(Boolean));
      }

      let content, tokens;

      if (type === 'image') {

        //return res.status(400).json({ error: 'Image generation only supported with dall-e-3' });

        content = await aiService.generateImageResponse('ChatGPT', model, userPrompt);
        tokens = 500; // fixed (adjust if needed)
      } else {
        // const fileContext = processedFiles.length > 0
        //   ? '\n\nAttached files:\n' + processedFiles.map(f => `- ${f.name}: ${f.extractedText || '...'}`).join('\n')
        //   : '';
        // content = await aiService.generateResponse('ChatGPT', model, messages + fileContext);
        // tokens = content.length + prompt.length + fileContext.length;
        // CHANGE 3: AI service ko 'prompt' ke bajaye poora 'messages' array bhejein
        const fileContext = processedFiles.length > 0
          ? '\n\nAttached files:\n' + processedFiles.map(f => `- ${f.name}: ${f.extractedText || '...'}`).join('\n')
          : '';

        if (fileContext) {
          messages[messages.length - 1].content += fileContext;
        }
        const completion = await openai.chat.completions.create({
          model: chat.model || 'gpt-4o',
          messages: await getChatHistoryAsOpenAIMessages(req.params.id)
        });

        content = completion.choices[0].message.content;
        //  content = await aiService.generateResponse('ChatGPT', model, messages); // Yahan poora array bhejein
        tokens = content.length + userPrompt.length; // Token calculation update karein
      }

      // ✅ Save messages if chatId provided
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (!chat) {
          return res.status(404).json({ error: 'Chat not found' });
        }

        await prisma.message.create({
          data: {
            chatId,
            role: 'USER',
            content: userPrompt,

            files: processedFiles.length > 0 ? processedFiles : undefined
          }
        });
        console.log("IMAGETEST");

        await prisma.message.create({
          data: { chatId, role: 'ASSISTANT', content, tokens }
        });

        await prisma.chat.update({
          where: { id: chatId },
          data: {
            updatedAt: new Date(),
            title: chat.title === 'New Chat'
              ? userPrompt.slice(0, 50) + (userPrompt.length > 50 ? '...' : '')
              : chat.title
          }
        });
      }

      // ✅ Track usage
      await prisma.apiUsage.create({
        data: { userId, model, tokens, cost: tokens * 0.001 }
      });

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { apiUsage: { increment: tokens } }
      });

      res.json({
        content,
        tokens,
        files: processedFiles,
        usage: { current: updatedUser.apiUsage, limit: updatedUser.monthlyLimit }
      });

    } catch (error) {
      console.error('AI generation error:', error);
      res.status(500).json({ error: error.message || 'AI generation failed' });
    }
  }
);*/
async function saveChatAndTrackUsage(userId, chatId, prompt, fullResponseContent, tokens, model, processedFiles) {
  try {
    console.log("Background task: Saving to database...");


    // ✅ Token calculation with tiktoken
    const promptTokens = usageService.calculateTextTokens(prompt, model);
    const responseTokens = usageService.calculateTextTokens(fullResponseContent, model);
    const totalTokens = promptTokens + responseTokens;

    // ✅ Save messages if chatId provided
    if (chatId) {
      const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
      if (!chat) {
        console.error("Chat not found for background save, skipping.");
        return;
      }

      await prisma.message.create({
        data: {
          chatId,
          role: 'USER',
          content: prompt,
          files: processedFiles.length > 0 ? JSON.stringify(processedFiles) : null
        }
      });

      await prisma.message.create({
        data: { chatId, role: 'ASSISTANT', content: fullResponseContent, tokens }
      });

      await prisma.chat.update({
        where: { id: chatId },
        data: {
          updatedAt: new Date(),
          title: chat.title === 'New Chat'
            ? prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '')
            : chat.title
        }
      });
    }

    // ✅ Track usage
    // await prisma.apiUsage.create({
    //   data: { userId, model, tokens, cost: tokens * 0.001 }
    // });

    // await prisma.user.update({
    //   where: { id: userId },
    //   data: { apiUsage: { increment: tokens } }
    // });
    await usageService.recordUsage(userId, model, totalTokens, totalTokens * 0.001);

    console.log("Background task: Database save complete.");
  } catch (dbError) {
    console.error("Error in background database save:", dbError);
  }
}
const streamControllers = new Map();
router.post(
  '/generate',
  [
    body('model').trim().notEmpty().withMessage('Model is required'),
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('provider').trim().notEmpty().withMessage('Provider is required'),

    body('chatId').optional().isString(),
    body('files').optional().isArray(),
  ],
  authenticateToken,
  async (req, res) => {
    const controller = new AbortController();
    const signal = controller.signal;
    const { streamId } = req.body;

    if (streamId) {
      streamControllers.set(streamId, controller);
      console.log(`Stream registered with ID: ${streamId}`);
    }

    // Agar client connection close karta hai, toh AI generation ko bhi abort karein
    req.on('close', () => {
      console.log(`Client connection closed for chat: ${req.body.chatId}. Aborting AI generation.`);
      controller.abort();
    });
    req.on('aborted', () => {
      console.log(`Client request aborted for chat: ${req.body.chatId}. Aborting AI generation.`);
      controller.abort();
    });

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        controller.abort(); // Agar validation error hai, toh bhi controller ko abort karein
        return res.status(400).json({ errors: errors.array() });
      }

      const { model, prompt, chatId, files, provider } = req.body;
      const isAuth = !!req.user;
      const userId = isAuth ? req.user.id : null;
      const canPersist = isAuth && !!chatId;

      let openai;
      let actualProvider = provider; // ✅ NEW: track actual provider

      if (provider === "Gemini") {
        openai = new OpenAI({
          apiKey: process.env.GEMINI_API_KEY,
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        });
      } else if (provider === "OpenRouter") {
        openai = new OpenAI({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: "https://openrouter.ai/api/v1",
        });
      } else {
        openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });
      }

      // ✅ Check monthly limit
      if (isAuth) {
        if (req.user.plan === 'FREE') {
          const result = await prisma.user.updateMany({
            where: {
              id: userId,
              monthlyCallLimit: { gt: 0 }
            },
            data: {
              monthlyCallLimit: { decrement: 1 }
            }
          });

          if (!result || result.count === 0) {
            return res.status(429).json({
              error: 'Free monthly queries exhausted. Please upgrade to continue.',
              remaining: 0
            });
          }

        } else {
          if (req.user.apiUsage >= req.user.monthlyLimit) {
            return res.status(429).json({
              error: 'Monthly API limit exceeded',
              usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
            });
          }
        }
      }

      // ✅ Process attached files
      let processedFiles = [];
      let openaiFiles = [];
      if (isAuth && files && files.length > 0) {
        processedFiles = await Promise.all(
          files.map(async (fileId) => {

            const file = await prisma.file.findFirst({
              where: { id: fileId.id, userId }
            });
            if (file) {
              if (file.openaiFileId) {
                openaiFiles.push(file.openaiFileId);
              }
              return {
                id: file.id,
                name: file.originalName,
                extractedText: file.extractedText,
                mimeType: file.mimeType,
                openaiFileId: file.openaiFileId,
                path: file.path
              };
            }
            return null;
          })
        ).then(results => results.filter(Boolean));
      }

      // ✅ NEW: Check if chat is associated with a custom GPT
      let customGpt = null;
      let actualModel = model;
      let actualTemperature = 0.7;

      if (canPersist) {
        const chat = await prisma.chat.findUnique({
          where: { id: chatId },
          include: {
            customGpt: {
              include: {
                knowledgeFiles: true
              }
            }
          }
        });

        if (chat && chat.customGpt) {
          customGpt = chat.customGpt;
          actualModel = customGpt.modelName || model;
          actualTemperature = customGpt.temperature || 0.7;

          // ✅ Provider detection logic merged here
          if (actualModel.includes('x-ai/') || actualModel.includes('openrouter/') || actualModel.includes('anthropic/') || actualModel.includes('meta-llama/') || actualModel.includes("deepseek/") ||
            actualModel.includes("meta-llama/") || actualModel.includes("/gpt-oss")
          ) {
            actualProvider = 'OpenRouter';
          } else if (actualModel.includes('gemini') || actualModel.includes('imagen')) {
            actualProvider = 'Gemini';
          } else {
            actualProvider = 'OpenAI';
          }

          console.log(`🤖 Using Custom GPT: ${customGpt.name} with model: ${actualModel} via ${actualProvider}`);
        }
      }

      // ✅ Re-initialize OpenAI client with actualProvider
      if (actualProvider === "Gemini") {
        openai = new OpenAI({
          apiKey: process.env.GEMINI_API_KEY,
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        });
      } else if (actualProvider === "OpenRouter") {
        openai = new OpenAI({
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: "https://openrouter.ai/api/v1",
        });
      } else {
        openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });
      }

      // ✅ Prepare system instruction - Custom GPT or Default
      let systemInstruction;
      if (customGpt) {
        let customSystemPrompt = `You are "${customGpt.name}".\n\n${customGpt.instructions}`;

        if (customGpt.knowledgeFiles && customGpt.knowledgeFiles.length > 0) {
          const knowledgeContext = customGpt.knowledgeFiles
            .map(file => `Knowledge: ${file.originalName}\n${file.extractedText || ''}`)
            .join('\n\n');

          customSystemPrompt += `\n\nKnowledge Base:\n${knowledgeContext}`;
          console.log(`📚 Added knowledge base with ${customGpt.knowledgeFiles.length} files`);
        }

        if (customGpt.conversationStarters && customGpt.conversationStarters.length > 0) {
          customSystemPrompt += `\n\nSuggested conversation topics: ${customGpt.conversationStarters.join(', ')}`;
        }

        systemInstruction = {
          role: 'system',
          content: customSystemPrompt
        };

        console.log(`📝 Custom GPT system prompt length: ${customSystemPrompt.length} characters`);
      } else {
        systemInstruction = {
          role: 'system',
          content: `You are an expert AI assistant.
Writing math formulas:
You have a MathJax render environment.
- Any LaTeX text between single dollar sign ($) will be rendered as a TeX formula;
- Use $(tex_formula)$ in-line delimiters to display equations instead of backslash;
- The render environment only uses $ (single dollarsign) as a container delimiter, never output $$.
Example: $x^2 + 3x$ is output for "x² + 3x" to appear as TeX. You don't need to define who you are act like a simple just example some
say hello so give the answer hello how can i help you`
        };
      }

      // ✅ IMPROVED: Get previous chat history with proper image handling
      let historyMessages = [];
      if (canPersist) {
        historyMessages = await prisma.message.findMany({
          where: { chatId },
          orderBy: { timestamp: 'asc' },
          select: { role: true, content: true, files: true }
        });
      }

      const messages = [systemInstruction];
      if (historyMessages.length) {
        for (const m of historyMessages) {
          const messageRole = m.role === 'USER' ? 'user' : 'assistant';

          // Parse files if present
          let parsedFiles = [];
          if (m.files) {
            try {
              parsedFiles = JSON.parse(m.files);
              if (!Array.isArray(parsedFiles)) {
                parsedFiles = [];
              }
            } catch (e) {
              console.warn("Could not parse files from history message:", e);
              parsedFiles = [];
            }
          }

          // ✅ Check if message contains images
          const imageFiles = parsedFiles.filter(f =>
            f.mimeType && f.mimeType.startsWith('image/') ||
            f.type && f.type.startsWith('image/')
          );

          const nonImageFiles = parsedFiles.filter(f =>
            !(f.mimeType && f.mimeType.startsWith('image/')) &&
            !(f.type && f.type.startsWith('image/'))
          );

          if (imageFiles.length > 0) {
            // ✅ Build content array for messages with images
            const contentArray = [
              { type: 'text', text: m.content }
            ];

            // Add images in proper vision format
            for (const imgFile of imageFiles) {
              try {
                const imagePath = imgFile.path;
                if (imagePath && fsSync.existsSync(imagePath)) {
                  const imageData = fsSync.readFileSync(imagePath);
                  const base64Image = imageData.toString('base64');
                  const mimeType = imgFile.mimeType || imgFile.type || 'image/png';

                  contentArray.push({
                    type: 'image_url',
                    image_url: {
                      url: `data:${mimeType};base64,${base64Image}`,
                      detail: 'high'
                    }
                  });
                  console.log(`📸 Added image from history: ${imgFile.name || 'unknown'}`);
                } else {
                  console.warn(`Image file not found in history: ${imagePath}`);
                }
              } catch (imgError) {
                console.error('Error processing image from history:', imgError);
              }
            }

            // Add text context for non-image files
            if (nonImageFiles.length > 0) {
              const textContext = nonImageFiles.map(f => {
                const content = f.extractedText || 'Binary file - content not available';
                return `\n\nAttached file: ${f.name}\nContent: ${content}`;
              }).join('');

              contentArray[0].text += textContext;
            }

            messages.push({
              role: messageRole,
              content: contentArray
            });
          } else {
            // ✅ Regular text message (no images)
            let messageContent = m.content;

            // Add context for non-image files
            if (nonImageFiles.length > 0) {
              const fileContext = nonImageFiles.map(f => {
                const content = f.extractedText || 'Binary file - content not available';
                return `\n\nAttached file: ${f.name}\nContent: ${content}`;
              }).join('');
              messageContent += fileContext;
            }

            messages.push({
              role: messageRole,
              content: messageContent
            });
          }
        }
      }

      let finalPrompt = prompt;
      if (processedFiles.length > 0) {
        const fileContext = processedFiles.map(f => {
          const content = f.extractedText || 'Binary file - content not available';
          return `File: ${f.name}\nContent: ${content}`;
        }).join('\n\n');

        // finalPrompt = `${prompt}\n\nAttached files:\n${fileContext}`;
        const MAX_CONTEXT_TOKENS = 200000;
        const fileContextTokens = usageService.calculateTextTokens(fileContext, actualModel);

        let truncatedFileContext = fileContext;
        if (fileContextTokens > MAX_CONTEXT_TOKENS) {
          const charPerToken = fileContext.length / fileContextTokens;
          const estimatedCharLimit = Math.floor(MAX_CONTEXT_TOKENS * charPerToken);
          truncatedFileContext = fileContext.substring(0, estimatedCharLimit) + "\n... [CONTENT TRUNCATED DUE TO TOKEN LIMIT] ...";
        }

        finalPrompt = `${prompt}\n\nAttached files:\n${truncatedFileContext}`;
      }


      messages.push({
        role: 'user',
        content: finalPrompt,
        attachments: openaiFiles.map(fileId => ({ file_id: fileId, tools: [{ type: "file_search" }] }))
      });

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let fullResponseContent = '';
      try {
        fullResponseContent = await aiService.generateStream({
          provider: actualProvider, // ✅ updated
          model: actualModel,       // ✅ updated
          messages,
          res,
          signal,
          temperature: actualTemperature,
          files: processedFiles
        });
      } catch (apiError) {
        if (apiError && typeof apiError === 'object' && 'name' in apiError && apiError.name === 'AbortError') {
          console.warn('AI Service stream aborted by client in route, no further content will be sent.');
          // Don't rethrow, just return, as client has already aborted and doesn't expect more data/error
          return;
        }
        console.error('AI Service stream failed in route:', apiError.message);
        throw apiError;
      }

      const tokens = fullResponseContent.length + prompt.length;

      if (isAuth) {
        await saveChatAndTrackUsage(userId, canPersist ? chatId : null, prompt, fullResponseContent, tokens, actualModel, processedFiles);
      }

    } catch (error) {
      console.error('AI generation error:', error);

      // ✅ Check if headers were already sent (streaming started)
      if (!res.headersSent) {
        // Headers not sent yet, safe to send error response
        res.status(500).json({ error: error.message || 'AI generation failed' });
      } else {
        // Headers already sent (streaming started), send error via SSE format
        try {
          res.write(`data: ${JSON.stringify({ error: error.message || 'AI generation failed' })}\n\n`);
        } catch (writeError) {
          console.error('Failed to write error to stream:', writeError);
        }
      }
    }
    finally {
      if (streamId) {
        streamControllers.delete(streamId);
        console.log(`Stream unregistered for ID: ${streamId}`);
      }

      // ✅ Only end response if not already ended
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
);
router.post('/stop-stream', authenticateToken, (req, res) => {
  const { streamId } = req.body;
  if (!streamId) {
    return res.status(400).json({ error: 'streamId is required' });
  }

  // Map se us ID ka controller dhoondein
  const controller = streamControllers.get(streamId);

  if (controller) {
    console.log(`>>> Aborting stream with ID: ${streamId}`);
    controller.abort(); // <-- YEH LINE STREAM KO FORAN ROK DEGI
    streamControllers.delete(streamId); // Usko foran map se hata dein
    res.status(200).json({ message: 'Stop signal sent.' });
  } else {
    console.warn(`Stop request for an unknown or finished stream ID: ${streamId}`);
    res.status(404).json({ message: 'Stream not found or already finished.' });
  }
});

// // ✅ Generate AI image response
router.post(
  '/generate-image-old',
  [
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('chatId').optional().isString(),
    body('provider').trim().notEmpty().withMessage('Provider is required'),
    body('model').trim().notEmpty().withMessage('Model is required'),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }


      const { prompt, chatId, provider, model } = req.body;
      const userId = req.user.id;

      console.log("provider", provider);

      let openai;
      if (provider === "Gemini") {
        openai = new OpenAI({
          apiKey: process.env.GEMINI_API_KEY,
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",

        });

      }
      else {
        openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });
      }

      // ✅ Check monthly limit
      if (req.user.apiUsage >= req.user.monthlyLimit) {
        return res.status(429).json({
          error: 'Monthly API limit exceeded',
          usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
        });
      }

      // Generate image using OpenAI DALL-E with timeout
      let imageUrl, tokens = 1000;
      if (provider === "Gemini") {


        try {
          // Add timeout to prevent hanging
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Image generation timeout')), 50000); // 30 second timeout
          });



          const imagePromise = openai.images.generate({
            model: "imagen-3.0-generate-002",
            prompt: prompt,
            response_format: "b64_json",
            n: 1,
            size: "1024x1024"
          });

          const response = await Promise.race([imagePromise, timeoutPromise]);

          // Convert base64 to file and serve as URL to avoid large data in response
          const base64Data = response.data[0].b64_json;
          const data = {
            ...response.data[0],
            b64_json: "",
          };

          console.log("data for Image", data);

          // Check if base64 data is too large (more than 10MB)
          if (base64Data.length > 10 * 1024 * 1024) {
            throw new Error('Generated image is too large');
          }

          // Save image to file system and return URL
          const fs = require('fs').promises;
          const path = require('path');

          // Create uploads directory if it doesn't exist
          const uploadsDir = path.join(__dirname, '../../uploads/images');
          try {
            await fs.mkdir(uploadsDir, { recursive: true });
          } catch (err) {
            // Directory might already exist
          }

          // Generate unique filename
          const timestamp = Date.now();
          const filename = `generated-${timestamp}-${Math.random().toString(36).substr(2, 9)}.png`;
          const filepath = path.join(uploadsDir, filename);

          // Convert base64 to buffer and save
          const imageBuffer = Buffer.from(base64Data, 'base64');
          await fs.writeFile(filepath, imageBuffer);

          // Return full URL instead of base64 data
          const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
          imageUrl = `${baseUrl}/uploads/images/${filename}`;
          console.log("baseUrl", baseUrl, imageUrl);

          // Optional: Clean up old images (older than 24 hours) to save disk space
          try {
            const files = await fs.readdir(uploadsDir);
            const now = Date.now();
            const oneDayAgo = now - (24 * 60 * 60 * 1000);

            for (const file of files) {
              if (file.startsWith('generated-')) {
                const filePath = path.join(uploadsDir, file);
                const stats = await fs.stat(filePath);
                if (stats.mtime.getTime() < oneDayAgo) {
                  await fs.unlink(filePath);
                  console.log(`Cleaned up old image: ${file}`);
                }
              }
            }
          } catch (cleanupError) {
            console.warn('Image cleanup failed:', cleanupError.message);
          }

          // Validate the image URL
          if (!imageUrl || (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:'))) {
            throw new Error('Invalid image URL received from API');
          }

          console.log('Image generated successfully:', imageUrl.substring(0, 100) + '...');

        } catch (openaiError) {
          console.error('OpenAI Image API error:', openaiError);

          if (openaiError.message === 'Image generation timeout') {
            return res.status(408).json({ error: 'Image generation timed out. Please try again.' });
          }

          return res.status(500).json({
            error: 'Image generation failed. Please try again.',
            details: openaiError.message
          });
        }
      }
      else {
        try {
          const response = await openai.images.generate({
            model: 'dall-e-3',
            prompt: prompt,
            n: 1,
            size: '1024x1024',
            quality: 'standard'
          });

          imageUrl = response.data[0].url;
        } catch (openaiError) {
          console.error('OpenAI Image API error:', openaiError);
          return res.status(500).json({ error: 'Image generation failed. Please check your OpenAI API key.' });
        }
      }

      // ✅ Save messages if chatId provided
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (!chat) {
          return res.status(404).json({ error: 'Chat not found' });
        }

        await prisma.message.create({
          data: {
            chatId,
            role: 'USER',
            content: prompt,
          }
        });

        await prisma.message.create({
          data: {
            chatId,
            role: 'ASSISTANT',
            content: imageUrl, // Store just the image URL
            tokens,
            files: JSON.stringify([{ type: 'image', url: imageUrl, prompt: prompt }])
          }
        });

        await prisma.chat.update({
          where: { id: chatId },
          data: {
            updatedAt: new Date(),
            title: chat.title === 'New Chat'
              ? `Image: ${prompt.slice(0, 30)}${prompt.length > 30 ? '...' : ''}`
              : chat.title
          }
        });
      }

      // ✅ Track usage
      await prisma.apiUsage.create({
        data: { userId, model: 'dall-e-3', tokens, cost: tokens * 0.001 }
      });

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { apiUsage: { increment: tokens } }
      });

      res.json({
        imageUrl,
        tokens,
        usage: { current: updatedUser.apiUsage, limit: updatedUser.monthlyLimit }
      });

    } catch (error) {
      console.error('Image generation error:', error);
      res.status(500).json({ error: error.message || 'Image generation failed' });
    }
  }
);


// Helper function to save a base64 encoded image to the filesystem
async function saveBase64Image(base64Data, userId, prompt) {
  if (!base64Data) {
    throw new Error('No base64 data provided to save.');
  }


  if (base64Data.length > 10 * 1024 * 1024) {
    throw new Error('Generated image is too large');
  }


  const uploadsDir = path.join(__dirname, '../../uploads/images');
  await fs.mkdir(uploadsDir, { recursive: true });


  const timestamp = Date.now();
  const filename = `generated-${timestamp}-${Math.random().toString(36).substr(2, 9)}.png`;
  const filepath = path.join(uploadsDir, filename);


  const imageBuffer = Buffer.from(base64Data, 'base64');
  await fs.writeFile(filepath, imageBuffer);


  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
  const imageUrl = `${baseUrl}/uploads/images/${filename}`;
  // Create a file record in the database
  const newFile = await prisma.file.create({
    data: {
      userId: userId,
      filename: filename,
      originalName: prompt.substring(0, 100), // Use the prompt as the original name
      mimeType: 'image/png',
      size: imageBuffer.length,
      path: filepath,
    },
  });

  console.log("Image saved locally and record created. URL:", imageUrl);
  return { imageUrl, fileId: newFile.id };

}

router.post(
  '/generate-image',
  [
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('chatId').optional().isString(),
    body('provider').trim().notEmpty().withMessage('Provider is required'),
    body('model').trim().notEmpty().withMessage('Model is required'),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      let { prompt, chatId, provider, model, fileId } = req.body;
      const userId = req.user.id;
      console.log('userId', userId);

      let openai;
      if (provider === "Gemini") {
        openai = new OpenAI({
          apiKey: process.env.GEMINI_API_KEY,
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        });
      } else {
        openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });
      }

      if (req.user.apiUsage >= req.user.monthlyLimit) {
        return res.status(429).json({
          error: 'Monthly API limit exceeded',
          usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
        });
      }

      let imagePath;
      // If fileId is not provided, check the last message in the chat for an image
      if (!fileId && chatId) {
        const lastMessage = await prisma.message.findFirst({
          where: {
            chatId: chatId,
            role: 'ASSISTANT',
            files: {
              not: null
            }
          },
          orderBy: {
            timestamp: 'desc'
          }
        });

        if (lastMessage && lastMessage.files) {
          const files = JSON.parse(lastMessage.files);
          const lastImage = files.find(f => f.type === 'image' && f.fileId);
          if (lastImage) {
            fileId = lastImage.fileId;
            console.log(`Found last image in chat with fileId: ${fileId}`);
          }
        }
      }

      let userMessageFiles = undefined;
      if (fileId) {
        const inputFileRecord = await prisma.file.findFirst({
          where: { id: fileId, userId: userId }
        });
        if (inputFileRecord) {
          // ✅ Check if this is a generated image - more precise detection to avoid false positives
          const isGeneratedImage = (
            // Check if filename starts with 'generated-' (our specific pattern)
            inputFileRecord.filename?.startsWith('generated-') ||
            // Check if path contains our specific generated images directory
            (inputFileRecord.path?.includes('/uploads/images/') && inputFileRecord.filename?.startsWith('generated-')) ||
            // Additional check: if file was created via our save function, it will have specific timestamp pattern
            (inputFileRecord.filename?.match(/^generated-\d{13}-[a-z0-9]{9}\.png$/))
          );

          if (isGeneratedImage) {
            console.log('🚫 Detected generated image as fileId - treating as image editing, not user upload');
            imagePath = inputFileRecord.path; // Use for editing but don't attach to user message
          } else {
            // ✅ Construct URL from available data for real user uploads
            const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
            const fileUrl = `${baseUrl}/uploads/${userId}/${inputFileRecord.filename}`;

            userMessageFiles = JSON.stringify([{
              id: inputFileRecord.id,
              name: inputFileRecord.originalName,
              filename: inputFileRecord.filename,
              type: inputFileRecord.mimeType,
              url: fileUrl, // ✅ Construct URL from available data
              path: inputFileRecord.path
            }]);
            console.log('📎 Real user upload file prepared for user message display');
            imagePath = inputFileRecord.path; // Use for editing AND attach to user message
          }
        }
        if (!inputFileRecord) {
          return res.status(404).json({ error: 'Input image file not found.' });
        }
      }

      let response;
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Image generation timeout')), 200000);
      });

      if (imagePath) { // If there's an image to edit
        const imagePromise = aiService.generateImageFromImage(imagePath, prompt, provider);
        response = await Promise.race([imagePromise, timeoutPromise]);
      } else { // If we are generating a new image from a prompt
        if (provider === "Gemini") {
          const imagePromise = openai.images.generate({
            model: "imagen-3.0-generate-002",
            prompt: prompt,
            response_format: "b64_json",
            n: 1,
            size: "1024x1024"
          });
          response = await Promise.race([imagePromise, timeoutPromise]);
        } else {
          const imagePromise = openai.images.generate({
            model: 'dall-e-3',
            prompt: prompt,
            n: 1,
            size: '1024x1024',
            quality: 'standard',
            response_format: 'b64_json',
          });
          response = await Promise.race([imagePromise, timeoutPromise]);
        }
        const { b64_json, ...rest } = response.data[0];

        response = response.data[0].b64_json;

        console.log("📦 Remaining fields in imageData (excluding b64_json):", rest);
      }

      const { imageUrl, fileId: newFileId } = await saveBase64Image(response, userId, prompt);

      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (!chat) {
          return res.status(404).json({ error: 'Chat not found' });
        }

        await prisma.message.create({
          data: {
            chatId,
            role: 'USER',
            content: prompt,
            // Only attach files if they are real user uploads (not generated images)
            files: userMessageFiles
          }
        });

        await prisma.message.create({
          data: {
            chatId,
            role: 'ASSISTANT',
            content: imageUrl,
            tokens: 1000,
            files: JSON.stringify([{ type: 'image', url: imageUrl, prompt: prompt, fileId: newFileId }])
          }
        });

        await prisma.chat.update({
          where: { id: chatId },
          data: {
            updatedAt: new Date(),
            title: chat.title === 'New Chat'
              ? `Image: ${prompt.slice(0, 30)}${prompt.length > 30 ? '...' : ''}`
              : chat.title
          }
        });
      }

      await prisma.apiUsage.create({
        data: { userId, model, tokens: 1000, cost: 1000 * 0.001 }
      });

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { apiUsage: { increment: 1000 } }
      });

      res.json({
        imageUrl,
        tokens: 1000,
        usage: { current: updatedUser.apiUsage, limit: updatedUser.monthlyLimit }
      });

    } catch (error) {
      console.error('Image generation error:', error);
      res.status(500).json({ error: error.message || 'Image generation failed' });
    }
  }
);
// Add this route after the existing generate-image route (around line 580)

// ✅ Generate AI video response (New Video Generation Route)
// Replace the existing video generation route with this corrected version:

// ✅ Generate AI video response (Fixed Version)
router.post(
  '/generate-video',
  [
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('chatId').optional().isString(),
    body('aspect_ratio').optional().isIn(['16:9', '9:16', '1:1']).withMessage('Invalid aspect ratio'),
    body('negative_prompt').optional().isString(),
    body('files').optional().isArray(),
    body('image_url').optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { prompt, chatId, aspect_ratio = '16:9', negative_prompt, files, image_url, model = 'veo-fast' // Default model
      } = req.body;
      const userId = req.user.id;

      console.log('🎬 Video generation request:', { prompt, aspect_ratio, userId, chatId, hasFiles: !!files?.length, hasImageUrl: !!image_url });

      // ✅ Check monthly limit
      if (req.user.apiUsage >= req.user.monthlyLimit) {
        return res.status(429).json({
          error: 'Monthly video generation limit exceeded',
          usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit }
        });
      }

      // ✅ Process attached files (for image-to-video)
      let processedImageUrl = image_url;
      console.log('Initial image URL:', processedImageUrl);
      if (files && files.length > 0 && !processedImageUrl) {
        try {
          // Find the first image file
          const imageFile = await prisma.file.findFirst({
            where: {
              id: { in: files },
              userId,
              mimeType: { startsWith: 'image/' }
            }
          });

          if (imageFile) {
            // Construct the full image URL
            const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
            processedImageUrl = `${baseUrl}/uploads/${userId}/${imageFile.filename}`;
            console.log('🖼️ Using image for video generation:', processedImageUrl);
          }
        } catch (fileError) {
          console.error('Error processing files for video:', fileError);
        }
      }

      // ✅ Make internal API call to video service using axios
      const axios = require('axios');

      try {
        console.log('📡 Calling internal video service...');

        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
        let url = `${baseUrl}/api/video/generate`;

        const videoPayload = {
          prompt,
          aspect_ratio,
          negative_prompt,
          ...(processedImageUrl && { image_url: processedImageUrl }),
          model
        };

        const videoResponse = await axios.post(url, videoPayload, {
          headers: {
            'Authorization': req.headers.authorization,
            'Content-Type': 'application/json'
          },
          timeout: 30000 // 30 second timeout
        });

        console.log('✅ Video service response:', videoResponse.data);

        // ✅ Save user message with complete file information if chatId provided
        if (chatId) {
          const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
          if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
          }

          // ✅ Prepare user message files - handle both files array and direct image_url
          let userMessageFiles = undefined;

          // Case 1: Files uploaded via files array
          if (files && files.length > 0) {
            try {
              const fileRecords = await prisma.file.findMany({
                where: {
                  id: { in: files },
                  userId
                },
                select: {
                  id: true,
                  originalName: true,
                  filename: true,
                  mimeType: true,
                  path: true, // ✅ Use 'path' instead of 'url'
                }
              });

              userMessageFiles = JSON.stringify(fileRecords.map(file => {
                // ✅ Construct URL from available data
                const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
                const fileUrl = `${baseUrl}/uploads/${userId}/${file.filename}`;

                return {
                  id: file.id,
                  name: file.originalName,
                  filename: file.filename,
                  type: file.mimeType,
                  url: fileUrl, // ✅ Construct URL from available data
                  path: file.path
                };
              }));

              console.log('📎 User message files from upload:', fileRecords.length, 'files');
            } catch (fileError) {
              console.error('Error fetching files for user message:', fileError);
            }
          }
          // Case 2: Direct image URL provided (extract from processedImageUrl)
          else if (processedImageUrl) {
            try {
              // Extract filename from URL to find the file record
              const urlParts = processedImageUrl.split('/');
              const filename = urlParts[urlParts.length - 1];

              const fileRecord = await prisma.file.findFirst({
                where: {
                  filename: filename,
                  userId
                },
                select: {
                  id: true,
                  originalName: true,
                  filename: true,
                  mimeType: true,
                  path: true, // ✅ Use 'path' instead of 'url'
                }
              });

              if (fileRecord) {
                // ✅ Construct URL from available data
                const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
                const fileUrl = `${baseUrl}/uploads/${userId}/${fileRecord.filename}`;

                userMessageFiles = JSON.stringify([{
                  id: fileRecord.id,
                  name: fileRecord.originalName,
                  filename: fileRecord.filename,
                  type: fileRecord.mimeType,
                  url: fileUrl, // ✅ Construct URL from available data
                  path: fileRecord.path
                }]);

                console.log('📎 User message file from image_url:', fileRecord.originalName);
              }
            } catch (fileError) {
              console.error('Error fetching file from image_url for user message:', fileError);
            }
          }

          // Save user message with complete file information
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: prompt,
              files: userMessageFiles // ✅ Now includes complete file info for frontend display
            }
          });

          // Save assistant message with video operation data
          const assistantMessage = await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: processedImageUrl ?
                `Generating video from image: "${prompt}"...` :
                `Generating video: "${prompt}"...`,
              tokens: 1000, // Fixed token count for video generation
              // Store video data in files field as JSON
              files: JSON.stringify([{
                type: 'video',
                operationId: videoResponse.data.operationId,
                status: 'processing',
                filename: videoResponse.data.filename,
                prompt: prompt,
                aspect_ratio: aspect_ratio,
                sourceImageUrl: processedImageUrl
              }])
            }
          });

          // Update chat title and timestamp
          await prisma.chat.update({
            where: { id: chatId },
            data: {
              updatedAt: new Date(),
              title: chat.title === 'New Chat'
                ? `Video: ${prompt.slice(0, 30)}${prompt.length > 30 ? '...' : ''}`
                : chat.title
            }
          });

          console.log('💾 Chat updated with video generation request');
        }

        // ✅ Track usage
        const tokens = 1000; // Fixed token count for video generation
        await prisma.apiUsage.create({
          data: { userId, model: processedImageUrl ? 'veo-3.0-img2vid' : 'veo-3.0', tokens, cost: tokens * 0.001 }
        });

        const updatedUser = await prisma.user.update({
          where: { id: userId },
          data: { apiUsage: { increment: tokens } }
        });

        console.log('📊 Usage tracked for video generation');

        res.json({
          operationId: videoResponse.data.operationId,
          filename: videoResponse.data.filename,
          status: 'processing',
          message: processedImageUrl ? 'Image-to-video generation started successfully' : 'Video generation started successfully',
          tokens,
          usage: { current: updatedUser.apiUsage, limit: updatedUser.monthlyLimit },
          sourceImageUrl: processedImageUrl
        });

      } catch (videoServiceError) {
        console.error('❌ Video service error:', videoServiceError.response?.data || videoServiceError.message);

        // Handle specific video service errors
        if (videoServiceError.code === 'ECONNREFUSED') {
          return res.status(503).json({
            error: 'Video generation service is not available. Please try again later.'
          });
        }

        if (videoServiceError.response?.status === 400) {
          return res.status(400).json({
            error: videoServiceError.response.data.error || 'Invalid video generation parameters'
          });
        } else if (videoServiceError.response?.status === 429) {
          return res.status(429).json({
            error: videoServiceError.response.data.error || 'Video generation rate limit exceeded'
          });
        } else {
          return res.status(500).json({
            error: 'Video generation service temporarily unavailable'
          });
        }
      }

    } catch (error) {
      console.error('🚨 Video generation error:', error);
      res.status(500).json({ error: error.message || 'Video generation failed' });
    }
  }
);
// ✅ Check video generation status (Fixed)
router.get('/video-status/:operationId', authenticateToken, async (req, res) => {
  try {
    const { operationId } = req.params;

    console.log('📊 Checking video status for operation:', operationId);

    // ✅ Make internal API call to video service
    const axios = require('axios');
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    let url = `${baseUrl}/api/video/status/${operationId}`;

    try {
      const statusResponse = await axios.get(url, {
        headers: {
          'Authorization': req.headers.authorization
        },
        timeout: 10000 // 10 second timeout
      });

      console.log('✅ Video status response:', statusResponse.data.status);

      // If video is completed, update the message in the database
      // ...inside router.get('/video-status/:operationId', authenticateToken, async (req, res) => { ... })
      // After you parse statusResponse from the internal /api/video/status call:


      // if (statusResponse.data.status === 'completed' && statusResponse.data.filename) {
      //   try {
      //     const { operationId } = req.params;

      //     // Fetch recent assistant messages for this user (no JSON null filter in Prisma)
      //     const candidates = await prisma.message.findMany({
      //       where: {
      //         role: 'ASSISTANT',
      //         chat: { userId: req.user.id }
      //       },
      //       orderBy: { timestamp: 'desc' }, // If your schema uses createdAt, switch to { createdAt: 'desc' }
      //       take: 200,
      //       select: { id: true, content: true, files: true }
      //     });

      //     // Find the message whose files JSON contains this operationId
      //     const target = candidates.find(m => {
      //       try {
      //         const files = typeof m.files === 'string' ? JSON.parse(m.files) : m.files;
      //         return Array.isArray(files) && files.some(f => f && f.operationId === operationId);
      //       } catch {
      //         return false;
      //       }
      //     });

      //     if (target) {
      //       let files = [];
      //       try {
      //         files = typeof target.files === 'string' ? JSON.parse(target.files) : target.files;
      //       } catch {
      //         files = [];
      //       }

      //       // Update the matching video entry in files
      //       const updatedFiles = Array.isArray(files)
      //         ? files.map(f =>
      //             f && f.operationId === operationId
      //               ? { ...f, status: 'completed', filename: statusResponse.data.filename }
      //               : f
      //           )
      //         : files;

      //       await prisma.message.update({
      //         where: { id: target.id },
      //         data: {
      //           content: `Video generated successfully: "${statusResponse.data.prompt || 'Video content'}"`,
      //           files: JSON.stringify(updatedFiles)
      //         }
      //       });
      //       console.log('💾 Message updated with completed video');
      //     }
      //   } catch (dbError) {
      //     console.error('❌ Database update error:', dbError);
      //   }
      // }

      // res.json(statusResponse.data);
      // ...inside router.get('/video-status/:operationId', ...) after a successful statusResponse...

      if (statusResponse.data.status === 'completed' && statusResponse.data.filename) {
        try {
          const { operationId } = req.params;

          const candidates = await prisma.message.findMany({
            where: {
              role: 'ASSISTANT',
              chat: { userId: req.user.id }
            },
            orderBy: { timestamp: 'desc' },
            take: 200,
            select: { id: true, content: true, files: true }
          });

          const target = candidates.find(m => {
            try {
              const files = typeof m.files === 'string' ? JSON.parse(m.files) : m.files;
              return Array.isArray(files) && files.some(f => f && f.operationId === operationId);
            } catch {
              return false;
            }
          });

          if (target) {
            let files = [];
            try {
              files = typeof target.files === 'string' ? JSON.parse(target.files) : target.files;
            } catch {
              files = [];
            }

            const result = statusResponse.data.result || {};
            const finalFilename = statusResponse.data.filename;
            const video_url = result.video_url || `/video/watch/${finalFilename}`;
            const download_url = result.download_url || `/video/download/${finalFilename}`;

            const updatedFiles = Array.isArray(files)
              ? files.map(f =>
                f && f.operationId === operationId
                  ? {
                    ...f,
                    status: 'completed',
                    filename: finalFilename,
                    // enrich with completion metadata
                    video_url,
                    download_url,
                    duration: result.duration || statusResponse.data.duration,
                    file_size: result.file_size,
                    resolution: result.resolution,
                    aspect_ratio: result.aspect_ratio || statusResponse.data.aspect_ratio,
                    fal_video_url: result.fal_video_url,
                    fal_request_id: result.fal_request_id
                  }
                  : f
              )
              : files;

            await prisma.message.update({
              where: { id: target.id },
              data: {
                content: `Video generated successfully: "${statusResponse.data.prompt || 'Video content'}"`,
                files: JSON.stringify(updatedFiles)
              }
            });
            console.log('💾 Message updated with completed video');
          }
        } catch (dbError) {
          console.error('❌ Database update error:', dbError);
        }
      }

      res.json(statusResponse.data);
    } catch (videoServiceError) {
      console.error('❌ Video status service error:', videoServiceError.response?.data || videoServiceError.message);

      if (videoServiceError.code === 'ECONNREFUSED') {
        return res.status(503).json({ error: 'Video status service is not available' });
      }

      if (videoServiceError.response?.status === 404) {
        return res.status(404).json({ error: 'Video operation not found' });
      } else {
        return res.status(500).json({ error: 'Video status service temporarily unavailable' });
      }
    }

  } catch (error) {
    console.error('🚨 Video status check error:', error);
    res.status(500).json({ error: error.message || 'Failed to check video status' });
  }
});
// ADD helper (place above router.post('/generate', or near top)
async function resolveAnonQuota(req, res) {
  const DEFAULT_LIMIT = parseInt(process.env.ANON_FREE_QUERIES || '2', 10);
  const anonCookieName = 'anon_id';

  // Parse cookie header manually (in case cookie-parser not yet applied)
  let cookies = {};
  try {
    if (req.headers.cookie) cookies = cookie.parse(req.headers.cookie);
  } catch { }

  const headerAnon = req.get('x-anon-id');
  let anonId = cookies[anonCookieName] || headerAnon || null;

  if (!anonId) {
    // Not yet created; user hasn’t sent a message
    return { anonId: null, used: 0, remaining: DEFAULT_LIMIT, limit: DEFAULT_LIMIT };
  }

  const record = await prisma.anonymousUsage.findUnique({ where: { anonId } });
  if (!record) {
    return { anonId, used: 0, remaining: DEFAULT_LIMIT, limit: DEFAULT_LIMIT };
  }
  const remaining = Math.max(DEFAULT_LIMIT - record.usedQueries, 0);
  return { anonId, used: record.usedQueries, remaining, limit: DEFAULT_LIMIT };
}

// ADD new route (before module.exports)
router.get('/anon-quota', optionalAuth, async (req, res) => {
  if (req.user) {
    // Authenticated users do not use anon quota
    return res.json({ isAnon: false });
  }
  try {
    const info = await resolveAnonQuota(req, res);
    res.json({
      isAnon: true,
      remaining: info.remaining,
      limit: info.limit,
      used: info.limit - info.remaining
    });
  } catch (e) {
    console.error('Anon quota fetch error:', e);
    res.status(500).json({ error: 'Failed to fetch anonymous quota' });
  }
});

router.post("/createVisualizeChart", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing 'prompt' in request body." });
    }
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    console.log('client', client);

    // 1. Create an assistant with code interpreter
    const assistant = await client.beta.assistants.create({
      name: "Chart Creator",
      instructions: "You create and render data visualizations using matplotlib or seaborn.",
      model: "gpt-4o-mini",
      tools: [{ type: "code_interpreter" }],
    });

    // 2. Create a thread
    const thread = await client.beta.threads.create();
    console.log('thread', thread);

    // 3. Add the user's message
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: prompt,
    });

    // 4. Run the assistant
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: assistant.id,
    });
    console.log('run', run);

    // 5. Poll until the run is complete
    let status;
    do {
      const runData = await client.beta.threads.runs.retrieve(thread.id, run.id);
      status = runData.status;
      console.log("Run status:", status);
      if (status !== "completed") await new Promise(r => setTimeout(r, 1000));
    } while (status !== "completed");
    console.log('status', status);

    // 6. Retrieve messages (chart image)
    const messages = await client.beta.threads.messages.list(thread.id);
    console.log('messages', messages);

    for (const msg of messages.data) {
      for (const content of msg.content) {
        if (content.type === "image_file") {
          const fileId = content.image_file.file_id;
          const imageData = await client.files.content(fileId);

          // Convert to buffer
          const buffer = Buffer.from(await imageData.arrayBuffer());

          // Return image as base64 directly
          return res.json({
            success: true,
            prompt,
            image_base64: buffer.toString("base64"),
          });
        }
      }
    }

    res.status(404).json({ error: "No image generated by the assistant." });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: error.message });
  }
});


// ✅ Generate PowerPoint Presentation
router.post(
  '/generate-ppt',
  [
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('chatId').isString().withMessage('chatId is required'),
    body('provider').optional().isString(),
    body('model').optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { prompt, chatId, provider = 'OpenAI', model = 'gpt-4o' } = req.body;
      const userId = req.user.id;

      console.log('📊 PPT generation request:', { prompt, chatId, provider, model });

      // Check monthly limit
      if (req.user.plan === 'FREE') {
        const result = await prisma.user.updateMany({
          where: {
            id: userId,
            monthlyCallLimit: { gt: 0 }
          },
          data: {
            monthlyCallLimit: { decrement: 1 }
          }
        });

        if (!result || result.count === 0) {
          return res.status(429).json({
            error: 'Free monthly queries exhausted. Please upgrade to continue.',
            remaining: 0
          });
        }
      } else {
        if (req.user.apiUsage >= req.user.monthlyLimit) {
          return res.status(429).json({
            error: 'Monthly API limit exceeded',
            usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
          });
        }
      }

      const chats = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chats || chats.userId !== userId) {
        return res.status(404).json({ error: 'Chat not found or access denied.' });
      }

      // Save user message
      await prisma.message.create({
        data: {
          chatId,
          role: 'USER',
          content: prompt,
        }
      });

      // Generate PPT using AI service
      const pptResult = await aiService.generatePPT(prompt, provider, model);

      // Save assistant message with PPT data
      const assistantMessage = await prisma.message.create({
        data: {
          chatId,
          role: 'ASSISTANT',
          content: `Generated presentation: "${pptResult.structure.title}" with ${pptResult.slideCount} slides`,
          tokens: 1000,
          files: JSON.stringify([{
            type: 'presentation',
            filename: pptResult.filename,
            downloadUrl: pptResult.downloadUrl,
            slideCount: pptResult.slideCount,
            title: pptResult.structure.title,
            structure: pptResult.structure
          }])
        }
      });

      // Update chat title
      const chat = await prisma.chat.findUnique({ where: { id: chatId } });
      if (chat) {
        await prisma.chat.update({
          where: { id: chatId },
          data: {
            updatedAt: new Date(),
            title: chat.title === 'New Chat'
              ? `PPT: ${prompt.slice(0, 30)}${prompt.length > 30 ? '...' : ''}`
              : chat.title
          }
        });
      }

      // Track usage
      const tokens = 1000;
      await usageService.recordUsage(userId, model, tokens, tokens * 0.001);

      console.log('✅ PPT generated and saved successfully');

      res.json({
        message: 'PPT generated successfully',
        filename: pptResult.filename,
        downloadUrl: pptResult.downloadUrl,
        slideCount: pptResult.slideCount,
        structure: pptResult.structure,
        assistantMessage
      });

    } catch (error) {
      console.error('❌ PPT generation error:', error);
      res.status(500).json({ error: error.message || 'PPT generation failed' });
    }
  }
);

// ✅ Generate Gmail AI Response - Natural Language Processing
router.post(
  '/generate-gmail',
  [
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('chatId').optional().isString(),
    body('model').trim().notEmpty().withMessage('Model is required'),
    body('type').optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { prompt, chatId, model, type } = req.body;
      const userId = req.user.id;

      console.log('📧 Gmail AI request:', { prompt, chatId, model, userId });

      // Check monthly limit
      if (req.user.plan === 'FREE') {
        const result = await prisma.user.updateMany({
          where: {
            id: userId,
            monthlyCallLimit: { gt: 0 }
          },
          data: {
            monthlyCallLimit: { decrement: 1 }
          }
        });

        if (!result || result.count === 0) {
          return res.status(429).json({
            error: 'Free monthly queries exhausted. Please upgrade to continue.',
            remaining: 0
          });
        }
      } else {
        if (req.user.apiUsage >= req.user.monthlyLimit) {
          return res.status(429).json({
            error: 'Monthly API limit exceeded',
            usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
          });
        }
      }

      // Check if Gmail is connected
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { gmailTokens: true }
      });

      if (!user?.gmailTokens) {
        // Save user message even if Gmail not connected
        if (chatId) {
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: prompt,
            }
          });

          // Save connection required message
          await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: `📧 **Gmail Connection Required**

I can help you with Gmail tasks like:
- Reading your emails
- Sending emails  
- Searching for specific emails
- Managing your inbox

But first, you need to connect your Gmail account securely using the button below.`,
              metadata: JSON.stringify({
                type: 'gmail_connection_required',
                showConnectionCard: true
              })
            }
          });
        }

        return res.json({
          success: true,
          requiresConnection: true,
          message: 'Gmail connection required'
        });
      }

      // Use AI to process the Gmail request naturally
      const gmailService = require('../services/gmail');
      const { decrypt } = require('../utils/encryption');
      
      // Decrypt and parse Gmail tokens
      let decryptedTokens;
      try {
        decryptedTokens = JSON.parse(decrypt(user.gmailTokens));
      } catch (error) {
        console.error('Error decrypting Gmail tokens:', error);
        return res.status(400).json({
          success: false,
          error: 'Invalid Gmail tokens. Please reconnect Gmail.',
          requiresConnection: true
        });
      }
      
      // Always try to set credentials first, then check if refresh is needed
      gmailService.setCredentials(decryptedTokens);
      
      // Check if tokens are expired and need refresh (Google tokens expire in ~1 hour)
      const isExpired = decryptedTokens.expiresAt && decryptedTokens.expiresAt < Date.now();
      
      if (isExpired) {
        console.log('Gmail tokens expired, attempting refresh...');
        try {
          // Try to refresh the token
          const refreshedTokens = await gmailService.refreshTokens(decryptedTokens);
          if (refreshedTokens) {
            console.log('Token refresh successful');
            // Update user with new tokens
            const { encrypt } = require('../utils/encryption');
            await prisma.user.update({
              where: { id: userId },
              data: { 
                gmailTokens: encrypt(JSON.stringify(refreshedTokens))
              }
            });
            // Set the refreshed credentials
            gmailService.setCredentials(refreshedTokens);
          } else {
            throw new Error('Token refresh failed');
          }
        } catch (refreshError) {
          console.error('Token refresh failed:', refreshError);
          return res.status(401).json({
            success: false,
            error: 'Gmail tokens expired. Please reconnect Gmail.',
            requiresConnection: true
          });
        }
      }

      // Check if tokens have required Gmail scopes
      if (!gmailService.hasRequiredScopes(decryptedTokens)) {
        console.error('Gmail tokens missing required scopes');
        return res.status(403).json({
          success: false,
          error: 'Gmail permissions insufficient. Please reconnect Gmail with full permissions.',
          requiresConnection: true,
          scopeError: true
        });
      }

      // Create AI prompt for Gmail assistance
      const systemPrompt = `You are a Gmail assistant AI. The user has asked: "${prompt}"

Based on their request, determine what Gmail action to take and provide a helpful response.

Available actions:
- Read emails (latest, unread, from specific sender, etc.)
- Send emails (compose and send to recipients)
- Search emails (find emails matching criteria)
- Reply to emails
- Delete emails

Respond naturally and helpfully. If you need to perform Gmail actions, I will handle the technical implementation.`;

      // Initialize OpenAI client for intent classification and parsing only
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });

      // Actually perform Gmail actions based on user request with improved AI analysis
      let gmailResult = null;
      const lowerPrompt = prompt.toLowerCase();

      try {
        // AI-powered action classification for better intent detection
        const actionClassificationPrompt = `Your task is to analyze  the user's real intent** (not just keywords) behind their request.,The input can be in **ANY language**. You must rely on your **multilingual, contextual, and semantic understanding** to identify what the user truly wants, even if they don’t use explicit Gmail-related words
User Request: "${prompt}"


### 🎯 GOAL:
Classify the user's intent into one clear Gmail-related action.  
Base your decision on **meaning**, **context**, and **implied behavior** — not only literal keywords.

---

### 🧠 EXAMPLES OF INTENT UNDERSTANDING
- “show my last mail” → likely means **the last email I sent**, so folder = **SENT**, action = **READ**.  
- “who did I message yesterday” → implies **SENT** folder (user wants sent messages).  
- “what new emails came today” → **INBOX** + **unread_only = true**.  
- “mujhe kal bheje gaye emails dikhao” → means “show emails sent yesterday” → folder = SENT.  
- “enviar correo a Maria” → **SEND** action.  
- “summarize my last 10 messages” → **ANALYZE** action.  
- “search all messages about invoice” → **SEARCH** action.

---

Classify the user's primary goal into one of these categories based on their intent:
1.  **READ**: The user wants to view, check, or get information from their emails.
    (e.g., "show me my last 5 emails", "what's the latest from marketing?", "mujay naye emails dikhao")
2.  **SEND**: The user's core intent is to transmit a message to an email address. This is the most critical action. Identify this intent from verbs like "send", "write", "compose", "mail", "contact", and their equivalents in ANY language (e.g., "bhejo", "baijo", "likho", "envoyer", "enviar"). If an email address is present and the user wants to communicate with them, it is a SEND action.
    (e.g., "send an email to bob@example.com", "write a message to Jane", "hamza ko email bhejo", "mujay hamzabhinder5@gmail.com ko message likhna hai")
3.  **DRAFT**: The user wants to create an email but not send it immediately.
    (e.g., "draft an email to my boss", "prepare a message")
4.  **ANALYZE**: The user wants a report, summary, or analysis of their emails. This is different from just reading.
    (e.g., "give me a report of my email history", "summarize my emails from this week", "reportes de mis histórico de correos")
5.  **SEARCH**: The user wants to find specific emails based on criteria.
    (e.g., "find emails about the project", "search for messages from last week")
6.  **NONE**: The request is not related to any of the above Gmail actions.

Also extract the following details from the request:
-   **number**: How many emails? IMPORTANT rules:
    *   If the user asks for "last email", "latest email", "my last email", "last mail" (singular) -> extract 1
    *   If the user asks for "last 5 emails", "latest 10 emails" (with number) -> extract that number
    *   If the user asks for "emails" (plural) without a number -> extract 10 as default
    *   Keywords indicating singular: "last", "latest", "recent" + singular noun
-   **email_addresses**: Any email addresses mentioned.
-   **keywords**: Any specific search terms.
-   **folder**: Determine the target folder with these rules:
    *   If asking about emails THEY SENT (verbs: "sent", "send kia", "bheje", "enviado", "I sent", "maine bheje", "manay send kia") -> "SENT"
    *   If asking about emails THEY RECEIVED (verbs: "received", "got", "mile", "recibido") -> "INBOX"
    *   For generic requests like "latest emails", "last mail", "check my mail", "new emails", "mujhe emails dikhao" -> **ALWAYS default to "INBOX"**
    *   If in doubt, ALWAYS choose "INBOX"
-   **unread_only**: Set to \`true\` if the user ONLY wants unread emails.
-   **read_only**: Set to \`true\` if the user ONLY wants emails they have already read.
-   **start_date**: If the user specifies a start date, a specific day, or a range (e.g., "today", "yesterday", "on the 15th", "last 20 days"), extract the start date in YYYY-MM-DD format. Current date is ${new Date().toISOString().split('T')[0]}.
-   **end_date**: If the user specifies an end date or a range, extract the end date in YYYY-MM-DD format. For a single day request, end_date can be null.
-   **table_summary**: Set to \`true\` if the user explicitly asks for a table.

Respond ONLY with a valid JSON object in the following format:
{
  "action": "READ|SEND|DRAFT|ANALYZE|SEARCH|NONE",
  "folder": "INBOX|SENT",
  "number": null | <number>,
  "email_addresses": [],
  "keywords": [],
  "unread_only": false,
  "read_only": false,
  "start_date": null | "YYYY-MM-DD",
  "end_date": null | "YYYY-MM-DD",
  "table_summary": false,
  "confidence": 0.0-1.0
}`;

        const classificationResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are an expert at analyzing Gmail requests. Return only valid JSON.' },
            { role: 'user', content: actionClassificationPrompt }
          ],
          temperature: 0.1
        });

        let actionAnalysis;
        try {
          actionAnalysis = JSON.parse(classificationResponse.choices[0].message.content);
        } catch (parseError) {
          console.error('Failed to parse AI action classification:', parseError);
          console.error('AI Response was:', classificationResponse.choices[0].message.content);
          // If AI fails to return valid JSON, fallback to a safe default to show the help message.
          actionAnalysis = { action: 'NONE', confidence: 0.0 };
        }

        console.log('Gmail Action Analysis:', actionAnalysis);

        // Temporarily disable delete functionality for safety
        if (actionAnalysis && actionAnalysis.action === 'DELETE') {
          actionAnalysis.action = 'DELETE_DISABLED';
        }

        // Perform actions based on AI classification
        if (actionAnalysis.action === 'READ' || actionAnalysis.action === 'SEARCH') {
          const maxResults = actionAnalysis.number || 10;
          const unreadOnly = actionAnalysis.unread_only || false;
          const readOnly = actionAnalysis.read_only || false;
          const folder = actionAnalysis.folder || 'INBOX';

          // Build a more sophisticated search query
          let queryParts = [`in:${folder.toLowerCase()}`];
          if (actionAnalysis.keywords && actionAnalysis.keywords.length > 0) {
            queryParts.push(actionAnalysis.keywords.join(' '));
          }
          if (actionAnalysis.email_addresses && actionAnalysis.email_addresses.length > 0) {
            queryParts.push(`from:(${actionAnalysis.email_addresses.join(' OR ')})`);
          }
          if (actionAnalysis.start_date) {
            queryParts.push(`after:${actionAnalysis.start_date}`);
          }
          if (actionAnalysis.end_date) {
            queryParts.push(`before:${actionAnalysis.end_date}`);
          } else if (actionAnalysis.start_date) {
            // If only a start date is provided, limit the search to that day
            const startDate = new Date(actionAnalysis.start_date);
            startDate.setDate(startDate.getDate() + 1);
            const beforeDate = startDate.toISOString().split('T')[0];
            queryParts.push(`before:${beforeDate}`);
          }


          const finalQuery = queryParts.join(' ');
          console.log('Constructed Gmail Search Query:', finalQuery);

          const emails = await gmailService.searchEmails({
            query: finalQuery,
            maxResults: Math.min(maxResults, 50), // Limit to 50 for performance
            unreadOnly,
            readOnly
          });

          gmailResult = {
            action: actionAnalysis.action,
            query: finalQuery,
            emails: emails,
            count: emails.length,
            folder,
            unreadOnly,
            readOnly
          };
        } else if (actionAnalysis.action === 'SEND' || actionAnalysis.action === 'DRAFT') {
          // Extract email components using AI to parse natural language
          const sendPrompt = `You are an email parser. Extract email components from this request and return ONLY a valid JSON object, nothing else.

Request: "${prompt}"

Extract and return ONLY this JSON format (no additional text, no explanation):
{
  "to": "recipient@email.com",
  "subject": "email subject here",
  "body": "detailed email body content here"
}

Rules:
- If recipient email is mentioned, use it exactly
- Create a professional subject line
- Write a detailed, polite, well-formatted email body with proper paragraphs and line breaks
- Use \\n\\n for paragraph breaks to ensure proper formatting
- Structure the email professionally with greeting, main content, and closing
- Keep [Your Name] as placeholder for signature - do not replace it
- Return ONLY the JSON object, no other text`;

          const parseResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: 'You are a JSON email parser. Return only valid JSON, no other text or explanation.'
              },
              {
                role: 'user',
                content: sendPrompt
              }
            ],

          });

          try {
            let responseContent = parseResponse.choices[0].message.content.trim();

            // Clean up the response to ensure it's valid JSON
            if (responseContent.startsWith('```json')) {
              responseContent = responseContent.replace(/```json\n?/, '').replace(/```$/, '');
            }
            if (responseContent.startsWith('```')) {
              responseContent = responseContent.replace(/```\n?/, '').replace(/```$/, '');
            }

            const emailData = JSON.parse(responseContent);

            // Validate that we have required fields
            if (!emailData.to || !emailData.subject || !emailData.body) {
              throw new Error('Missing required email fields');
            }

            // Get user information for proper name replacement
            const currentUser = await prisma.user.findUnique({
              where: { id: userId },
              select: { name: true, email: true }
            });

            // Replace [Your Name] placeholder with actual user name
            if (emailData.body.includes('[Your Name]')) {
              const userName = currentUser?.name || 'User';
              emailData.body = emailData.body.replace(/\[Your Name\]/g, userName);
            }

            // ✅ FIX: Rely on AI classification for draft vs. send
            const isDraft = actionAnalysis.action === 'DRAFT';

            if (isDraft) {
              // Actually save as draft to Gmail
              const draftResult = await gmailService.createDraft(emailData);
              gmailResult = {
                action: 'draft',
                result: draftResult,
                emailData
              };
            } else {
              // Actually send the email
              const sendResult = await gmailService.sendEmail(emailData);
              gmailResult = {
                action: 'send',
                result: sendResult,
                emailData
              };
            }
          } catch (parseError) {
            console.error('Failed to parse email data:', parseError);
            console.error('AI Response was:', parseResponse.choices[0].message.content);

            // Fallback: Extract email manually from the prompt
            const emailMatch = prompt.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
            if (emailMatch) {
              const fallbackEmailData = {
                to: emailMatch[1],
                subject: 'Thank you message',
                body: `Thank you for your recent communication. I appreciate your message and wanted to follow up accordingly.\n\nBest regards`
              };

              try {
                const sendResult = await gmailService.sendEmail(fallbackEmailData);
                gmailResult = {
                  action: 'send',
                  result: sendResult,
                  emailData: fallbackEmailData
                };
              } catch (sendError) {
                gmailResult = {
                  action: 'error',
                  error: `Failed to send email: ${sendError.message}`
                };
              }
            } else {
              gmailResult = {
                action: 'error',
                error: 'Could not parse email recipient from your request. Please include a valid email address.'
              };
            }
          }
        } else if (actionAnalysis.action === 'DELETE_DISABLED') {
          gmailResult = {
            action: 'delete_disabled',
            message: 'Delete functionality is currently disabled. You can search emails or mark them as read instead.'
          };
        } else if (actionAnalysis.action === 'SEARCH') {
        } else if (actionAnalysis.action === 'ANALYZE') {
          console.log('🔬 Handling ANALYZE action');

          // 1. Perform a targeted search first to get relevant emails
          const maxResults = actionAnalysis.number || 50; // Analyze up to 50 relevant emails
          const folder = actionAnalysis.folder || 'INBOX';

          let queryParts = [`in:${folder.toLowerCase()}`];
          if (actionAnalysis.keywords && actionAnalysis.keywords.length > 0) {
            queryParts.push(actionAnalysis.keywords.join(' '));
          }
          if (actionAnalysis.email_addresses && actionAnalysis.email_addresses.length > 0) {
            queryParts.push(`from:(${actionAnalysis.email_addresses.join(' OR ')})`);
          }
          if (actionAnalysis.start_date) {
            queryParts.push(`after:${actionAnalysis.start_date}`);
          }
          if (actionAnalysis.end_date) {
            queryParts.push(`before:${actionAnalysis.end_date}`);
          } else if (actionAnalysis.start_date) {
            const startDate = new Date(actionAnalysis.start_date);
            startDate.setDate(startDate.getDate() + 1);
            const beforeDate = startDate.toISOString().split('T')[0];
            queryParts.push(`before:${beforeDate}`);
          }

          const searchQuery = queryParts.join(' ');
          console.log('Constructed Gmail Search Query for Analysis:', searchQuery);

          const emailsForAnalysis = await gmailService.searchEmails({
            query: searchQuery,
            maxResults: Math.min(maxResults, 100) // Hard limit of 100 for analysis performance
          });

          if (emailsForAnalysis.length === 0) {
            gmailResult = {
              action: 'analyze',
              summary: 'Could not find any emails matching your criteria to analyze.',
              emails: []
            };
          } else {
            // 2. Prepare the content for the analysis prompt
            const emailContentForAI = emailsForAnalysis.map(email => {
              return `From: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\nContent: ${email.body || email.snippet}\n---\n`;
            }).join('\n');

            // 3. Create a new prompt for the AI to generate the report
            const analysisSystemPrompt = `You are an expert data analyst specializing in email history. Your task is to generate a concise report based on the provided email data and the user's request. The user's request might be in any language, so use your multilingual capabilities to understand it.

User's Request: "${prompt}"

Based on this request and the following email data, create a summary or report. The report should be well-structured, easy to read, and directly address the user's query.
- If the user asks for a table, you MUST format the output as a markdown table.
- Use markdown for all formatting (e.g., headings, lists, bold text).
- Be precise and extract specific data points if requested (e.g., bank expenses, dates, amounts).`;

            const analysisUserPrompt = `Here is the email data matching the user's query:\n\n${emailContentForAI}\n\nPlease generate the report based on my original request: "${prompt}"`;

            // 4. Call the AI service to get the summary
            const analysisResponse = await openai.chat.completions.create({
              model: 'gpt-4o', // Use a more powerful model for complex analysis
              messages: [
                { role: 'system', content: analysisSystemPrompt },
                { role: 'user', content: analysisUserPrompt }
              ],
              temperature: 0.3,
            });

            const reportContent = analysisResponse.choices[0].message.content;

            gmailResult = {
              action: 'analyze',
              summary: reportContent,
              emails: emailsForAnalysis
            };
          }
        } else if (lowerPrompt.includes('search') || lowerPrompt.includes('find')) {
          // Extract search query
          const searchQuery = prompt.replace(/search|find|emails?|for|in|gmail/gi, '').trim();
          const emails = await gmailService.searchEmails({
            query: searchQuery,
            maxResults: 10
          });

          gmailResult = {
            action: 'search',
            query: searchQuery,
            emails: emails,
            count: emails.length
          };
        } else if (lowerPrompt.includes('delete')) {
          // Deletion is disabled
          gmailResult = {
            action: 'delete_disabled',
            message: 'Delete functionality is currently disabled. Try: "mark my last 10 emails as read" or "search newsletters".'
          };
        }
      } catch (gmailError) {
        console.error('Gmail action error:', gmailError);

        // ✅ IMPROVED: Handle auth errors gracefully and prompt for re-authentication
        const isAuthError = gmailError.message.includes('No refresh token') ||
          gmailError.message.includes('invalid_grant') ||
          gmailError.message.includes('Token has been expired or revoked');

        if (isAuthError) {
          console.log('Authentication error detected. Clearing user tokens and prompting for reconnect.');

          // Clear the invalid tokens from the database
          await prisma.user.update({
            where: { id: userId },
            data: { gmailTokens: null }
          });

          // Prepare a user-friendly response that triggers the re-connection UI
          gmailResult = {
            action: 'reconnect_required',
            error: 'Your Gmail connection has expired. Please reconnect your account to continue.',
            requiresConnection: true
          };
        } else {
          // Handle other types of Gmail errors
          let errorMessage = gmailError.message;
          if (gmailError.response?.data?.error?.message) {
            errorMessage = gmailError.response.data.error.message;
          }

          gmailResult = {
            action: 'error',
            error: errorMessage,
            errorCode: gmailError.code || gmailError.status,
            errorType: gmailError.code === 403 ? 'permission' : 'unknown'
          };
        }
      }

      // Generate response based on actual Gmail results (skip generic AI response unless no action)
      let finalResponse = '';

      if (gmailResult) {
        switch (gmailResult.action.toLowerCase()) {
          case 'read':
          case 'search':
            const emailType = gmailResult.unreadOnly ? 'Unread' : (gmailResult.readOnly ? 'Read' : 'Latest');
            finalResponse = `📧 **${emailType} Emails (${gmailResult.count})**\n\n`;

            gmailResult.emails.forEach((email, i) => {
              const subject = email.subject || '(No subject)';
              const from = email.from || 'Unknown sender';
              const dt = email.date ? new Date(email.date) : null;
              const dateStr = dt ? `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}` : '';
              const threadLink = email.threadId ? `https://mail.google.com/mail/u/0/#inbox/${email.threadId}` : '';

              // Clean preview
              let content = '';
              if (email.body && email.body.trim()) {
                content = email.body.length > 220 ? email.body.substring(0, 220) + '...' : email.body;
              } else if (email.snippet) {
                content = email.snippet;
              }

              finalResponse += `\n---\n\n`;
              finalResponse += `**${i + 1}. ${subject}**\n`;
              finalResponse += `${from} • ${dateStr}\n`;
              if (content) finalResponse += `${content.replace(/\n/g, ' ')}\n`;
              if (threadLink) finalResponse += `[Open in Gmail](${threadLink})\n`;
            });
            break;

          case 'send':
            if (gmailResult.result && gmailResult.result.success) {
              finalResponse = `✅ **Email Sent Successfully!**\n\n`;
              finalResponse += `**📧 To:** ${gmailResult.emailData.to}\n`;
              finalResponse += `**📝 Subject:** ${gmailResult.emailData.subject}\n\n`;
              finalResponse += `**📄 Email Content:**\n\n`;
              finalResponse += `${gmailResult.emailData.body}\n\n`;
              finalResponse += `---\n`;
              finalResponse += `✅ **Delivered successfully** • Message ID: ${gmailResult.result.messageId || 'Generated'}`;
            } else {
              finalResponse = `❌ **Failed to Send Email**\n\n`;
              finalResponse += `There was an error sending your email. Please check the recipient address and try again.\n`;
              if (gmailResult.result && gmailResult.result.error) {
                finalResponse += `**Error:** ${gmailResult.result.error}`;
              }
            }
            break;

          case 'draft':
            if (gmailResult.result && gmailResult.result.success) {
              finalResponse = `📝 **Draft Saved to Gmail Successfully!**\n\n`;
              finalResponse += `✅ **Saved to your Gmail Drafts folder**\n`;
              finalResponse += `📧 **To:** ${gmailResult.emailData.to}\n`;
              finalResponse += `📝 **Subject:** ${gmailResult.emailData.subject}\n\n`;
              finalResponse += `**📄 Email Content:**\n\n`;
              finalResponse += `${gmailResult.emailData.body}\n\n`;
              finalResponse += `---\n`;
              finalResponse += `💾 **Draft ID:** ${gmailResult.result.draftId}\n`;
              finalResponse += `� **Check your Gmail Drafts folder** to edit or send this email`;
            } else {
              finalResponse = `❌ **Failed to Save Draft**\n\n`;
              finalResponse += `There was an error saving your email as a draft. Please try again.`;
            }
            break;


          case 'analyze':
            finalResponse = `📊 **Email History Report**\n\n`;
            finalResponse += `${gmailResult.summary}`;
            break;

          case 'delete_disabled':
            finalResponse = `🛑 **Delete Disabled**\n\n${gmailResult.message}`;
            break;

          case 'reconnect_required':
            finalResponse = `🔌 **Gmail Re-connection Required**\n\n${gmailResult.error}`;
            break;

          case 'error':
            // Check if this is a Gmail API not enabled error
            if (gmailResult.error.includes('Gmail API has not been used') || gmailResult.error.includes('is disabled')) {
              finalResponse = `🚨 **Gmail API Not Enabled**\n\n` +
                `The Gmail API needs to be enabled in your Google Cloud Console to access your emails.\n\n` +
                `**Steps to fix this:**\n` +
                `1. Visit [Google Cloud Console APIs](https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=58814524073)\n` +
                `2. Click "Enable" on the Gmail API\n` +
                `3. Wait a few minutes for the changes to take effect\n` +
                `4. Try your Gmail request again\n\n` +
                `**Note:** This is a one-time setup step required for Gmail integration.`;
            } else {
              finalResponse = `❌ **Gmail Error**\n\nSorry, there was an error accessing your Gmail: ${gmailResult.error}`;
            }
            break;
        }
      } else {
        // No specific Gmail action detected, but check if this is Gmail-related
        if (lowerPrompt.includes('gmail') || lowerPrompt.includes('email')) {
          finalResponse = `📧 **Gmail Assistant Ready**\n\n`;
          finalResponse += `I can help you with Gmail tasks like:\n\n`;
          finalResponse += `• **📥 Read emails** - \"read my last 5 emails\" or \"show unread emails\"\n`;
          finalResponse += `• **📤 Send emails** - \"send email to john@example.com about meeting\"\n`;
          finalResponse += `• **🔍 Search emails** - \"find emails from my boss\" or \"search for project updates\"\n\n`;
          finalResponse += `What would you like to do with your Gmail?`;
        } else {
          finalResponse = 'How can I help with Gmail?';
        }
      }

      // Save messages to chat
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (!chat) {
          return res.status(404).json({ error: 'Chat not found' });
        }

        await prisma.message.create({
          data: {
            chatId,
            role: 'USER',
            content: prompt,
          }
        });

        // Build UI-friendly files payload for frontend rendering
        let assistantFiles = null;
        let assistantMetadata = null; // ✅ Initialize metadata

        if (gmailResult) {
          // Handle different gmail result actions (case-insensitive)
          const action = gmailResult.action.toLowerCase();

          if (action === 'read' || action === 'search') {
            assistantFiles = JSON.stringify([{
              type: action === 'search' ? 'gmail_search_results' : 'gmail_emails',
              query: gmailResult.query,
              emails: gmailResult.emails,
              count: gmailResult.count,
              filters: gmailResult.filters || { unreadOnly: gmailResult.unreadOnly, readOnly: gmailResult.readOnly }
            }]);
          } else if (action === 'analyze') {
            assistantFiles = JSON.stringify([{
              type: 'gmail_analysis',
              summary: gmailResult.summary,
              sourceEmailCount: gmailResult.emails.length
            }]);
          } else if (gmailResult.action === 'reconnect_required') {
            // ✅ Add metadata to show the connection card on the frontend
            assistantMetadata = JSON.stringify({
              type: 'gmail_connection_required',
              showConnectionCard: true
            });
          }
        }

        await prisma.message.create({
          data: {
            chatId,
            role: 'ASSISTANT',
            content: finalResponse,
            tokens: finalResponse.length,
            files: assistantFiles,
            metadata: assistantMetadata // ✅ Save metadata to the message
          }
        });

        // Update chat title
        await prisma.chat.update({
          where: { id: chatId },
          data: {
            updatedAt: new Date(),
            title: chat.title === 'New Chat'
              ? `📧 Gmail: ${prompt.substring(0, 30)}${prompt.length > 30 ? '...' : ''}`
              : chat.title
          }
        });
      }

      // Track usage
      const tokens = finalResponse.length;
      await usageService.recordUsage(userId, model, tokens, tokens * 0.001);

      res.json({
        success: true,
        content: finalResponse,
        gmailResult,
        tokens
      });

    } catch (error) {
      console.error('Gmail AI generation error:', error);
      res.status(500).json({ error: error.message || 'Gmail AI generation failed' });
    }
  }
);

// ✅ Generate Web Development Code (HTML/CSS/JS) - Now with Streaming
router.post(
  '/generate-webdev',
  [
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('chatId').isString().withMessage('chatId is required'),
    body('provider').optional().isString(),
    body('model').optional().isString(),
    body('files').optional().isArray(),
    body('streamId').optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    const controller = new AbortController();
    const signal = controller.signal;
    const { streamId } = req.body;

    if (streamId) {
      streamControllers.set(streamId, controller);
      console.log(`Web Dev Stream registered with ID: ${streamId}`);
    }

    // Handle client disconnection
    req.on('close', () => {
      console.log(`Client connection closed for web dev chat: ${req.body.chatId}. Aborting generation.`);
      controller.abort();
    });
    req.on('aborted', () => {
      console.log(`Client request aborted for web dev chat: ${req.body.chatId}. Aborting generation.`);
      controller.abort();
    });

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        controller.abort();
        return res.status(400).json({ errors: errors.array() });
      }

      const { prompt, chatId, provider = 'OpenAI', model = 'gpt-4o', files } = req.body;
      const userId = req.user.id;

      console.log('🌐 Web development streaming request:', { prompt, chatId, provider, model, hasFiles: !!files?.length });

      // Check monthly limit
      if (req.user.plan === 'FREE') {
        const result = await prisma.user.updateMany({
          where: {
            id: userId,
            monthlyCallLimit: { gt: 0 }
          },
          data: {
            monthlyCallLimit: { decrement: 1 }
          }
        });

        if (!result || result.count === 0) {
          return res.status(429).json({
            error: 'Free monthly queries exhausted. Please upgrade to continue.',
            remaining: 0
          });
        }
      } else {
        if (req.user.apiUsage >= req.user.monthlyLimit) {
          return res.status(429).json({
            error: 'Monthly API limit exceeded',
            usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
          });
        }
      }

      // Verify chat exists and belongs to user
      const chat = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chat || chat.userId !== userId) {
        return res.status(404).json({ error: 'Chat not found or access denied.' });
      }

      // Process attached files
      let processedFiles = [];
      if (files && files.length > 0) {
        processedFiles = await Promise.all(
          files.map(async (fileId) => {
            const file = await prisma.file.findFirst({
              where: { id: fileId, userId }
            });
            return file ? {
              id: file.id,
              name: file.originalName,
              extractedText: file.extractedText,
              mimeType: file.mimeType,
              path: file.path
            } : null;
          })
        ).then(results => results.filter(Boolean));
      }

      // Prepare web development system message
      const getWebDevSystemMessage = (provider) => {
        const baseContent = `You are an elite UI/UX designer and front-end architect, specializing in creating award-winning, visually stunning websites. Your work rivals the best designs on Dribbble, Behance, and Awwwards. Create websites that are both beautiful and highly functional.

**🚨 CRITICAL SUCCESS REQUIREMENTS:**

**1. SINGLE FILE OUTPUT (MANDATORY):**
- ALWAYS output ONE complete HTML file with ALL code inline
- Never split into separate HTML, CSS, or JS files
- All styles go in <style> tags in the <head>
- All JavaScript goes in <script> tags before </body>
- Zero external dependencies or imports
- Must work perfectly when saved as .html and opened in browser

**2. VISUAL EXCELLENCE (PREMIUM QUALITY):**
- Modern, luxury design aesthetics (Apple, Tesla, Stripe quality)
- Perfect color harmony with professional palettes
- Advanced CSS: gradients, shadows, backdrop-filter, transforms
- Smooth micro-interactions and hover effects
- Premium typography with perfect hierarchy
- Glassmorphism/neumorphism where appropriate
- Subtle animations that enhance UX

**3. CODE ARCHITECTURE:**
- Clean, semantic HTML5 structure
- Modern CSS Grid and Flexbox layouts
- CSS Custom Properties for consistent theming
- Mobile-first responsive design
- Vanilla JavaScript (ES6+) for interactivity
- Optimized for performance and accessibility

**4. DESIGN PATTERNS:**
- Hero sections with compelling visuals
- Perfect spacing and alignment (8px grid system)
- Professional forms with beautiful styling
- Interactive buttons with hover states
- Card-based layouts with subtle shadows
- Consistent visual rhythm and flow
- Use best images for display products

**5. INTERACTIVITY:**
- Smooth scroll behaviors
- Form validation with beautiful feedback
- Interactive navigation elements
- Dynamic content updates
- Responsive mobile menu
- Loading states and transitions

**6. TECHNICAL EXCELLENCE:**
- Fast loading and optimized rendering
- Cross-browser compatibility
- Accessibility (ARIA labels, keyboard navigation)
- SEO-optimized structure
- Progressive enhancement

**🎨 VISUAL INSPIRATION:**
Target the quality of: Apple product pages, Stripe dashboard, Linear design, Vercel landing pages, Figma marketing sites, Notion interfaces.

**💎 QUALITY STANDARD:**
Every element should feel intentionally designed, polished, and premium. The user should be amazed by both visual appeal and smooth functionality. Make it feel like a $50,000 custom website.`;

        // Provider-specific instructions
        if (provider === 'Gemini') {
          return baseContent + `

**📋 GEMINI-SPECIFIC OUTPUT RULES (EXTREMELY IMPORTANT):**
1. You MUST start your response with exactly: \`\`\`html
2. Include complete DOCTYPE and HTML structure immediately after
3. Embed ALL styles in <style> tags within <head>
4. Embed ALL scripts in <script> tags before </body>
5. End your response with exactly: \`\`\`
6. NO explanatory text before the HTML code block
7. NO additional comments outside the code block
8. NO markdown formatting except the required code block delimiters
9. Your entire response should be: \`\`\`html[COMPLETE HTML CODE HERE]\`\`\`

**REMEMBER FOR GEMINI: Start with \`\`\`html and end with \`\`\`. Nothing else!**`;
        } else {
          return baseContent + `

**📋 OUTPUT RULES (EXTREMELY IMPORTANT):**
1. Start response immediately with \`\`\`html
2. Include complete DOCTYPE and HTML structure
3. Embed ALL styles in <style> tags within <head>
4. Embed ALL scripts in <script> tags before </body>
5. End response with \`\`\`
6. NO explanatory text before or after the HTML code block
7. NO additional comments outside the code block
8. Ensure immediate functionality when saved as .html file

**REMEMBER: Only respond with the HTML code block, nothing else!**`;
        }
      };

      const webDevSystemMessage = {
        role: 'system',
        content: getWebDevSystemMessage(provider)
      };

      // Prepare messages array
      const messages = [webDevSystemMessage];

      // Handle images if provided
      if (processedFiles && processedFiles.length > 0) {
        const imageFiles = processedFiles.filter(f => f.mimeType && f.mimeType.startsWith('image/'));

        if (imageFiles.length > 0) {
          console.log(`📸 Processing ${imageFiles.length} image(s) for web dev`);

          // Build content array with text and images
          const contentArray = [
            { type: 'text', text: prompt }
          ];

          // Add all images to the content
          for (const imageFile of imageFiles) {
            const imageContent = await aiService.prepareImageForVision(imageFile.path, imageFile.mimeType);
            if (imageContent) {
              contentArray.push(imageContent);
              console.log(`✅ Added image to web dev request: ${imageFile.name}`);
            }
          }

          messages.push({
            role: 'user',
            content: contentArray
          });
        } else {
          messages.push({
            role: 'user',
            content: prompt
          });
        }
      } else {
        messages.push({
          role: 'user',
          content: prompt
        });
      }

      // Set up streaming headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let fullResponseContent = '';
      try {
        fullResponseContent = await aiService.generateStream({
          provider: provider,
          model: model,
          messages,
          res,
          signal,
          files: processedFiles
        });
      } catch (apiError) {
        if (apiError && typeof apiError === 'object' && 'name' in apiError && apiError.name === 'AbortError') {
          console.warn('Web Dev AI Service stream aborted by client in route.');
          return;
        }
        console.error('Web Dev AI Service stream failed in route:', apiError.message);
        throw apiError;
      }

      const tokens = fullResponseContent.length + prompt.length;

      // Save chat and track usage in background
      if (fullResponseContent.trim()) {
        await saveChatAndTrackUsage(userId, chatId, prompt, fullResponseContent, tokens, model, processedFiles);
      }

    } catch (error) {
      console.error('❌ Web development generation error:', error);

      // Check if headers were already sent (streaming started)
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'Web development generation failed' });
      } else {
        try {
          res.write(`data: ${JSON.stringify({ error: error.message || 'Web development generation failed' })}\n\n`);
        } catch (writeError) {
          console.error('Failed to write error to stream:', writeError);
        }
      }
    } finally {
      if (streamId) {
        streamControllers.delete(streamId);
        console.log(`Web Dev Stream unregistered for ID: ${streamId}`);
      }

      if (!res.writableEnded) {
        res.end();
      }
    }
  }
);

// ✅ Generate Google Calendar & Drive AI Response - Using OpenAI MCP
router.post(
  '/generate-google-services',
  [
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('chatId').optional().isString(),
    body('model').trim().notEmpty().withMessage('Model is required'),
    body('service').optional().isIn(['calendar', 'drive', 'both']).withMessage('Service must be calendar, drive, or both'),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { prompt, chatId, model, timeZone } = req.body;
      let { service } = req.body;
      const userId = req.user.id;

      console.log('📅🗂️ Google Services AI request:', { prompt, chatId, model, service, userId });

      // Check monthly limit
      if (req.user.plan === 'FREE') {
        const result = await prisma.user.updateMany({
          where: {
            id: userId,
            monthlyCallLimit: { gt: 0 }
          },
          data: {
            monthlyCallLimit: { decrement: 1 }
          }
        });

        if (!result || result.count === 0) {
          return res.status(429).json({
            error: 'Free monthly queries exhausted. Please upgrade to continue.',
            remaining: 0
          });
        }
      } else {
        if (req.user.apiUsage >= req.user.monthlyLimit) {
          return res.status(429).json({
            error: 'Monthly API limit exceeded',
            usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit },
          });
        }
      }

      // Check if Google Services is connected
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { googleServicesTokens: true }
      });

      if (!user?.googleServicesTokens) {
        // Save user message even if not connected
        if (chatId) {
          await prisma.message.create({
            data: {
              chatId,
              role: 'USER',
              content: prompt,
            }
          });

          // Save connection required message
          await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: `📅🗂️ **Google Services Connection Required**

I can help you with Google Calendar and Google Drive tasks like:

**Google Calendar:**
- View your upcoming events
- Create new meetings and appointments
- Search your calendar
- Manage event details

**Google Drive:**
- List your files and folders
- Search for documents
- Get file details
- Manage your documents

But first, you need to connect your Google Calendar & Drive account securely using the button below.`,
              metadata: JSON.stringify({
                type: 'google_services_connection_required',
                showConnectionCard: true
              })
            }
          });
        }

        return res.json({
          success: true,
          requiresConnection: true,
          message: 'Google Services connection required'
        });
      }


      const chatHistory = await prisma.message.findMany({
        where: { chatId: chatId, chat: { userId: userId } }, // Security check
        orderBy: { timestamp: 'asc' },
        select: { role: true, content: true }
      });
      chatHistory.push({ role: 'USER', content: prompt });
      // Decrypt and parse Google Services tokens
      const { decrypt } = require('../utils/encryption');
      let decryptedTokens;
      try {
        decryptedTokens = JSON.parse(decrypt(user.googleServicesTokens));
      } catch (error) {
        console.error('Error decrypting Google Services tokens:', error);
        return res.status(400).json({
          success: false,
          error: 'Invalid Google Services tokens. Please reconnect Google Calendar & Drive.',
          requiresConnection: true
        });
      }
      
      // Check if tokens are expired and need refresh
      const isExpired = decryptedTokens.expiresAt && decryptedTokens.expiresAt < Date.now();
      
      if (isExpired && decryptedTokens.refreshToken) {
        console.log('Google Services tokens expired, attempting refresh...');
        try {
          // Try to refresh the token using the Google Services OAuth2 client
          const { OAuth2Client } = require('google-auth-library');
          const oauth2Client = new OAuth2Client(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_CALENDAR_DRIVE_URI
          );
          
          oauth2Client.setCredentials({
            access_token: decryptedTokens.accessToken,
            refresh_token: decryptedTokens.refreshToken
          });
          
          const { credentials } = await oauth2Client.refreshAccessToken();
          
          const refreshedTokens = {
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token || decryptedTokens.refreshToken,
            tokenType: credentials.token_type || 'Bearer',
            scope: decryptedTokens.scope,
            expiresAt: credentials.expiry_date
          };
          
          // Update user with new tokens
          const { encrypt } = require('../utils/encryption');
          await prisma.user.update({
            where: { id: userId },
            data: { 
              googleServicesTokens: encrypt(JSON.stringify(refreshedTokens))
            }
          });
          
          decryptedTokens = refreshedTokens;
          console.log('Google Services token refresh successful');
        } catch (refreshError) {
          console.error('Google Services token refresh failed:', refreshError);
          return res.status(401).json({
            success: false,
            error: 'Google Services tokens expired. Please reconnect Google Calendar & Drive.',
            requiresConnection: true
          });
        }
      }
      
      // Process request using OpenAI MCP
      const mcpResult = await googleMCPService.processRequest(
        chatHistory,
        decryptedTokens,
        timeZone || 'UTC',
        chatId
      );

      let finalResponse = mcpResult.content;

      // ✅ Fallback for when the model fails to generate a response
      if (!finalResponse || finalResponse.trim() === "") {
        finalResponse = "I'm sorry, I encountered an issue while trying to access your Google services. Please try again later.";
      }

      // Save messages to chat
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (!chat) {
          return res.status(404).json({ error: 'Chat not found' });
        }

        await prisma.message.create({
          data: {
            chatId,
            role: 'USER',
            content: prompt,
          }
        });

        // Build UI-friendly metadata for frontend rendering
        let assistantMetadata = JSON.stringify({
          type: 'google_services_response',
          service: service,
          timestamp: new Date().toISOString()
        });

        await prisma.message.create({
          data: {
            chatId,
            role: 'ASSISTANT',
            content: finalResponse,
            tokens: finalResponse.length,
            metadata: assistantMetadata
          }
        });

        // Update chat title
        await prisma.chat.update({
          where: { id: chatId },
          data: {
            updatedAt: new Date(),
            title: chat.title === 'New Chat'
              ? `📅 ${service === 'calendar' ? 'Calendar' : service === 'drive' ? 'Drive' : 'Google'}: ${prompt.substring(0, 30)}${prompt.length > 30 ? '...' : ''}`
              : chat.title
          }
        });
      }

      // Track usage
      const tokens = finalResponse.length;
      await usageService.recordUsage(userId, model, tokens, tokens * 0.001);

      res.json({
        success: true,
        content: finalResponse,

        tokens
      });

    } catch (error) {
      console.error('Google Services AI generation error:', error);

      // Handle re-authentication errors
      const isAuthError = error.message?.includes('reconnect your account') ||
        error.message?.includes('connection has expired');

      if (isAuthError) {
        // Clear invalid tokens
        await prisma.user.update({
          where: { id: req.user.id },
          data: { googleServicesTokens: null }
        });

        return res.json({
          success: true,
          requiresConnection: true,
          message: error.message
        });
      }

      res.status(500).json({ error: error.message || 'Google Services AI generation failed' });
    }
  }
);

router.post(
  '/generate-chart',
  [
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('chatId').isString().withMessage('chatId is required'),
    body('fileId').optional().isString(),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      let { prompt, chatId, fileId } = req.body;
      const userId = req.user.id;

      // If fileId is not provided in the request, try to find one from the recent chat history
      if (!fileId) {
        const lastMessageWithFile = await prisma.message.findFirst({
          where: {
            chatId: chatId,
            role: 'USER',
            files: {
              not: null,
              not: '[]'
            }
          },
          orderBy: {
            timestamp: 'desc'
          }
        });

        if (lastMessageWithFile && lastMessageWithFile.files) {
          try {
            const files = JSON.parse(lastMessageWithFile.files);
            // Find the first file that is not an image, or take any file if that's all there is
            const dataFile = files.find(f => f.type && !f.type.startsWith('image/')) || files[0];
            if (dataFile && dataFile.id) {
              fileId = dataFile.id;
              console.log(`Chart generation: No fileId provided, using file ${fileId} from recent history.`);
            }
          } catch (e) {
            console.error("Chart generation: Error parsing files from history message:", e);
          }
        }
      }

      // Fetch chat history from the database
      const historyMessages = await prisma.message.findMany({
        where: { chatId, chat: { userId } },
        orderBy: { timestamp: 'asc' },
        select: { role: true, content: true }
      });

      // Format messages for the AI service
      const messages = historyMessages.map(m => ({
        role: m.role.toLowerCase(),
        content: m.content
      }));

      // Add the new user prompt, including file content if available
      let finalPrompt = prompt;
      if (fileId) {
        const file = await prisma.file.findFirst({
          where: { id: fileId, userId: userId }
        });

        if (file && file.extractedText) {
          const fileContext = `\n\n--- Attached File Data: ${file.originalName} ---\n${file.extractedText}\n--- End of File Data ---`;
          finalPrompt += fileContext;
          console.log(`Chart generation: Appended content from file ${file.originalName} to the prompt.`);
        } else {
          console.warn(`Chart generation: fileId ${fileId} was provided, but no file or extractedText was found.`);
        }
      }
      messages.push({ role: 'user', content: finalPrompt });

      const { imageUrl, pythonCode, response } = await aiService.generateChartWithCodeInterpreter(messages, fileId);

      // Save user's prompt to the database
      await prisma.message.create({
        data: {
          chatId,
          role: 'USER',
          content: prompt,
        }
      });

      // Determine the content for the assistant's message
      let assistantContent = `Generated chart for: "${prompt}"`;
      if (!imageUrl && response && response.length > 0 && response[0].content && response[0].content.length > 0 && response[0].content[0].text) {
        assistantContent = response[0].content[0].text;
      }

      // Save assistant's response to the database
      const assistantMessage = await prisma.message.create({
        data: {
          chatId,
          role: 'ASSISTANT',
          content: assistantContent,
          files: JSON.stringify([{
            type: 'chart',
            imageUrl: imageUrl,
            pythonCode: pythonCode,
          }])
        }
      });

      res.json({
        message: "Chart generation process completed.",
        imageUrl,
        pythonCode,
        fullResponse: response,
        assistantMessage,
      });

    } catch (error) {
      console.error('Chart generation error:', error);
      res.status(500).json({ error: error.message || 'Chart generation failed' });
    }
  }
);

module.exports = router;
