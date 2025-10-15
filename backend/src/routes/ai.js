const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const aiService = require('../services/ai-service');
const OpenAI = require('openai');
const usageService = require("../services/usage-service");
const { optionalAuth } = require('../middleware/optionalAuth');
const { trackAnonUsage } = require('../middleware/trackAnonUsage');
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
Example: $x^2 + 3x$ is output for "x² + 3x" to appear as TeX.`
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
        content: finalPrompt
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
        saveChatAndTrackUsage(userId, canPersist ? chatId : null, prompt, fullResponseContent, tokens, actualModel, processedFiles);
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
          // ✅ Construct URL from available data
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
          console.log('📎 Input image file prepared for user message display');
        }
        if (!inputFileRecord) {
          return res.status(404).json({ error: 'Input image file not found.' });
        }
        imagePath = inputFileRecord.path;
      }

      let response;
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Image generation timeout')), 80000);
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
