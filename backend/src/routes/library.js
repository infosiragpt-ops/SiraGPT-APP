const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();
const prisma = new PrismaClient();

function parseAndFindFile(jsonString, type) {
    if (!jsonString) return null;
    try {
        const filesArray = JSON.parse(jsonString);
        // Find the first entry that matches the type and has a URL
        const foundFile = filesArray.find((f) => f.type === type && typeof f.url === 'string' && f.url.length > 0);
        //console.log(`[parseAndFindFile] JSON String: ${jsonString}, Type: ${type}, Found: ${JSON.stringify(foundFile)}`); // NEW LOG
        return foundFile;
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
        const userId = req.user.id; // Authentication middleware se userId mil raha hai
        console.log(`[DEBUG - Backend] Attempting to fetch images for userId: ${userId}`);
        const userImageMessages = await prisma.message.findMany({
            where: {
                chat: {
                    userId: userId, // User ke chats se messages filter karein
                },
                role: 'ASSISTANT', // Sirf ASSISTANT messages (jo generation ke results hain)
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
                        title: true, // Chat ka title bhi show karne ke liye
                    },
                },
            },
            orderBy: {
                timestamp: 'desc', // Latest images pehle dikhenge
            },
            // You might want to add pagination here for large number of images
            // take: 20,
            // skip: (page - 1) * 20,
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
                return null; // Invalid entries ko discard kar dein
            })
            .filter(Boolean); // null entries ko array se hata dein
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
                //  string_contains: '"type":"video"', // 'string_contains' deprecated hai, 'contains' istemal karein
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
            // take: 20,
            // skip: (page - 1) * 20,
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

// Media Library se images aur videos fetch karne ke liye endpoint
router.get('/media-library', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { page = 1, limit = 20, type } = req.query; // Pagination aur filtering ke liye
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    try {
        const messagesWithFiles = await prisma.message.findMany({
            where: {
                chat: {
                    userId: userId,
                },
                role: 'ASSISTANT', // Typically, generated media comes from ASSISTANT
                files: {
                    not: null, // Yeh database column 'files' ka NULL na hone ki check hai
                },
            },
            orderBy: {
                timestamp: 'desc',
            },
            // Pagination only applied here. Filtering for specific types will be done in JS.
            skip: skip,
            take: take + 1, // Ek extra item fetch karein ye dekhne ke liye ki next page hai ya nahi
            select: {
                id: true,
                content: true,
                files: true,
                timestamp: true,
                chatId: true,
            },
        });

        // Filter and process media items in JavaScript
        const allMediaItems = messagesWithFiles.flatMap(message => {
            try {
                const files = JSON.parse(message.files);
                if (Array.isArray(files)) {
                    return files.map(file => {
                        // Only consider items with a 'type' property that is 'image' or 'video'
                        if (file && (file.type === 'image' || file.type === 'video')) {
                            // Apply type filter if specified
                            if (!type || file.type === type) {
                                return {
                                    messageId: message.id,
                                    chatId: message.chatId,
                                    timestamp: message.timestamp,
                                    ...file, // Includes type, url/filename, prompt, status, video_url, download_url etc.
                                };
                            }
                        }
                        return null;
                    }).filter(Boolean); // Remove null entries after filtering
                }
            } catch (e) {
                console.error(`Failed to parse files JSON for message ID ${message.id}:`, e);
            }
            return [];
        });

        // Manual pagination based on filtered results
        const paginatedItems = allMediaItems.slice(0, take);
        const hasNextPage = allMediaItems.length > take;
        const totalItemsOnCurrentFilter = allMediaItems.length; // This is count before slicing
        const totalPagesEstimate = Math.ceil(totalItemsOnCurrentFilter / parseInt(limit)); // Approximation

        res.json({
            items: paginatedItems,
            currentPage: parseInt(page),
            limit: parseInt(limit),
            totalItems: totalItemsOnCurrentFilter, // Total items found for the current filter on this fetch window
            totalPages: totalPagesEstimate,
            hasNextPage: hasNextPage,
        });

    } catch (error) {
        console.error('Error fetching media library:', error);
        res.status(500).json({ error: 'Failed to fetch media library items' });
    }
});


module.exports = router;
