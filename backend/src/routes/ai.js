const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const aiService = require('../services/ai-service');
const OpenAI = require('openai');

const router = express.Router();

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
    await prisma.apiUsage.create({
      data: { userId, model, tokens, cost: tokens * 0.001 }
    });

    await prisma.user.update({
      where: { id: userId },
      data: { apiUsage: { increment: tokens } }
    });

    console.log("Background task: Database save complete.");
  } catch (dbError) {
    console.error("Error in background database save:", dbError);
  }
}

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
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { model, prompt, chatId, files, provider } = req.body;
      const userId = req.user.id;

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

      // ✅ Process attached files
      let processedFiles = [];
      let openaiFiles = [];
      if (files && files.length > 0) {
        processedFiles = await Promise.all(
          files.map(async (fileId) => {
            const file = await prisma.file.findFirst({
              where: { id: fileId, userId }
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
                openaiFileId: file.openaiFileId
              };
            }
            return null;
          })
        ).then(results => results.filter(Boolean));
      }

      // Prepare messages for OpenAI

      const latexSystemInstruction = {
        role: 'system',
        content: `You are an expert AI assistant.
Writing math formulas:
You have a MathJax render environment.
- Any LaTeX text between single dollar sign ($) will be rendered as a TeX formula;
- Use $(tex_formula)$ in-line delimiters to display equations instead of backslash;
- The render environment only uses $ (single dollarsign) as a container delimiter, never output $$.
Example: $x^2 + 3x$ is output for "x² + 3x" to appear as TeX.`
      };
      // Step 1: get previous chat history from DB
      const history = await prisma.message.findMany({
        where: { chatId },
        orderBy: { timestamp: 'asc' }
      });


      const historyMessages = history.map(m => ({
        role: m.role === 'USER' ? 'user' : 'assistant',
        content: m.content
      }));

      // ✅ NAYI TABDEELI: Step 4 - Final messages array banayein, sab se pehle system message daalein
      const messages = [
        latexSystemInstruction,
        ...historyMessages
      ];

      // Add file context to the user prompt if files are present
      let finalPrompt = prompt;
      if (processedFiles.length > 0) {
        console.log('Processing files for AI:', processedFiles.map(f => ({
          name: f.name,
          hasText: !!f.extractedText,
          textLength: f.extractedText ? f.extractedText.length : 0,
          mimeType: f.mimeType
        })));

        const fileContext = processedFiles.map(f => {
          const content = f.extractedText || 'Binary file - content not available';
          console.log(`File ${f.name}: ${content.substring(0, 100)}...`);
          return `File: ${f.name}\nContent: ${content}`;
        }).join('\n\n');

        finalPrompt = `${prompt}\n\nAttached files:\n${fileContext}`;
        console.log('Final prompt length:', finalPrompt.length);
      }

      // Add user message with file context
      messages.push({
        role: 'user',
        content: finalPrompt
      });
      // console.log("working generates", model, " ", messages);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Call OpenAI API
      let fullResponseContent = '';
      let tokens = 0;
      // console.log("messages", messages);


      try {


        const stream = await openai.chat.completions.create({
          model: model,
          messages: messages,
          stream: true,
          max_tokens: 3000
        });

        content = '';
        // Stream se data parhein aur client ko bhejein
        for await (const chunk of stream) {
          const contentChunk = chunk.choices[0]?.delta?.content || '';
          if (contentChunk) {
            fullResponseContent += contentChunk;
            res.write(`data: ${JSON.stringify({ content: contentChunk })}\n\n`);
          }
        }
        console.log('OpenAI :', await stream,);


        // const finalCompletion = await stream.finalChatCompletion();

        // console.log('OpenAI response completed, tokens:', finalCompletion.usage?.total_tokens);

        tokens = fullResponseContent.length + prompt.length;
        console.log("tokens", tokens);

      } catch (openaiError) {
        console.error('OpenAI API error:', openaiError);
        console.error('Error details:', openaiError.response?.data || openaiError.message);

        // Send error to client
        res.write(`data: ${JSON.stringify({ error: 'AI service temporarily unavailable' })}\n\n`);

        // Fallback to AI service
        const fileContext = processedFiles.length > 0
          ? '\n\nAttached files:\n' + processedFiles.map(f => `- ${f.name}: ${f.extractedText || '...'}`).join('\n')
          : '';
        content = await aiService.generateResponse('ChatGPT', model, prompt + fileContext, chatId);
        tokens = content.length + prompt.length;
      }

      saveChatAndTrackUsage(userId, chatId, prompt, fullResponseContent, tokens, model, processedFiles);


    } catch (error) {
      console.error('AI generation error:', error);
      res.status(500).json({ error: error.message || 'AI generation failed' });
    }
    finally {
      res.end();
    }
  }
);

// // ✅ Generate AI image response
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


      const { prompt, chatId, provider, model } = req.body;
      const userId = req.user.id;
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

      try {
        // Add timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Image generation timeout')), 30000); // 30 second timeout
        });

        const imagePromise = openai.images.generate({
          model: "imagen-3.0-generate-002",
          prompt: prompt,
          response_format: "b64_json", // Gemini only supports b64_json
          n: 1,
          size: "1024x1024" // Limit size to prevent extremely large images
        });

        const response = await Promise.race([imagePromise, timeoutPromise]);
        
        // Convert base64 to file and serve as URL to avoid large data in response
        const base64Data = response.data[0].b64_json;
        
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

module.exports = router;
