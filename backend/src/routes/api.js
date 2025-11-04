const express = require('express');
const { OpenAI } = require('openai');

const router = express.Router();

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Route to handle chat completions
router.post('/chat/completions', async (req, res) => {
    try {
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
router.post('/images/generations', async (req, res) => {
    try {
        const { model, prompt, n, size } = req.body;

        const image = await openai.images.generate({
            model,
            prompt,
            n,
            size,
        });

        res.json(image);
    } catch (error) {
        console.error('Error proxying to OpenAI for image generation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
