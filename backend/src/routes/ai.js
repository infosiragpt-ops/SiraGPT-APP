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
            setTimeout(() => reject(new Error('Image generation timeout')), 30000); // 30 second timeout
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
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { prompt, chatId, aspect_ratio = '16:9', negative_prompt } = req.body;
      const userId = req.user.id;

      console.log('🎬 Video generation request:', { prompt, aspect_ratio, userId, chatId });

      // ✅ Check monthly limit
      if (req.user.apiUsage >= req.user.monthlyLimit) {
        return res.status(429).json({
          error: 'Monthly video generation limit exceeded',
          usage: { current: req.user.apiUsage, limit: req.user.monthlyLimit }
        });
      }

      // ✅ Make internal API call to video service using axios
      const axios = require('axios');

      try {
        console.log('📡 Calling internal video service...');

        // Make call to the video generation service
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
        let video_url = `${baseUrl}/api/video/generate`;
        const videoResponse = await axios.post(video_url, {
          prompt,
          aspect_ratio,
          negative_prompt
        }, {
          headers: {
            'Authorization': req.headers.authorization,
            'Content-Type': 'application/json'
          },
          timeout: 30000 // 30 second timeout
        });

        console.log('✅ Video service response:', videoResponse.data);

        // ✅ Save assistant message with video operation data if chatId provided
        if (chatId) {
          const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
          if (!chat) {
            return res.status(404).json({ error: 'Chat not found' });
          }

          // Save assistant message with video operation data
          const assistantMessage = await prisma.message.create({
            data: {
              chatId,
              role: 'ASSISTANT',
              content: `Generating video: "${prompt}"...`,
              tokens: 1000, // Fixed token count for video generation
              // Store video data in files field as JSON
              files: JSON.stringify([{
                type: 'video',
                operationId: videoResponse.data.operationId,
                status: 'processing',
                filename: videoResponse.data.filename,
                prompt: prompt,
                aspect_ratio: aspect_ratio
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
          data: { userId, model: 'veo-3.0', tokens, cost: tokens * 0.001 }
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
          message: 'Video generation started successfully',
          tokens,
          usage: { current: updatedUser.apiUsage, limit: updatedUser.monthlyLimit }
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
    let video_url = `${baseUrl}/api/video/status/${operationId}`;
    try {
      const statusResponse = await axios.get(video_url, {
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

module.exports = router;
