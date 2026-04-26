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
const documentService = require('../services/document-service');
const router = express.Router();
const cookie = require('cookie');
const crypto = require('crypto');
const mime = require('mime-types');

const { exec } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { use } = require('passport');


async function saveChatAndTrackUsage(userId, chatId, prompt, fullResponseContent, tokens, model, processedFiles, assistantFiles = [], regenerate = false) {
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

            if (!regenerate) {
                await prisma.message.create({
                    data: {
                        chatId,
                        role: 'USER',
                        content: prompt,
                        files: processedFiles.length > 0 ? JSON.stringify(processedFiles) : null
                    }
                });
            }

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
        await usageService.recordUsage(userId, model, totalTokens, totalTokens * 0.001);

        console.log("Background task: Database save complete.");
    } catch (dbError) {
        console.error("Error in background database save:", dbError);
    }
}

const streamControllers = new Map();


// ✅ Generate Word Document Content - Specialized endpoint for Word Connector
router.post(
    '/generate-word',
    [
        body('model').trim().notEmpty().withMessage('Model is required'),
        body('prompt').trim().notEmpty().withMessage('Prompt is required'),
        body('provider').trim().notEmpty().withMessage('Provider is required'),
        body('chatId').optional().isString(),
        body('files').optional().isArray(),
        body('streamId').optional().isString(),
        body('selectedText').optional().isString(),

    ],
    authenticateToken,
    async (req, res) => {
        const controller = new AbortController();
        const signal = controller.signal;
        const { streamId } = req.body;

        if (streamId) {
            streamControllers.set(streamId, controller);
            console.log(`Word Document Stream registered with ID: ${streamId}`);
        }

        res.on('close', () => {
            if (!res.writableEnded) {
                console.log(`Client response closed for Word document chat: ${req.body.chatId}. Aborting generation.`);
                controller.abort();
            }
        });
        req.on('aborted', () => {
            console.log(`Client request aborted for Word document chat: ${req.body.chatId}. Aborting generation.`);
            controller.abort();
        });

        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                controller.abort();
                return res.status(400).json({ errors: errors.array() });
            }

            const { prompt, chatId, provider = 'OpenAI', model = 'gpt-4o', files, selectedText } = req.body;
            const userId = req.user.id;

            console.log('📄 Word Document generation request:', { prompt, chatId, provider, model, hasFiles: !!files?.length });

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
            let chat = null;
            if (chatId) {
                chat = await prisma.chat.findUnique({ where: { id: chatId } });
                if (chat && chat.userId !== userId) {
                    return res.status(404).json({ error: 'Chat not found or access denied.' });
                }
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

            // Set up streaming response
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            // Build messages for Word document generation
            const messages = [];
            const { mode } = req.body;

            let wordSystemMessage;

            if (mode === 'rewrite') {
                wordSystemMessage = `You are an expert editor. You are editing a specific part of a document based on user instructions.

CRITICAL REQUIREMENTS:
1. Apply the user's command ONLY to the selected text provided in the prompt.
2. Use the full document context (if provided) to ensure consistency in tone, style, and content, but DO NOT rewrite the whole document.
3. Return ONLY the rewritten version of the selected text in clean HTML format.
4. Do NOT include any explanations, quotes, or conversational filler.
5. If the user asks to "summarize", summarize only the selected text.
6. If the user asks to "fix grammar", fix it only for the selected text.
7. Return HTML content if needed for formatting (bold, italic, lists), otherwise plain text.
8. For math equations, use LaTeX format with single dollar signs ($...$) for inline and double dollar signs ($$...$$) for block.

Your response will directly replace the selected text in the document.`;
            } else {
                // Default mode: Create new document
                wordSystemMessage = `You are an expert document writer specializing in creating professional Word documents. Your task is to generate well-structured, formatted content that will be displayed in a rich text editor.

CRITICAL REQUIREMENTS:
1. Return content in clean HTML format suitable for a rich text editor (Tiptap)
2. Use proper HTML tags: <h1>, <h2>, <h3> for headings, <p> for paragraphs, <ul>/<ol> for lists, <strong> for bold, <em> for italic
3. Do NOT include markdown syntax (no #, *, -, etc.)
4. Do NOT include code blocks or backticks
5. Structure the document with proper headings and sections
6. Use semantic HTML that will render beautifully in a Word-like editor
7. Include proper spacing and formatting
8. If the user asks for tables, use proper HTML <table> tags
9. For math equations, ALWAYS use LaTeX format:
   - Inline math: Use single dollar signs like $E=mc^2$ or $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$
   - Block math: Use double dollar signs like $$\\int_0^1 x^2 dx$$ or $$x = \\frac{5 \\pm 1}{4}$$
   - Examples: $2x^2 - 5x + 3 = 0$, $\\sqrt{x + 4} = 3$, $$x_1 = \\frac{3}{2}$$, $$x_2 = 1$$
   - Always escape backslashes in LaTeX: use \\\\ for single backslash
   - The LaTeX will be automatically converted to proper math rendering nodes

Generate a complete, professional document based on the user's request.`;
            }

            messages.push({
                role: 'system',
                content: wordSystemMessage
            });

            // Add file context if available
            if (processedFiles.length > 0) {
                for (const file of processedFiles) {
                    if (file.extractedText) {
                        messages.push({
                            role: 'user',
                            content: `Context from file "${file.name}":\n${file.extractedText.substring(0, 5000)}`
                        });
                    }
                }
            }
            const userPrompt = selectedText ? `Edit the following text\n The user has selected the following text to edit:
"${selectedText}"\n\n  
USER COMMAND:
${prompt}
`

                : prompt;
            // Add user prompt
            messages.push({
                role: 'user',
                content: userPrompt
            });

            // Initialize OpenAI client based on provider
            let openai;
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
            } else if (provider === "DeepSeek") {
                openai = new OpenAI({
                    apiKey: process.env.DEEPSEEK_API_KEY,
                    baseURL: "https://api.deepseek.com",
                });
            } else {
                openai = new OpenAI({
                    apiKey: process.env.OPENAI_API_KEY
                });
            }

            let fullResponseContent = '';

            // Generate stream
            const stream = await openai.chat.completions.create({
                model: model,
                messages: messages,
                stream: true,
            }, { signal });

            // Stream response
            for await (const chunk of stream) {
                const contentChunk = chunk.choices[0]?.delta?.content || '';
                if (contentChunk) {
                    fullResponseContent += contentChunk;
                    res.write(`data: ${JSON.stringify({ content: contentChunk })}\n\n`);
                }
            }

            // Save chat and track usage
            if (chatId && fullResponseContent.trim()) {
                const tokens = fullResponseContent.length + prompt.length;
                // Don't save the full content to the message, just a confirmation.
                await saveChatAndTrackUsage(userId, chatId, prompt, mode === "rewrite" ? fullResponseContent : "The document has been generated in the Word Connector.", tokens, model, processedFiles);

                // Update chat with Word content
                if (mode !== 'rewrite') {
                    await prisma.chat.update({
                        where: { id: chatId },
                        data: { wordContent: fullResponseContent, isWordConnectorChat: true }
                    });
                }
            }

            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            res.end();

        } catch (error) {
            console.error('❌ Word Document generation error:', error);

            if (!res.headersSent) {
                res.status(500).json({ error: error.message || 'Word Document generation failed' });
            } else {
                try {
                    res.write(`data: ${JSON.stringify({ error: error.message || 'Word Document generation failed' })}\n\n`);
                } catch (writeError) {
                    console.error('Failed to write error to stream:', writeError);
                }
            }
        } finally {
            if (streamId) {
                streamControllers.delete(streamId);
                console.log(`Word Document Stream unregistered for ID: ${streamId}`);
            }

            if (!res.writableEnded) {
                res.end();
            }
        }
    }
);

module.exports = router;
