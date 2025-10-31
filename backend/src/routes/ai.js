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
const mime = require('mime-types');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
const PDFDocument = require('pdfkit');


// Dependencies ko file ke top par import karen
const fs = require('fs').promises;
const fsSync = require('fs'); // ✅ For synchronous file operations
const path = require('path');
const { use } = require('passport');

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

async function saveChatAndTrackUsage(userId, chatId, prompt, fullResponseContent, tokens, model, processedFiles, assistantFiles = []) {
  try {
    console.log("Background task: Saving to database...", { assistantFiles });


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
        data: {
          chatId,
          role: 'ASSISTANT',
          content: fullResponseContent,
          tokens,
          files: assistantFiles.length > 0 ? JSON.stringify(assistantFiles) : null
        }
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
say hello so give the answer hello how can i help you

When a user asks you to create a document, report, or any text file (e.g., .docx, .pdf, .md), you must first generate the content of the document using markdown for structure (e.g., # for Heading 1, ## for Heading 2). Then, you must wrap the entire document content in a special tag. The format is [CREATE_DOCUMENT:filename.ext]...document content...[/CREATE_DOCUMENT]. Replace 'filename.ext' with an appropriate filename for the document, for example 'market_analysis_report.docx' or 'summary.pdf'. The content inside the tags will be saved as a file. The full response, including the tags, will be visible in the chat.`
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
      let finalContent = fullResponseContent;
      let newFiles = [];

      if (isAuth) {
        const docRegex = /\[CREATE_DOCUMENT:(?<filename>[^\]]+)\](?<content>[\s\S]*?)\[\/CREATE_DOCUMENT\]/;
        const docMatch = fullResponseContent.match(docRegex);

        if (docMatch && docMatch.groups) {
          const { filename, content } = docMatch.groups;
          const chatContent = content.trim();

          const uploadsDir = path.join(__dirname, '../../uploads/documents', userId);
          await fs.mkdir(uploadsDir, { recursive: true });
          const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
          const filePath = path.join(uploadsDir, safeFilename);

          try {
            const newFileRecord = await prisma.file.create({
              data: {
                userId: userId,
                filename: safeFilename,
                originalName: filename,
                mimeType: mime.lookup(safeFilename) || 'application/octet-stream',
                size: 0, // Placeholder
                path: filePath,
              },
            });

            const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
            const fileUrl = `${baseUrl}/uploads/documents/${userId}/${safeFilename}`;

            newFiles.push({
              type: 'document',
              id: newFileRecord.id,
              name: newFileRecord.originalName,
              filename: newFileRecord.filename,
              mimeType: newFileRecord.mimeType,
              downloadUrl: fileUrl,
              path: newFileRecord.path,
            });

            const extension = path.extname(safeFilename).toLowerCase();

            if (extension === '.docx') {
              const doc = new Document({
                sections: [{
                  children: chatContent.split('\n').map(line => {
                    line = line.trim();
                    if (line.startsWith('# ')) return new Paragraph({ text: line.substring(2), heading: HeadingLevel.HEADING_1, spacing: { after: 200 } });
                    if (line.startsWith('## ')) return new Paragraph({ text: line.substring(3), heading: HeadingLevel.HEADING_2, spacing: { after: 180 } });
                    if (line.startsWith('### ')) return new Paragraph({ text: line.substring(4), heading: HeadingLevel.HEADING_3, spacing: { after: 160 } });
                    if (line.startsWith('* ') || line.startsWith('- ')) return new Paragraph({ text: line.substring(2), bullet: { level: 0 } });

                    const parts = line.split(/(\*\*.*?\*\*|\*.*?\*)/g).filter(part => part);
                    const textRuns = parts.map(part => {
                      if (part.startsWith('**') && part.endsWith('**')) {
                        return new TextRun({ text: part.slice(2, -2), bold: true });
                      }
                      if (part.startsWith('*') && part.endsWith('*')) {
                        return new TextRun({ text: part.slice(1, -1), italics: true });
                      }
                      return new TextRun(part);
                    });

                    return new Paragraph({ children: textRuns, spacing: { after: 100 } });
                  }),
                }],
              });
              const buffer = await Packer.toBuffer(doc);
              await fs.writeFile(filePath, buffer);
            } else if (extension === '.pdf') {
              await new Promise((resolve, reject) => {
                const doc = new PDFDocument({ margin: 50 });
                const stream = fsSync.createWriteStream(filePath);
                doc.pipe(stream);

                chatContent.split('\n').forEach(line => {
                  line = line.trim();
                  if (line.startsWith('# ')) {
                    doc.fontSize(24).font('Helvetica-Bold').text(line.substring(2), { paragraphGap: 10 });
                  } else if (line.startsWith('## ')) {
                    doc.fontSize(18).font('Helvetica-Bold').text(line.substring(3), { paragraphGap: 8 });
                  } else if (line.startsWith('### ')) {
                    doc.fontSize(14).font('Helvetica-Bold').text(line.substring(4), { paragraphGap: 6 });
                  } else if (line.startsWith('* ') || line.startsWith('- ')) {
                    doc.fontSize(12).font('Helvetica').text(`• ${line.substring(2)}`, { paragraphGap: 5 });
                  } else if (line.trim() === '') {
                    doc.moveDown();
                  } else {
                    // Basic support for bold and italic
                    const parts = line.split(/(\*\*.*?\*\*|\*.*?\*)/g).filter(part => part);
                    parts.forEach((part, index) => {
                      let isBold = false;
                      let isItalic = false;
                      if (part.startsWith('**') && part.endsWith('**')) {
                        part = part.slice(2, -2);
                        isBold = true;
                      }
                      if (part.startsWith('*') && part.endsWith('*')) {
                        part = part.slice(1, -1);
                        isItalic = true;
                      }

                      if (isBold && isItalic) doc.font('Helvetica-BoldOblique');
                      else if (isBold) doc.font('Helvetica-Bold');
                      else if (isItalic) doc.font('Helvetica-Oblique');
                      else doc.font('Helvetica');

                      doc.fontSize(12).text(part, { continued: true });
                    });
                    doc.text('', { continued: false, paragraphGap: 5 });
                  }
                });

                doc.end();
                stream.on('finish', resolve).on('error', reject);
              });
            } else {
              await fs.writeFile(filePath, chatContent);
            }

            const finalStats = await fs.stat(filePath);
            await prisma.file.update({
              where: { id: newFileRecord.id },
              data: { size: finalStats.size },
            });
            newFiles[0].size = finalStats.size;

          } catch (fileError) {
            console.error("Error creating document:", fileError);
            finalContent = "I tried to create the document, but an error occurred while saving the file.";
            newFiles = [];
          }
        }

        await saveChatAndTrackUsage(userId, canPersist ? chatId : null, prompt, finalContent, tokens, actualModel, processedFiles, newFiles);
      } else {
        // Handle non-authenticated user case if necessary
        await saveChatAndTrackUsage(null, null, prompt, finalContent, tokens, actualModel, processedFiles);
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
      let imageUrl, tokens = 10000;
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
            tokens: 10000,
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
        data: { userId, model, tokens: 10000, cost: 1000 * 0.001 }
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
    body('files').optional().isArray(),
  ],
  authenticateToken,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { prompt, chatId, provider = 'OpenAI', model = 'gpt-4o', files } = req.body;
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
      let finalPrompt = prompt;
      let processedFiles = [];
      if (files && files.length > 0) {
        processedFiles = await Promise.all(
          files.map(async (fileId) => {
            const file = await prisma.file.findFirst({
              where: { id: fileId, userId }
            });
            if (file) {
              return {
                id: file.id,
                name: file.originalName,
                extractedText: file.extractedText,
                mimeType: file.mimeType,
                path: file.path
              };
            }
            return null;
          })
        ).then(results => results.filter(Boolean));

        if (processedFiles.length > 0) {
          const fileContext = processedFiles.map(f => {
            const content = f.extractedText || 'File content could not be extracted.';
            return `--- Attached File: ${f.name} ---\n${content}\n--- End of File ---`;
          }).join('\n\n');
          finalPrompt = `${prompt}\n\nUse the following content from the attached file(s) as context for the presentation:\n\n${fileContext}`;
        }
      }
      await prisma.message.create({
        data: {
          chatId,
          role: 'USER',
          content: prompt,
          files: processedFiles.length > 0 ? JSON.stringify(processedFiles) : null
        }
      });

      // Generate PPT using AI service
      const pptResult = await aiService.generatePPT(finalPrompt, provider, model);

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

      const { prompt, chatId, model } = req.body;
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

      // Decrypt Gmail tokens
      const { decrypt, encrypt } = require('../utils/encryption');
      const gmailService = require('../services/gmail');

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

      // Always try to set credentials first
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
            await prisma.user.update({
              where: { id: userId },
              data: {
                gmailTokens: encrypt(JSON.stringify(refreshedTokens))
              }
            });
            // Set the refreshed credentials
            gmailService.setCredentials(refreshedTokens);
            // Use refreshed tokens for MCP
            decryptedTokens = refreshedTokens;
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

      // ✅ Get the last assistant message's response ID for context continuity
      let previousResponseId = null;
      if (chatId) {
        const lastAssistantMessage = await prisma.message.findFirst({
          where: {
            chatId,
            role: 'ASSISTANT'
          },
          orderBy: { timestamp: 'desc' },
          select: {
            metadata: true
          }
        });

        // Extract response_id from metadata if exists
        if (lastAssistantMessage?.metadata) {
          try {
            const metadata = JSON.parse(lastAssistantMessage.metadata);
            previousResponseId = metadata.response_id;
            console.log('📎 Using previous response ID for context:', previousResponseId);
          } catch (e) {
            console.log('No previous response ID found');
          }
        }
      }

      // Initialize OpenAI client with MCP connector
      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });

      console.log('🤖 Calling OpenAI with Gmail MCP connector...');

      // Enhanced system prompt to guide Gmail interactions
      const systemPrompt = `You are an expert Gmail assistant with access to the user's Gmail account through the Google Gmail MCP connector. You can help with ALL kinds of Gmail operations.

**Your Capabilities:**
1. Reading & Searching Emails
  - Read latest or unread emails, or specific emails
  - Search by sender, subject, date, keywords
  - Filter by labels (INBOX, SENT, DRAFTS, SPAM, TRASH)
  - Get email details including body, attachments, headers

2. Sending & Drafting
  - Compose and send new emails
  - Create drafts for later editing
  - Reply to existing emails
  - Forward emails
  - Send emails with formatting (bold, lists, links)

3. Analysis & Reports
  - Summarize email threads
  - Analyze email history (trends, frequent senders)
  - Generate reports (e.g., "emails from banks last month")
  - Extract specific information (dates, amounts, attachments)
  - Create tables or structured summaries
  - REMEMBER PREVIOUS CONTEXT for follow-up questions

4. Multilingual Support
  - Understand queries in ANY language (English, Urdu, Spanish, etc.)
  - Respond in the user's preferred language
  - Handle mixed-language queries

Important Guidelines:
- ALWAYS maintain context from previous messages
- If a follow-up question comes (like "which ones are less than 1000?"), refer back to your previous response
- Be helpful and proactive, ask clarifying questions only when essential
- Provide clear, formatted responses with emoji icons and include Gmail links
- Handle errors gracefully and respect user privacy
- Prefer concise lists. When listing emails, also include a machine-readable JSON block at the end using this exact wrapper:
  <EMAILS_JSON>{
   "emails": [
    {"id":"...","threadId":"...","subject":"...","from":"...","to":"...","date":"ISO-8601","snippet":"...","link":"https://mail.google.com/mail/#all/...","isUnread":BOOLEAN",},
   ],
   "count": NUMBER
  }</EMAILS_JSON>
- Do NOT claim to automatically perform inbox-management actions (mark read, archive, delete, label). If asked, provide clear steps and ask for explicit confirmation first.

Current Context:
- Current Date: ${new Date().toISOString().split('T')[0]}
- User Request: "${prompt}"

Process the user's request naturally and perform the necessary Gmail operations. Be conversational yet professional. If this is a follow-up question, reference your previous responses.`;

      // ✅ Build the request with optional previous_response_id for context
      const requestPayload = {
        model: model || "gpt-4o",
        tools: [
          {
            type: "mcp",
            server_label: "google_gmail",
            connector_id: "connector_gmail",
            authorization: decryptedTokens.accessToken,
            require_approval: "never",
          },
        ],
        input: `${systemPrompt}\n\n**User:** ${prompt}`,
      };

      // ✅ Add previous_response_id only if it exists (for context continuity)
      if (previousResponseId) {
        requestPayload.previous_response_id = previousResponseId;
      }

      // Call OpenAI with Gmail MCP connector
      const resp = await client.responses.create(requestPayload);

      console.log('📬 OpenAI MCP Response:', {
        id: resp.id,
        status: resp.status,
        mcpCallsCount: resp.mcp_calls?.length || 0
      });

      // Extract the text response and MCP calls
      const finalResponse = resp.output_text || "I couldn't process your Gmail request.";
      const mcpCalls = resp.mcp_calls || [];
      const responseId = resp.id; // ✅ Store this for next request

      // Parse Gmail results from MCP calls
      let gmailResult = null;
      let assistantFiles = null;

      if (mcpCalls.length > 0) {
        // Process the MCP calls to extract Gmail data
        for (const call of mcpCalls) {
          if (call.error) {
            console.error('MCP Call Error:', call.error);
            continue;
          }

          try {
            const output = JSON.parse(call.output);

            // Handle different Gmail operations based on the function name
            switch (call.name) {
              case 'list_messages':
              case 'search_messages':
                if (output.messages) {
                  const emails = output.messages.map(msg => ({
                    id: msg.id,
                    threadId: msg.thread_id,
                    subject: msg.subject,
                    from: msg.from,
                    to: msg.to,
                    date: msg.date,
                    snippet: msg.snippet,
                    body: msg.body,
                    link: (msg.link || `https://mail.google.com/mail/#all/${msg.id || msg.thread_id}`),
                    isUnread: !!(msg.is_unread || msg.isUnread || (Array.isArray(msg.labelIds) && msg.labelIds.includes('UNREAD')) || (Array.isArray(msg.labels) && msg.labels.includes('UNREAD')) || (Array.isArray(msg.label_ids) && msg.label_ids.includes('UNREAD')))
                  }));

                  gmailResult = {
                    action: 'read',
                    emails,
                    count: emails.length
                  };

                  const lower = (prompt || '').toLowerCase();
                  const filters = {
                    unreadOnly: /\bunread\b/.test(lower),
                    readOnly: (/\bread\b/.test(lower) || /\bseen\b/.test(lower)) && !/\bunread\b/.test(lower)
                  };

                  assistantFiles = JSON.stringify([{
                    type: 'gmail_emails',
                    emails,
                    count: emails.length,
                    filters
                  }]);
                }
                break;

              case 'send_message':
                if (output.success || output.message_id) {
                  gmailResult = {
                    action: 'send',
                    result: {
                      success: true,
                      messageId: output.message_id
                    }
                  };
                }
                break;

              case 'create_draft':
                if (output.success || output.draft_id) {
                  gmailResult = {
                    action: 'draft',
                    result: {
                      success: true,
                      draftId: output.draft_id
                    }
                  };
                }
                break;

              default:
                console.log('Unknown MCP call:', call.name);
            }
          } catch (parseError) {
            console.error('Error parsing MCP output:', parseError);
          }
        }
      }

      // ✅ Fallback: If no MCP structured emails, try to extract from model text output
      if (!gmailResult) {
        // Prefer JSON wrapped block if present
        const extractEmailsJson = (text) => {
          const match = text.match(/<EMAILS_JSON>([\s\S]*?)<\/EMAILS_JSON>/);
          if (!match) return null;
          try {
            const obj = JSON.parse(match[1]);
            if (obj && Array.isArray(obj.emails)) return obj;
          } catch { /* ignore */ }
          return null;
        };

        const jsonBlock = extractEmailsJson(finalResponse);
        if (jsonBlock) {
          gmailResult = {
            action: 'read',
            emails: jsonBlock.emails.map(e => ({
              id: e.id,
              threadId: e.threadId || e.thread_id,
              subject: e.subject,
              from: e.from,
              to: e.to,
              date: e.date,
              snippet: e.snippet,
              link: e.link,
              isUnread: typeof e.isUnread === 'boolean' ? e.isUnread : undefined
            })),
            count: typeof jsonBlock.count === 'number' ? jsonBlock.count : jsonBlock.emails.length
          };
        } else {
          // Heuristic parse: numbered list with fields
          const emails = [];
          const regex = /\n\s*(\d+)\)\s*(.+?)\n-\s*From:\s*(.+?)\n-\s*Received:\s*([^\n]+)\n-\s*Snippet:\s*([\s\S]*?)\n-\s*Open:\s*(\S+)/g;
          let m;
          while ((m = regex.exec(finalResponse)) !== null) {
            emails.push({
              id: undefined,
              threadId: undefined,
              subject: m[2].trim(),
              from: m[3].trim(),
              to: undefined,
              date: m[4].trim(),
              snippet: m[5].trim(),
              link: m[6].trim()
            });
          }
          if (emails.length > 0) {
            gmailResult = { action: 'read', emails, count: emails.length };
          }
        }

        if (gmailResult && gmailResult.emails?.length) {
          const lower = (prompt || '').toLowerCase();
          const filters = {
            unreadOnly: /\bunread\b/.test(lower),
            readOnly: (/\bread\b/.test(lower) || /\bseen\b/.test(lower)) && !/\bunread\b/.test(lower)
          };
          assistantFiles = JSON.stringify([
            {
              type: 'gmail_emails',
              emails: gmailResult.emails,
              count: gmailResult.count,
              filters
            }
          ]);
        }
      }

      // Save messages to chat
      if (chatId) {
        const chat = await prisma.chat.findFirst({ where: { id: chatId, userId } });
        if (!chat) {
          return res.status(404).json({ error: 'Chat not found' });
        }

        // Save user message with timestamp
        await prisma.message.create({
          data: {
            chatId,
            role: 'USER',
            content: prompt,
          }
        });

        // ✅ Save assistant message with response_id in metadata for future context
        await prisma.message.create({
          data: {
            chatId,
            role: 'ASSISTANT',
            content: finalResponse,
            tokens: finalResponse.length,
            files: assistantFiles,
            metadata: JSON.stringify({
              response_id: responseId, // ✅ Store OpenAI response ID
              mcp_calls_count: mcpCalls.length,
              timestamp: new Date().toISOString()
            })
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
        responseId, // ✅ Return response ID for debugging
        tokens
      });

    } catch (error) {
      console.error('Gmail AI generation error:', error);

      // Handle specific OpenAI MCP errors
      if (error.message?.includes('authorization') || error.message?.includes('token')) {
        return res.status(401).json({
          success: false,
          error: 'Gmail authorization failed. Please reconnect your Gmail account.',
          requiresConnection: true
        });
      }

      res.status(500).json({
        error: error.message || 'Gmail AI generation failed'
      });
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
