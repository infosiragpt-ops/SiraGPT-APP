const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../config/database');
const figmaService = require('../services/figma-service');
const router = express.Router();

/**
 * POST /api/figma/generate
 * Generate a flowchart/diagram using Figma/Mermaid
 */
router.post('/generate_flowchart', [
    body('prompt').trim().notEmpty().withMessage('Prompt is required'),
    body('displayPrompt').optional().isString().trim(),
    body('chatId').optional().isString(),
    body('conversationHistory').optional().isArray()
], authenticateToken, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { prompt, chatId, conversationHistory = [] } = req.body;
        const displayPrompt = (req.body.displayPrompt || prompt).trim();
        const userId = req.user.id;

        console.log('🎨 Generating Figma flowchart:', { prompt, chatId, userId });

        // Generate flowchart
        const flowchartData = await figmaService.generateFlowchart(
            prompt,
            conversationHistory,
            userId
        );

        // Render Mermaid to image URL (normal URL, not base64)
        const imageUrl = await figmaService.renderMermaidToImage(flowchartData.mermaidCode);

        // Ensure imageUrl is a normal URL string, not base64
        const finalImageUrl = imageUrl && typeof imageUrl === 'string' && !imageUrl.startsWith('data:')
            ? imageUrl
            : null;

        console.log('🖼️ Generated image URL:', finalImageUrl);

        // Save to database if chatId provided
        let assistantMessage = null;
        if (chatId) {
            const chat = await prisma.chat.findFirst({
                where: { id: chatId, userId }
            });

            if (chat) {
                // Save the user's prompt as a new message
                await prisma.message.create({
                    data: {
                        chatId,
                        role: 'USER',
                        content: displayPrompt,
                    },
                });
                console.log('✅ User message saved to database');

                // Create file record for the diagram (optional - we can also just store in message)
                let fileRecord = null;
                if (finalImageUrl) {
                    try {
                        fileRecord = await prisma.file.create({
                            data: {
                                userId,
                                filename: `flowchart-${Date.now()}.png`,
                                originalName: `flowchart-${Date.now()}.png`,
                                mimeType: 'image/png',
                                size: 0,
                                path: finalImageUrl, // Store normal URL, not base64
                                extractedText: JSON.stringify({
                                    type: 'figma',
                                    mermaidCode: flowchartData.mermaidCode,
                                    figmaFile: flowchartData.figmaFile,
                                    embedUrl: flowchartData.embedUrl,
                                    title: flowchartData.title
                                })
                            }
                        });
                    } catch (fileError) {
                        console.error('Error creating file record:', fileError);
                        // Continue without file record - we'll store data in message
                    }
                }

                // Create assistant message with flowchart data
                const fileData = {
                    ...(fileRecord && { id: fileRecord.id }),
                    type: 'figma',
                    mermaidCode: flowchartData.mermaidCode,
                    imageUrl: finalImageUrl, // Normal URL, not base64
                    figmaFile: flowchartData.figmaFile,
                    embedUrl: flowchartData.embedUrl,
                    title: flowchartData.title
                };

                assistantMessage = await prisma.message.create({
                    data: {
                        chatId,
                        role: 'ASSISTANT',
                        content: `I've created a flowchart for: "${displayPrompt}"\n\n${flowchartData.mermaidCode ? '```mermaid\n' + flowchartData.mermaidCode + '\n```' : ''}`,
                        files: JSON.stringify([fileData])
                    }
                });

                // Update chat updatedAt
                await prisma.chat.update({
                    where: { id: chatId },
                    data: { updatedAt: new Date() }
                });
            }
        }

        res.json({
            success: true,
            flowchart: {
                mermaidCode: flowchartData.mermaidCode,
                imageUrl: finalImageUrl, // Normal URL, not base64
                figmaFile: flowchartData.figmaFile,
                embedUrl: flowchartData.embedUrl,
                title: flowchartData.title
            },
            assistantMessage: assistantMessage ? {
                id: assistantMessage.id,
                role: assistantMessage.role,
                content: assistantMessage.content,
                files: JSON.parse(assistantMessage.files || '[]')
            } : null,
            message: 'Flowchart generated successfully'
        });
    } catch (error) {
        console.error('Figma generation error:', error);
        res.status(500).json({
            error: error.message || 'Failed to generate flowchart'
        });
    }
});

module.exports = router;
