const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { listArtifactsByOwner } = require('../services/agents/task-tools');
const router = express.Router();
const prisma = require('../config/database');

function parseAndFindFile(value, type) {
    if (!value) return null;
    try {
        // Prisma Json column returns the parsed value directly; legacy rows
        // may still store a JSON-encoded string. Accept both shapes.
        const filesArray = typeof value === 'string' ? JSON.parse(value) : value;
        if (!Array.isArray(filesArray)) return null;
        return filesArray.find((f) => f && f.type === type && typeof f.url === 'string' && f.url.length > 0) || null;
    } catch (e) {
        console.error("Error parsing file JSON:", e);
        return null;
    }
}

/**
 * @route GET /api/library/images
 * @desc Get all generated images for the authenticated user
 * @access Private
 */
router.get('/images', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id; // userId proviene del middleware de autenticación
        console.log(`[DEBUG - Backend] Attempting to fetch images for userId: ${userId}`);
        const userImageMessages = await prisma.message.findMany({
            where: {
                chat: {
                    userId: userId, // Filtrar mensajes pertenecientes a los chats del usuario
                },
                role: 'ASSISTANT', // Únicamente mensajes ASSISTANT (resultados de generación)
                // files: {
                //     string_contains: '"type":"image"',
                // },
            },
            select: {
                id: true,
                content: true, // `imageUrl` is stored here
                files: true,   // Original JSON for prompt and other metadata
                timestamp: true,
                chat: {
                    select: {
                        title: true, // Incluir también el título del chat para mostrarlo
                    },
                },
            },
            orderBy: {
                timestamp: 'desc', // Las imágenes más recientes aparecen primero
            },
            // Bound the scan so a heavy account can't load its entire assistant-
            // message corpus into memory on one GET (mirrors /media-library).
            take: MESSAGE_MEDIA_SCAN_LIMIT,
        });

        const images = userImageMessages
            .map((msg) => {
                const imageFile = parseAndFindFile(msg.files, 'image');
                // Validate that the content matches the URL found in the files metadata for robustness
                if (imageFile && imageFile.url === msg.content) {
                    return {
                        id: msg.id,
                        url: msg.content, // Final image URL
                        prompt: imageFile.prompt || 'Generated Image', // Prompt from files metadata
                        createdAt: msg.timestamp,
                        chatTitle: msg.chat?.title || 'Unknown Chat',
                    };
                }
                return null; // Descartar entradas inválidas
            })
            .filter(Boolean); // Eliminar entradas nulas del arreglo
        console.log(userImageMessages.length);

        res.json(images);
    } catch (error) {
        console.error('Error fetching user images:', error);
        res.status(500).json({ error: 'Failed to fetch images' });
    }
});

/**
 * @route GET /api/library/videos
 * @desc Get all generated videos for the authenticated user (Placeholder)
 * @access Private
 */
router.get('/videos', authenticateToken, async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            console.error('Authentication Error: User ID is missing in the /videos route.');
            return res.status(401).json({ error: 'Authentication failed, user ID not found.' });
        }
        const userId = req.user.id;
        const userVideoMessages = await prisma.message.findMany({
            where: {
                chat: {
                    userId: userId,
                },
                role: 'ASSISTANT',
                // files: {
                //  string_contains: '"type":"video"', // 'string_contains' está obsoleto; usar 'contains'
                // },
            },
            select: {
                id: true,
                // content: true, // This would be the video URL
                files: true,   // For potential prompt or other metadata
                timestamp: true,
                chat: {
                    select: {
                        title: true,
                    },
                },
            },
            orderBy: {
                timestamp: 'desc',
            },
            // Bound the scan so a heavy account can't load its entire assistant-
            // message corpus into memory on one GET (mirrors /media-library).
            take: MESSAGE_MEDIA_SCAN_LIMIT,
        });

        console.log(userVideoMessages.length);

        const videos = userVideoMessages
            .map((msg) => {
                const videoFile = parseAndFindFile(msg.files, 'video');
                if (videoFile && videoFile.url) {
                    return {
                        id: msg.id,
                        url: videoFile.url,
                        prompt: videoFile.prompt || 'Generated Video',
                        createdAt: msg.timestamp,
                        chatTitle: msg.chat?.title || 'Unknown Chat',
                    };
                }
                return null;
            })
            .filter(Boolean);

        res.json(videos);
    } catch (error) {
        console.error('Error fetching user videos:', error);
        res.status(500).json({ error: 'Failed to fetch videos' });
    }
});

// Categories the library can show. image/video are stored inline on the
// assistant message's files[] JSON; audio/music/webapp/mobileapp live in the
// agent artifact store (see task-tools.listArtifactsByOwner).
const MEDIA_LIBRARY_CATEGORIES = ['image', 'video', 'audio', 'music', 'webapp', 'mobileapp'];
const ARTIFACT_LIBRARY_CATEGORIES = ['audio', 'music', 'webapp', 'mobileapp'];
// Bound the message scan so a heavy account can't blow up memory; the library
// shows the most recent generations first.
const MESSAGE_MEDIA_SCAN_LIMIT = 1000;

// Endpoint para obtener imágenes, videos, audio, música y apps desde la Media Library
router.get('/media-library', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { page = 1, limit = 20, type } = req.query; // Para paginación y filtrado
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const take = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    // null === "Todos" (no filter). Unknown values fall back to "Todos".
    const filter = MEDIA_LIBRARY_CATEGORIES.includes(String(type)) ? String(type) : null;

    try {
        const items = [];

        // 1) Images + videos are persisted inline on the assistant message files[].
        if (!filter || filter === 'image' || filter === 'video') {
            const messagesWithFiles = await prisma.message.findMany({
                where: {
                    chat: { userId },
                    role: 'ASSISTANT',
                    files: { not: null },
                },
                orderBy: { timestamp: 'desc' },
                take: MESSAGE_MEDIA_SCAN_LIMIT,
                select: { id: true, files: true, timestamp: true, chatId: true },
            });

            for (const message of messagesWithFiles) {
                let files;
                try {
                    files = typeof message.files === 'string' ? JSON.parse(message.files) : (message.files || []);
                } catch (e) {
                    console.error(`Failed to parse files JSON for message ID ${message.id}:`, e);
                    continue;
                }
                if (!Array.isArray(files)) continue;
                for (const file of files) {
                    if (!file || (file.type !== 'image' && file.type !== 'video')) continue;
                    if (filter && file.type !== filter) continue;
                    items.push({
                        messageId: message.id,
                        chatId: message.chatId,
                        timestamp: message.timestamp,
                        source: 'message',
                        ...file, // type, url/filename, prompt, status, video_url, download_url, …
                    });
                }
            }
        }

        // 2) Audio / music / web-apps / mobile-apps live in the agent artifact store.
        if (!filter || ARTIFACT_LIBRARY_CATEGORIES.includes(filter)) {
            const categories = filter ? [filter] : ARTIFACT_LIBRARY_CATEGORIES;
            items.push(...listArtifactsByOwner(userId, { categories }));
        }

        // Merge both sources, newest-first, then paginate in memory.
        items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
        const totalItems = items.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / take));
        const start = (pageNum - 1) * take;
        const paginatedItems = items.slice(start, start + take);

        res.json({
            items: paginatedItems,
            currentPage: pageNum,
            limit: take,
            totalItems,
            totalPages,
            hasNextPage: start + take < totalItems,
        });
    } catch (error) {
        console.error('Error fetching media library:', error);
        res.status(500).json({ error: 'Failed to fetch media library items' });
    }
});


module.exports = router;
