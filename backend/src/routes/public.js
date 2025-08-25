

const express = require('express');
const prisma = require('../config/database');
const router = express.Router();

router.get('/share/:shareId', async (req, res) => {
    try {
        const { shareId } = req.params;
        const chat = await prisma.chat.findUnique({
            where: { shareId, isShared: true },
            include: {
                messages: {
                    orderBy: { timestamp: 'asc' },
                    select: { role: true, content: true, timestamp: true }
                }
            }
        });

        if (!chat) {
            return res.status(404).json({ error: 'Shared chat not found.' });
        }
        res.json({ chat });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching shared chat.' });
    }
});

module.exports = router;