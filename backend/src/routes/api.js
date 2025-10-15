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

        const completion = await openai.chat.completions.create({
            model,
            messages,
            max_tokens,
        });

        res.json(completion);
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
