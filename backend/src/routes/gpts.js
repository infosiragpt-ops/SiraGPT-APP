const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/gpts - Get all public GPTs + user's private GPTs
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { category, search, featured, visibility = 'all' } = req.query;

    // Build base visibility clause
    const baseVisibilityClause = {
      OR: [
        { visibility: 'PUBLIC' },
        ...(userId ? [{ creatorId: userId }] : [])
      ]
    };

    let whereClause = { ...baseVisibilityClause };

    // Add category filter
    if (category && category !== 'All') {
      whereClause.category = category;
    }

    // Add search filter - fix circular reference
    if (search && search.trim()) {
      const searchTerm = search.trim();
      whereClause = {
        AND: [
          baseVisibilityClause, // Use the base clause instead of the modified one
          {
            OR: [
              { name: { contains: searchTerm, mode: 'insensitive' } },
              { description: { contains: searchTerm, mode: 'insensitive' } }
            ]
          }
        ]
      };
    }

    // Add featured filter
    if (featured === 'true') {
      if (whereClause.AND) {
        whereClause.AND.push({ isFeatured: true });
      } else {
        whereClause.isFeatured = true;
      }
    }

    // Handle visibility filter
    if (visibility !== 'all' && userId) {
      if (visibility === 'mine') {
        whereClause = { creatorId: userId };
      } else if (visibility === 'public') {
        whereClause = { visibility: 'PUBLIC' };
      }
    }

    console.log('GPT Query WHERE clause:', JSON.stringify(whereClause, null, 2));

    const gpts = await prisma.customGpt.findMany({
      where: whereClause,
      include: {
        creator: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        },
        _count: {
          select: {
            knowledgeFiles: true,
            chats: true
          }
        }
      },
      orderBy: [
        { isFeatured: 'desc' },
        { createdAt: 'desc' }
      ]
    });

    // Transform the data to match frontend expectations
    const transformedGpts = gpts.map(gpt => ({
      ...gpt,
      _count: {
        conversations: gpt._count.chats,
        files: gpt._count.knowledgeFiles
      }
    }));

    res.json({ gpts: transformedGpts });
  } catch (error) {
    console.error('Error fetching GPTs:', error);
    res.status(500).json({ error: 'Failed to fetch GPTs' });
  }
});

// GET /api/gpts/:id - Get specific GPT
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const gpt = await prisma.customGpt.findUnique({
      where: { id },
      include: {
        creator: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        },
        knowledgeFiles: true
      }
    });

    if (!gpt) {
      return res.status(404).json({ error: 'GPT not found' });
    }

    // Check if user can access this GPT
    if (gpt.visibility === 'PRIVATE' && gpt.creatorId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ gpt });
  } catch (error) {
    console.error('Error fetching GPT:', error);
    res.status(500).json({ error: 'Failed to fetch GPT' });
  }
});

// GET /api/gpts/share/:shareId - Get GPT by share ID
router.get('/share/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;

    const gpt = await prisma.customGpt.findUnique({
      where: { shareId },
      include: {
        creator: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        },
        knowledgeFiles: true
      }
    });

    if (!gpt) {
      return res.status(404).json({ error: 'GPT not found' });
    }

    // Only public and unlisted GPTs can be accessed via share link
    if (gpt.visibility === 'PRIVATE') {
      return res.status(403).json({ error: 'This GPT is private' });
    }

    res.json({ gpt });
  } catch (error) {
    console.error('Error fetching shared GPT:', error);
    res.status(500).json({ error: 'Failed to fetch shared GPT' });
  }
});

// POST /api/gpts - Create new GPT
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      name,
      description,
      iconUrl,
      instructions,
      greetingMessage,
      modelName,
      temperature,
      maxTokens,
      conversationStarters,
      visibility,
      category,
      actions,
      capabilities
    } = req.body;

    // Validation
    if (!name || !instructions) {
      return res.status(400).json({ error: 'Name and instructions are required' });
    }

    if (name.length > 100) {
      return res.status(400).json({ error: 'Name must be 100 characters or less' });
    }

    if (instructions.length > 8000) {
      return res.status(400).json({ error: 'Instructions must be 8000 characters or less' });
    }

    const gpt = await prisma.customGpt.create({
      data: {
        creatorId: userId,
        name: name.trim(),
        description: description?.trim(),
        iconUrl,
        instructions: instructions.trim(),
        greetingMessage: greetingMessage?.trim(),
        modelName: modelName || 'gpt-3.5-turbo',
        temperature: temperature || 0.7,
        maxTokens,
        conversationStarters: conversationStarters || [],
        visibility: visibility || 'PRIVATE',
        category,
        actions: actions || [],
        // Store capabilities in a custom field if needed
      },
      include: {
        creator: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        }
      }
    });

    res.status(201).json({ gpt });
  } catch (error) {
    console.error('Error creating GPT:', error);
    res.status(500).json({ error: 'Failed to create GPT' });
  }
});

// PUT /api/gpts/:id - Update GPT
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const {
      name,
      description,
      iconUrl,
      instructions,
      greetingMessage,
      modelName,
      temperature,
      maxTokens,
      conversationStarters,
      visibility,
      category,
      actions
    } = req.body;

    // Check if GPT exists and user owns it
    const existingGpt = await prisma.customGpt.findUnique({
      where: { id }
    });

    if (!existingGpt) {
      return res.status(404).json({ error: 'GPT not found' });
    }

    if (existingGpt.creatorId !== userId) {
      return res.status(403).json({ error: 'You can only edit your own GPTs' });
    }

    // Validation
    if (name && name.length > 100) {
      return res.status(400).json({ error: 'Name must be 100 characters or less' });
    }

    if (instructions && instructions.length > 8000) {
      return res.status(400).json({ error: 'Instructions must be 8000 characters or less' });
    }

    const updatedGpt = await prisma.customGpt.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() }),
        ...(iconUrl !== undefined && { iconUrl }),
        ...(instructions !== undefined && { instructions: instructions.trim() }),
        ...(greetingMessage !== undefined && { greetingMessage: greetingMessage?.trim() }),
        ...(modelName !== undefined && { modelName }),
        ...(temperature !== undefined && { temperature }),
        ...(maxTokens !== undefined && { maxTokens }),
        ...(conversationStarters !== undefined && { conversationStarters }),
        ...(visibility !== undefined && { visibility }),
        ...(category !== undefined && { category }),
        ...(actions !== undefined && { actions }),
      },
      include: {
        creator: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        }
      }
    });

    res.json({ gpt: updatedGpt });
  } catch (error) {
    console.error('Error updating GPT:', error);
    res.status(500).json({ error: 'Failed to update GPT' });
  }
});

// DELETE /api/gpts/:id - Delete GPT
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Check if GPT exists and user owns it
    const existingGpt = await prisma.customGpt.findUnique({
      where: { id }
    });

    if (!existingGpt) {
      return res.status(404).json({ error: 'GPT not found' });
    }

    if (existingGpt.creatorId !== userId) {
      return res.status(403).json({ error: 'You can only delete your own GPTs' });
    }

    await prisma.customGpt.delete({
      where: { id }
    });

    res.json({ message: 'GPT deleted successfully' });
  } catch (error) {
    console.error('Error deleting GPT:', error);
    res.status(500).json({ error: 'Failed to delete GPT' });
  }
});

// GET /api/gpts/categories - Get available categories
router.get('/categories', async (req, res) => {
  try {
    const categories = await prisma.customGpt.findMany({
      where: {
        category: {
          not: null
        },
        visibility: 'PUBLIC'
      },
      select: {
        category: true
      },
      distinct: ['category']
    });

    const categoryList = categories
      .map(c => c.category)
      .filter(Boolean)
      .sort();

    res.json({ categories: categoryList });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});


// POST /api/gpts/:id/chat - Start a new chat with a GPT
router.post('/:id/chat', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Get the GPT
    const gpt = await prisma.customGpt.findUnique({
      where: { id },
      include: {
        creator: {
          select: {
            id: true,
            name: true
          }
        },
        knowledgeFiles: true
      }
    });

    if (!gpt) {
      return res.status(404).json({ error: 'GPT not found' });
    }

    // Check access permissions
    if (gpt.creatorId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create a new chat with this GPT
    const chat = await prisma.chat.create({
      data: {
        userId,
        title: `Chat with ${gpt.name}`,
        model: gpt.modelName, // Use GPT's preferred model
        customGptId: id, // Link to the custom GPT
        messages: {
          create: gpt.greetingMessage ? [{
            role: 'ASSISTANT',
            content: gpt.greetingMessage,
            timestamp: new Date().toISOString()
          }] : []
        }
      },
      include: {
        messages: true,
        customGpt: {
          select: {
            id: true,
            name: true,
            iconUrl: true,
            instructions: true,
            greetingMessage: true,
            modelName: true,
            temperature: true,
            conversationStarters: true
          }
        }
      }
    });

    res.status(201).json({
      chat,
      // Include GPT info for frontend
      gptInfo: {
        name: gpt.name,
        iconUrl: gpt.iconUrl,
        instructions: gpt.instructions,
        conversationStarters: gpt.conversationStarters
      }
    });
  } catch (error) {
    console.error('Error creating GPT chat:', error);
    res.status(500).json({ error: 'Failed to create chat with GPT' });
  }
});
// ...existing code...

// GET /api/gpts/chat/:chatId - Get chat with custom GPT info
router.get('/chat/:chatId', authenticateToken, async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;

    const chat = await prisma.chat.findFirst({
      where: {
        id: chatId,
        userId
      },
      include: {
        customGpt: {
          select: {
            id: true,
            name: true,
            iconUrl: true,
            instructions: true,
            greetingMessage: true,
            modelName: true,
            temperature: true,
            conversationStarters: true,
            knowledgeFiles: {
              select: {
                id: true,
                originalName: true,
                extractedText: true
              }
            }
          }
        },
        messages: {
          orderBy: { timestamp: 'asc' },
          select: {
            id: true,
            role: true,
            content: true,
            timestamp: true,
            files: true
          }
        }
      }
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    res.json({
      chat,
      isCustomGpt: !!chat.customGpt,
      gptInfo: chat.customGpt ? {
        name: chat.customGpt.name,
        iconUrl: chat.customGpt.iconUrl,
        instructions: chat.customGpt.instructions,
        conversationStarters: chat.customGpt.conversationStarters,
        knowledgeBase: chat.customGpt.knowledgeFiles?.length || 0
      } : null
    });
  } catch (error) {
    console.error('Error fetching GPT chat:', error);
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

// ...existing code...
// ...existing code...
module.exports = router;
