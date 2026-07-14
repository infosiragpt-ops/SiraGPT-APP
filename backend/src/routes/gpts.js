const express = require('express');
const fs = require('fs').promises;
const { constants: fsConstants } = require('fs');
const path = require('path');
const { authenticateToken } = require('../middleware/auth');
const upload = require('../middleware/upload');
const fileProcessor = require('../services/fileProcessor');
const { validateUploadPolicy } = require('../services/upload-security-policy');
const {
  createCerebrasClient,
  getCerebrasConfig,
} = require('../services/ai/cerebras-client');
const gptActions = require('../services/gpts/gpt-actions');
const { mergeCustomGptCapabilities } = require('../services/agents/custom-gpt-agent-policy');

const router = express.Router();
const prisma = require('../config/database');
const PUBLIC_GPT_ICON_PREFIX = 'gpt-icons';
const PUBLIC_GPT_VISIBILITIES = new Set(['PUBLIC', 'UNLISTED']);

function publicGptIconsDir(uploadRoot = upload.uploadDir) {
  return path.join(path.resolve(uploadRoot || 'uploads'), PUBLIC_GPT_ICON_PREFIX);
}

function parseUserScopedUploadIconUrl(iconUrl) {
  const raw = String(iconUrl || '').trim();
  if (!raw.startsWith('/uploads/')) return null;

  const parts = raw
    .replace(/^\/uploads\/+/, '')
    .split('/')
    .filter(Boolean);

  if (parts.length !== 2) return null;
  const [userId, filename] = parts;
  if (userId === PUBLIC_GPT_ICON_PREFIX) return null;
  if (!upload.safeStorageSegment(userId) || !upload.safeStorageSegment(filename)) return null;

  return { userId, filename };
}

function safePublicIconFilename({ gptId, sourceFilename }) {
  const base = path.basename(String(sourceFilename || 'icon'));
  const ext = path.extname(base).toLowerCase();
  const stem = path.basename(base, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'icon';
  const safeGptId = upload.safeStorageSegment(gptId) || 'gpt';
  return `${safeGptId}-${stem}${ext}`;
}

async function moveFileAcrossDevices(sourcePath, destinationPath) {
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await fs.copyFile(sourcePath, destinationPath);
    await fs.unlink(sourcePath).catch(() => {});
  }
}

async function publicizeGptIconUrl({
  iconUrl,
  visibility,
  gptId,
  sourcePath,
  moveSource = false,
  uploadRoot = upload.uploadDir,
}) {
  if (!PUBLIC_GPT_VISIBILITIES.has(visibility)) {
    return { iconUrl, changed: false };
  }

  const parsed = parseUserScopedUploadIconUrl(iconUrl);
  if (!parsed) return { iconUrl, changed: false };

  const root = path.resolve(uploadRoot || 'uploads');
  const source = sourcePath
    ? path.resolve(sourcePath)
    : path.join(root, parsed.userId, parsed.filename);
  const relativeSource = path.relative(root, source);
  if (!relativeSource || relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) {
    return { iconUrl, changed: false };
  }

  const publicDir = publicGptIconsDir(root);
  await fs.mkdir(publicDir, { recursive: true });
  const destinationFilename = safePublicIconFilename({
    gptId,
    sourceFilename: parsed.filename,
  });
  const destination = path.join(publicDir, destinationFilename);

  try {
    await fs.access(source, fsConstants.R_OK);
  } catch {
    return { iconUrl, changed: false };
  }

  if (moveSource) {
    await moveFileAcrossDevices(source, destination);
  } else {
    await fs.copyFile(source, destination);
  }

  return {
    iconUrl: `/uploads/${PUBLIC_GPT_ICON_PREFIX}/${destinationFilename}`,
    changed: true,
  };
}

async function ensurePublicGptIcon(gpt, options = {}) {
  if (!gpt?.id) return gpt;
  const result = await publicizeGptIconUrl({
    iconUrl: gpt.iconUrl,
    visibility: gpt.visibility,
    gptId: gpt.id,
    ...options,
  });

  if (!result.changed || result.iconUrl === gpt.iconUrl) return gpt;

  try {
    await prisma.customGpt.update({
      where: { id: gpt.id },
      data: { iconUrl: result.iconUrl },
    });
  } catch (error) {
    console.warn('Failed to update GPT public icon URL:', error.message);
  }

  return { ...gpt, iconUrl: result.iconUrl };
}

// Return a GPT object safe to send to the client: its Actions never expose the
// encrypted auth secret (redactActionsForClient → auth.hasSecret boolean only).
function withRedactedActions(gpt) {
  if (!gpt || typeof gpt !== 'object') return gpt;
  const out = { ...gpt };
  if (out.actions != null) out.actions = gptActions.redactActionsForClient(out.actions);
  // Knowledge files must NEVER expose path/userId/openaiFileId/extractedText to
  // a client — the detail/share/chat routes returned the raw relation, leaking a
  // GPT's full knowledge-base contents (incl. extracted text) to non-owners.
  // Project through the same client-safe view the owner list route uses.
  if (Array.isArray(out.knowledgeFiles)) out.knowledgeFiles = out.knowledgeFiles.map(knowledgeFileView);
  return out;
}

// ─── Live draft preview ────────────────────────────────────────────────────
// Bounds for POST /preview-chat: a persona-faithful "try before you save"
// completion against the DRAFT config (never persisted, no knowledge/tools,
// no credits — runs on the free FlashGPT/Cerebras model). Kept deliberately
// small so a preview turn can never balloon the prompt or the latency budget.
const PREVIEW_INSTRUCTIONS_MAX = 50000;
const PREVIEW_NAME_MAX = 100;
const PREVIEW_MAX_MESSAGES = 24;
const PREVIEW_MSG_MAX_CHARS = 8000;
const PREVIEW_LLM_TIMEOUT_MS = Number.parseInt(
  process.env.SIRAGPT_GPT_PREVIEW_TIMEOUT_MS || '30000',
  10,
);

// ─── Knowledge-file helpers ────────────────────────────────────────────────
// Mirror the minimal, self-contained shape of routes/files.js. We deliberately
// do NOT import its non-exported processFilesInParallel; we replicate just the
// pieces needed to link an uploaded file to a custom GPT (DB record + best-effort
// text extraction). Heavy extras (OpenAI Files, thumbnails, R2 offload, RAG
// scheduling) are intentionally omitted — the inline knowledge-manifest excerpt
// in master-prompt.js makes extractedText sufficient on its own.

// Max knowledge files accepted per upload request.
const KNOWLEDGE_UPLOAD_MAX_FILES = 10;

// Bound the extraction step so a pathological document can never consume the
// whole HTTP response budget (~30s proxy cut). On timeout the file still links
// with extractedText: null. Same intent as files.js withTimeout.
const KNOWLEDGE_EXTRACT_TIMEOUT_MS = Number.parseInt(
  process.env.SIRAGPT_EXTRACT_TIMEOUT_MS || '20000',
  10,
);

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label || 'operation'} timed out after ${ms}ms`);
      err.code = 'step_timeout';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function unlinkQuiet(p) {
  try { await fs.unlink(p); } catch (_) { /* already gone */ }
}

// Shape a File row for the API response — only safe, public-facing fields.
// Never leaks path, userId, or openaiFileId.
function knowledgeFileView(file) {
  const extractedChars = typeof file.extractedText === 'string'
    ? file.extractedText.length
    : 0;
  return {
    id: file.id,
    originalName: file.originalName,
    size: file.size,
    mimeType: file.mimeType,
    extractedChars,
  };
}

// GET /api/gpts - Get all public GPTs + user's private GPTs
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { category, search, featured, visibility = 'all' } = req.query;

    const andClauses = [];

    if (visibility === 'mine' && userId) {
      andClauses.push({ creatorId: userId });
    } else if (visibility === 'public') {
      andClauses.push({ visibility: 'PUBLIC' });
    } else {
      andClauses.push({
        OR: [
          { visibility: 'PUBLIC' },
          ...(userId ? [{ creatorId: userId }] : [])
        ]
      });
    }

    if (category && category !== 'All') {
      andClauses.push({ category });
    }

    if (search && search.trim()) {
      const searchTerm = search.trim();
      andClauses.push({
        OR: [
          { name: { contains: searchTerm, mode: 'insensitive' } },
          { description: { contains: searchTerm, mode: 'insensitive' } },
          { instructions: { contains: searchTerm, mode: 'insensitive' } }
        ]
      });
    }

    if (featured === 'true') {
      andClauses.push({ isFeatured: true });
    }

    // Never surface soft-deleted GPTs (e.g. tombstoned by the GDPR account-delete
    // cascade) — they must disappear from both public and owner listings.
    andClauses.push({ deletedAt: null });
    const whereClause = andClauses.length > 1 ? { AND: andClauses } : andClauses[0] || {};

    if (process.env.NODE_ENV !== 'production' && process.env.SIRAGPT_DEBUG_GPTS === '1') {
      console.log('GPT Query WHERE clause:', JSON.stringify(whereClause, null, 2));
    }

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

    // Transform the data to match frontend expectations. Public/unlisted GPT
    // avatars uploaded before the public icon folder existed are copied lazily
    // so public listings do not depend on user-scoped upload auth.
    const transformedGpts = await Promise.all(gpts.map(async (gpt) => {
      const hydratedGpt = await ensurePublicGptIcon(gpt);
      return {
        ...withRedactedActions(hydratedGpt),
        _count: {
          conversations: gpt._count.chats,
          files: gpt._count.knowledgeFiles
        }
      };
    }));

    res.json({ gpts: transformedGpts });
  } catch (error) {
    console.error('Error fetching GPTs:', error);
    res.status(500).json({ error: 'Failed to fetch GPTs' });
  }
});

// GET /api/gpts/categories - Get available categories
// Keep this before /:id so "categories" is not treated as a GPT id.
router.get('/categories', async (req, res) => {
  try {
    const categories = await prisma.customGpt.findMany({
      where: {
        category: {
          not: null
        },
        visibility: 'PUBLIC',
        deletedAt: null // exclude soft-deleted GPTs so dead rows can't ghost a category
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

    res.json({ gpt: withRedactedActions(await ensurePublicGptIcon(gpt)) });
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

    res.json({ gpt: withRedactedActions(await ensurePublicGptIcon(gpt)) });
  } catch (error) {
    console.error('Error fetching shared GPT:', error);
    res.status(500).json({ error: 'Failed to fetch shared GPT' });
  }
});

// POST /api/gpts - Create new GPT
router.post('/', authenticateToken, upload.single('icon'), async (req, res) => {
  try {
    const userId = req.user.id;
    // Malformed/missing `gpts` is a client error (400), not a 500 — the bare
    // JSON.parse(undefined)/invalid-JSON throw used to land in the outer catch.
    if (typeof req.body.gpts !== 'string') {
      return res.status(400).json({ error: 'gpts field is required (JSON string)' });
    }
    let gptData;
    try {
      gptData = JSON.parse(req.body.gpts);
    } catch {
      return res.status(400).json({ error: 'gpts must be valid JSON' });
    }
    const {
      name,
      description,
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
    } = gptData;

    let iconUrl = gptData.iconUrl;
    if (req.file) {
      iconUrl = `/uploads/${req.user.id}/${req.file.filename}`;
    }

    // Type guards — the parsed `gpts` blob is untrusted; a non-string field
    // would throw on .trim() or write a malformed row to Prisma.
    if (typeof name !== 'string' || typeof instructions !== 'string') {
      return res.status(400).json({ error: 'name and instructions must be strings' });
    }
    for (const [k, v] of [['description', description], ['greetingMessage', greetingMessage], ['modelName', modelName], ['category', category]]) {
      if (v != null && typeof v !== 'string') return res.status(400).json({ error: `${k} must be a string` });
    }
    if (visibility != null && !['PRIVATE', 'UNLISTED', 'PUBLIC'].includes(String(visibility))) {
      return res.status(400).json({ error: 'invalid visibility' });
    }
    // Numeric guards — temperature/maxTokens come from the untrusted blob and
    // are written straight to the Float/Int columns; reject NaN / out-of-range.
    if (temperature != null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      return res.status(400).json({ error: 'temperature must be a number between 0 and 2' });
    }
    if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
      return res.status(400).json({ error: 'maxTokens must be a positive integer' });
    }

    // Validation
    if (!name || !instructions) {
      return res.status(400).json({ error: 'Name and instructions are required' });
    }

    if (name.length > 100) {
      return res.status(400).json({ error: 'Name must be 100 characters or less' });
    }

    if (instructions.length > 50000) {
      return res.status(400).json({ error: 'Instructions must be 50000 characters or less' });
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
        actions: gptActions.normalizeActionsForStore(actions, []),
        capabilities: capabilities === undefined
          ? null
          : mergeCustomGptCapabilities(null, capabilities),
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

    const responseGpt = await ensurePublicGptIcon(gpt, {
      sourcePath: req.file?.path,
      moveSource: Boolean(req.file),
    });

    res.status(201).json({ gpt: withRedactedActions(responseGpt) });
  } catch (error) {
    console.error('Error creating GPT:', error);
    res.status(500).json({ error: 'Failed to create GPT' });
  }
});

// PUT /api/gpts/:id - Update GPT
router.put('/:id', authenticateToken, upload.single('icon'), async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    // Malformed/missing `gpts` is a client error (400), not a 500 — the bare
    // JSON.parse(undefined)/invalid-JSON throw used to land in the outer catch.
    if (typeof req.body.gpts !== 'string') {
      return res.status(400).json({ error: 'gpts field is required (JSON string)' });
    }
    let gptData;
    try {
      gptData = JSON.parse(req.body.gpts);
    } catch {
      return res.status(400).json({ error: 'gpts must be valid JSON' });
    }
    const {
      name,
      description,
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
    } = gptData;

    let iconUrl = gptData.iconUrl;
    if (req.file) {
      iconUrl = `/uploads/${req.user.id}/${req.file.filename}`;
    }

    // Type guards — partial update, so each field is optional, but if present
    // it must be the right type (the parsed blob is untrusted).
    for (const [k, v] of [['name', name], ['instructions', instructions], ['description', description], ['greetingMessage', greetingMessage], ['modelName', modelName], ['category', category]]) {
      if (v != null && typeof v !== 'string') return res.status(400).json({ error: `${k} must be a string` });
    }
    if (visibility != null && !['PRIVATE', 'UNLISTED', 'PUBLIC'].includes(String(visibility))) {
      return res.status(400).json({ error: 'invalid visibility' });
    }
    // Numeric guards — reject NaN / out-of-range before the Prisma update.
    if (temperature != null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      return res.status(400).json({ error: 'temperature must be a number between 0 and 2' });
    }
    if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
      return res.status(400).json({ error: 'maxTokens must be a positive integer' });
    }

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

    if (instructions && instructions.length > 50000) {
      return res.status(400).json({ error: 'Instructions must be 50000 characters or less' });
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
        ...(actions !== undefined && {
          actions: gptActions.normalizeActionsForStore(actions, existingGpt.actions || []),
        }),
        ...(capabilities !== undefined && {
          capabilities: mergeCustomGptCapabilities(existingGpt.capabilities, capabilities),
        }),
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

    const responseGpt = await ensurePublicGptIcon(updatedGpt, {
      sourcePath: req.file?.path,
      moveSource: Boolean(req.file),
    });

    res.json({ gpt: withRedactedActions(responseGpt) });
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
    if (gpt.visibility === 'PRIVATE' && gpt.creatorId !== userId) {
      return res.status(403).json({ error: 'Access denied. This GPT is private.' });
    }

    const hydratedGpt = await ensurePublicGptIcon(gpt);

    // Create a new chat with this GPT
    const chat = await prisma.chat.create({
      data: {
        userId,
        title: `Chat with ${hydratedGpt.name}`,
        model: hydratedGpt.modelName, // Use GPT's preferred model
        customGptId: id, // Link to the custom GPT
        messages: {
          create: hydratedGpt.greetingMessage ? [{
            role: 'ASSISTANT',
            content: hydratedGpt.greetingMessage,
            timestamp: new Date().toISOString()
          }] : []
        }
      },
      include: {
        messages: true,
        customGpt: {
          select: {
            id: true,
            creatorId: true,
            name: true,
            description: true,
            iconUrl: true,
            instructions: true,
            greetingMessage: true,
            modelName: true,
            temperature: true,
            conversationStarters: true,
            visibility: true,
            shareId: true
          }
        }
      }
    });

    res.status(201).json({
      chat,
      // Include GPT info for frontend
      gptInfo: {
        name: hydratedGpt.name,
        iconUrl: hydratedGpt.iconUrl,
        instructions: hydratedGpt.instructions,
        conversationStarters: hydratedGpt.conversationStarters
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
            creatorId: true,
            name: true,
            description: true,
            iconUrl: true,
            instructions: true,
            greetingMessage: true,
            modelName: true,
            temperature: true,
            conversationStarters: true,
            visibility: true,
            shareId: true,
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

// ─── Knowledge files (Conocimientos v1) ────────────────────────────────────

// GET /api/gpts/:id/knowledge - List a GPT's knowledge files (owner only)
router.get('/:id/knowledge', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const gpt = await prisma.customGpt.findFirst({
      where: { id: req.params.id, creatorId: userId },
      include: { knowledgeFiles: true },
    });

    if (!gpt) {
      return res.status(404).json({ error: 'GPT not found' });
    }

    res.json({ files: (gpt.knowledgeFiles || []).map(knowledgeFileView) });
  } catch (error) {
    console.error('Error listing GPT knowledge files:', error);
    res.status(500).json({ error: 'Failed to list knowledge files' });
  }
});

// POST /api/gpts/:id/knowledge - Upload knowledge files for a GPT (owner only)
router.post(
  '/:id/knowledge',
  authenticateToken,
  upload.array('files', KNOWLEDGE_UPLOAD_MAX_FILES),
  async (req, res) => {
    const userId = req.user.id;

    // Ownership check FIRST, before touching any uploaded bytes.
    const gpt = await prisma.customGpt.findFirst({
      where: { id: req.params.id, creatorId: userId },
    });

    if (!gpt) {
      // Clean up any multer-saved temp files so we don't leak disk on a
      // rejected (non-owned / non-existent) GPT.
      for (const f of req.files || []) await unlinkQuiet(f.path);
      return res.status(404).json({ error: 'GPT not found' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    try {
      // Process files sequentially — knowledge uploads are small (≤10 files)
      // and this keeps the handler simple and the DB pool calm.
      for (const file of req.files) {
        // Validate the declared vs detected mime against the upload policy.
        // multer already gate-checked the declared mime; this is defence in
        // depth using the same policy files.js enforces.
        const policy = validateUploadPolicy({
          originalName: file.originalname,
          declaredMime: file.mimetype,
          detectedMime: file.mimetype,
          detectionSource: 'fallback',
          size: file.size,
        });
        if (!policy.ok) {
          await unlinkQuiet(file.path);
          continue; // skip disallowed file; do not fail the whole upload
        }
        if (policy.mimeType && policy.mimeType !== file.mimetype) {
          file.mimetype = policy.mimeType;
        }

        // Create the File row linked to this GPT (same fields as files.js
        // processFilesInParallel, plus customGptId).
        let fileRecord;
        try {
          fileRecord = await prisma.file.create({
            data: {
              userId,
              filename: file.filename,
              originalName: file.originalname,
              mimeType: file.mimetype,
              size: file.size,
              path: file.path,
              extractedText: null,
              openaiFileId: null,
              customGptId: gpt.id,
              processingStage: 'uploaded',
              processingStageAt: new Date(),
            },
          });
        } catch (createError) {
          console.error('[gpts] could not create knowledge File row:', createError.message || createError);
          await unlinkQuiet(file.path);
          continue;
        }

        // Best-effort text extraction. A parser failure must NEVER fail the
        // whole upload — the file links with extractedText: null.
        let extractedText = null;
        try {
          const result = await withTimeout(
            fileProcessor.processFile(file),
            KNOWLEDGE_EXTRACT_TIMEOUT_MS,
            `knowledge extraction (${file.originalname})`,
          );
          extractedText = result && typeof result.extractedText === 'string'
            ? result.extractedText
            : null;
        } catch (extractErr) {
          console.warn(`[gpts] knowledge extraction failed for ${file.originalname} — file still linked:`, extractErr?.message || extractErr);
        }

        try {
          await prisma.file.update({
            where: { id: fileRecord.id },
            data: { extractedText, mimeType: file.mimetype, processingStage: 'ready', processingStageAt: new Date() },
          });
        } catch (updateErr) {
          console.warn('[gpts] knowledge File update failed:', updateErr?.message || updateErr);
        }
      }

      // Return the GPT's full, current knowledge file list.
      const files = await prisma.file.findMany({
        where: { customGptId: gpt.id, userId },
        orderBy: { createdAt: 'asc' },
      });
      res.json({ files: files.map(knowledgeFileView) });
    } catch (error) {
      console.error('Error uploading GPT knowledge files:', error);
      res.status(500).json({ error: 'Failed to upload knowledge files' });
    }
  },
);

// DELETE /api/gpts/:id/knowledge/:fileId - Remove a knowledge file (owner only)
router.delete('/:id/knowledge/:fileId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Ownership check on the GPT.
    const gpt = await prisma.customGpt.findFirst({
      where: { id: req.params.id, creatorId: userId },
    });
    if (!gpt) {
      return res.status(404).json({ error: 'GPT not found' });
    }

    // Only delete a File that belongs to THIS GPT AND THIS user. Triple-scoped
    // so a forged fileId from another GPT/user cannot be deleted.
    const file = await prisma.file.findFirst({
      where: { id: req.params.fileId, customGptId: gpt.id, userId },
    });
    if (!file) {
      return res.status(404).json({ error: 'Knowledge file not found' });
    }

    await prisma.file.delete({ where: { id: file.id } });
    await unlinkQuiet(file.path);

    res.json({ message: 'Knowledge file removed', fileId: file.id });
  } catch (error) {
    console.error('Error deleting GPT knowledge file:', error);
    res.status(500).json({ error: 'Failed to delete knowledge file' });
  }
});

// ─── Helpers: live draft preview ───────────────────────────────────────────
// Build a persona-faithful system prompt from the unsaved draft. NUL-stripped
// and length-capped so a malicious/huge draft can never blow the prompt.
function buildPreviewSystemPrompt({ name, instructions } = {}) {
  const cleanName = String(name || '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, PREVIEW_NAME_MAX);
  const cleanInstructions = String(instructions || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, PREVIEW_INSTRUCTIONS_MAX);
  const header = cleanName
    ? `Eres "${cleanName}", un GPT personalizado creado en SiraGPT.`
    : 'Eres un GPT personalizado creado en SiraGPT.';
  return [
    header,
    '',
    'Sigue estas instrucciones del creador al pie de la letra:',
    cleanInstructions ||
      '(El creador aún no escribió instrucciones; compórtate como un asistente útil y conciso.)',
    '',
    'Esto es una VISTA PREVIA del borrador. Responde en el idioma del usuario, de forma natural y directa, como lo haría el GPT ya publicado.',
  ].join('\n');
}

// Sanitise the incoming conversation: cap count, validate roles, cap length,
// drop empties. Returns a clean [{role:'user'|'assistant', content}] array.
function sanitizePreviewMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw.slice(-PREVIEW_MAX_MESSAGES)) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = String(m.content == null ? '' : m.content)
      .replace(/\u0000/g, '')
      .slice(0, PREVIEW_MSG_MAX_CHARS)
      .trim();
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

// Resolve an OpenAI-compatible client for the preview. Prefers the free
// FlashGPT/Cerebras model; falls back to a configured provider (OpenAI →
// OpenRouter) so the preview always works even where Cerebras isn't wired into
// the backend env (prod resolves the free model through a different path).
// Override the fallback model with SIRAGPT_GPT_PREVIEW_FALLBACK_MODEL.
function resolvePreviewClient() {
  const cerebras = createCerebrasClient();
  if (cerebras) {
    const cfg = getCerebrasConfig();
    return { client: cerebras, model: cfg.model, displayName: cfg.displayName };
  }
  let OpenAI;
  try {
    OpenAI = require('openai');
  } catch (_) {
    return null;
  }
  const fallbackModel = process.env.SIRAGPT_GPT_PREVIEW_FALLBACK_MODEL;
  if (process.env.OPENAI_API_KEY) {
    return {
      client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
      model: fallbackModel || 'gpt-4o-mini',
      displayName: 'Vista previa',
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      client: new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' }),
      model: fallbackModel || 'openai/gpt-4o-mini',
      displayName: 'Vista previa',
    };
  }
  return null;
}

// POST /api/gpts/preview-chat — chat with the DRAFT GPT before it is saved.
// Stateless: nothing is persisted. Prefers the free FlashGPT model; falls back
// to a configured provider (no tools, no knowledge) — a fast persona "try".
router.post('/preview-chat', authenticateToken, async (req, res) => {
  try {
    const body = req.body || {};
    const messages = sanitizePreviewMessages(body.messages);
    if (messages.length === 0) {
      return res.status(400).json({ error: 'At least one user message is required' });
    }
    if (messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'The last message must be from the user' });
    }

    const picked = resolvePreviewClient();
    if (!picked) {
      return res.status(503).json({
        error: 'preview_unavailable',
        message: 'La vista previa no está disponible en este momento.',
      });
    }
    const { client, model: previewModel, displayName: previewDisplayName } = picked;

    const systemPrompt = buildPreviewSystemPrompt({
      name: body.name,
      instructions: body.instructions,
    });
    const temperature = Number.isFinite(Number(body.temperature))
      ? Math.min(1, Math.max(0, Number(body.temperature)))
      : 0.7;

    const completion = await withTimeout(
      client.chat.completions.create({
        model: previewModel,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature,
        max_tokens: 1024,
      }),
      PREVIEW_LLM_TIMEOUT_MS,
      'preview_chat',
    );

    const reply =
      (completion &&
        completion.choices &&
        completion.choices[0] &&
        completion.choices[0].message &&
        completion.choices[0].message.content) ||
      '';

    return res.json({
      reply: String(reply).trim(),
      model: previewModel,
      displayName: previewDisplayName,
    });
  } catch (error) {
    if (error && error.code === 'step_timeout') {
      return res
        .status(504)
        .json({ error: 'preview_timeout', message: 'La vista previa tardó demasiado. Inténtalo de nuevo.' });
    }
    console.error('Error in GPT preview chat:', error && error.message ? error.message : error);
    return res.status(500).json({ error: 'Failed to generate preview response' });
  }
});

router._internal = {
  PUBLIC_GPT_ICON_PREFIX,
  parseUserScopedUploadIconUrl,
  publicGptIconsDir,
  publicizeGptIconUrl,
  safePublicIconFilename,
};

module.exports = router;
