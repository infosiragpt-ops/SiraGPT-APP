const express = require('express');
const { OpenAI } = require('openai');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const requirePaidPlan = require('../middleware/require-paid-plan');
const imageEngine = require('../services/media/image-engine');

const router = express.Router();

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

function sendValidationErrors(req, res) {
    const errors = validationResult(req);
    if (errors.isEmpty()) return false;
    res.status(400).json({ errors: errors.array() });
    return true;
}

function aspectRatioFromLegacySize(size) {
    const match = String(size || '').trim().match(/^(\d{3,5})x(\d{3,5})$/);
    if (!match) return '1:1';
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width === height) return '1:1';
    return width > height ? '16:9' : '3:4';
}

// Route to handle chat completions
router.post(
  '/chat/completions',
  authenticateToken,
  [
    body('model').trim().notEmpty().isLength({ max: 200 }),
    body('messages').isArray({ min: 1, max: 100 }),
    body('messages').custom((messages) => {
      const bytes = Buffer.byteLength(JSON.stringify(messages || []), 'utf8');
      if (bytes > 20000) throw new Error('messages payload is too large');
      return true;
    }),
    body('max_tokens').optional().isInt({ min: 1, max: 200000 }),
  ],
  async (req, res) => {
    try {
        if (sendValidationErrors(req, res)) return;
        const { model, messages, max_tokens } = req.body;

        try {
            // Attempt to generate a completion with the primary provider
            const completion = await openai.chat.completions.create({
                model,
                messages,
                max_tokens,
            });

            return res.json(completion);
        } catch (primaryError) {
            console.error('Primary provider failed:', primaryError);

            // Fallback to Gemini provider with gemini-2.5-pro model
            console.log('Falling back to Gemini provider...');
            const fallbackOpenAI = new OpenAI({
                apiKey: process.env.GEMINI_API_KEY,
                baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
            });

            const fallbackCompletion = await fallbackOpenAI.chat.completions.create({
                model: "gemini-2.5-pro",
                messages,
                max_tokens,
            });

            return res.json(fallbackCompletion);
        }
    } catch (error) {
        console.error('Error proxying to OpenAI:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Route to handle image generations
router.post(
  '/images/generations',
  authenticateToken,
  [
    body('model').optional().trim().isLength({ max: 200 }),
    body('prompt').trim().notEmpty().isLength({ max: 4000 }),
    body('n').optional().isInt({ min: 1, max: 4 }).toInt(),
    body('size').optional().matches(/^\d{3,5}x\d{3,5}$/),
  ],
  requirePaidPlan({ feature: 'image_generation' }),
  async (req, res) => {
    try {
        if (sendValidationErrors(req, res)) return;
        const { model, prompt, n, size } = req.body;

        const result = await imageEngine.generateImage({
            prompt,
            model,
            n: n || 1,
            aspectRatio: aspectRatioFromLegacySize(size),
            failover: true,
        });

        if (!result.ok || !result.images?.length) {
            return res.status(result.code === 'NO_PROVIDER' ? 503 : 502).json({
                error: result.error || 'Image generation failed',
                code: result.code || 'image_generation_failed',
            });
        }

        res.json({
            created: Math.floor(Date.now() / 1000),
            provider: result.provider,
            model: result.model,
            data: result.images.map((image) => ({ b64_json: image.b64 })),
        });
    } catch (error) {
        console.error('Error proxying to OpenAI for image generation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
