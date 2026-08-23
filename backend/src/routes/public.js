

const express = require('express');
const prisma = require('../config/database');
const router = express.Router();

router.get('/share/:shareId', async (req, res) => {
    try {
        const { shareId } = req.params;
        const chat = await prisma.chat.findFirst({
            where: { shareId, isShared: true, deletedAt: null },
            include: {
                messages: {
                    // Nunca exponer mensajes soft-deleted por un enlace público.
                    where: { deletedAt: null },
                    orderBy: { timestamp: 'asc' },
                    select: {
                        id: true,
                        role: true,
                        content: true,
                        files: true,
                        metadata: true,
                        timestamp: true
                    }
                }
            }
        });

        if (!chat) {
            return res.status(404).json({ error: 'Shared chat not found.' });
        }

        // Return structured data for frontend
        const responseData = {
            type: 'complete',
            chat: {
                id: chat.id,
                title: chat.title,
                model: chat.model,
                messages: chat.messages.map(msg => ({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    files: msg.files,
                    metadata: msg.metadata,
                    timestamp: msg.timestamp
                })),
                createdAt: chat.createdAt,
                originalShareId: shareId
            },
            sharedAt: new Date()
        };

        res.json(responseData);
    } catch (error) {
        console.error('Error fetching shared chat:', error);
        res.status(500).json({ error: 'Error fetching shared chat.' });
    }
});

// Get shared message content
router.get('/share/message/:shareId', async (req, res) => {
    try {
        const { shareId } = req.params;
        
        const messageShare = await prisma.messageShare.findUnique({
            where: { id: shareId },
            include: {
                chat: {
                    // Si el chat origen fue borrado, el enlace muere con él.
                    where: { deletedAt: null },
                    select: { title: true, model: true }
                }
            }
        });

        if (!messageShare || !messageShare.chat) {
            return res.status(404).json({ error: 'Shared message not found.' });
        }

        // Get the user and assistant messages (soft-deleted → 404)
        const userMessage = await prisma.message.findFirst({
            where: { id: messageShare.userMessageId, deletedAt: null },
            select: { id: true, role: true, content: true, files: true, metadata: true, timestamp: true }
        });

        const assistantMessage = await prisma.message.findFirst({
            where: { id: messageShare.assistantMessageId, deletedAt: null },
            select: { id: true, role: true, content: true, files: true, metadata: true, timestamp: true }
        });

        if (!userMessage || !assistantMessage) {
            return res.status(404).json({ error: 'Message content not found.' });
        }

        // Return structured data with proper message pair
        const responseData = {
            type: 'message',
            userMessage: {
                id: userMessage.id,
                role: userMessage.role,
                content: userMessage.content,
                files: userMessage.files,
                metadata: userMessage.metadata,
                timestamp: userMessage.timestamp
            },
            assistantMessage: {
                id: assistantMessage.id,
                role: assistantMessage.role,
                content: assistantMessage.content,
                files: assistantMessage.files,
                metadata: assistantMessage.metadata,
                timestamp: assistantMessage.timestamp
            },
            chatTitle: messageShare.chat.title,
            chatModel: messageShare.chat.model,
            originalChatId: messageShare.chatId,
            shareId: shareId,
            sharedAt: messageShare.sharedAt
        };

        res.json(responseData);
    } catch (error) {
        console.error('Error fetching shared message:', error);
        res.status(500).json({ error: 'Error fetching shared message.' });
    }
});

module.exports = router;