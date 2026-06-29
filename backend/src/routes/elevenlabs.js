const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const requirePaidPlan = require('../middleware/require-paid-plan');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const FormData = require('form-data');
const { PrismaClient } = require('@prisma/client');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
const {
  contentDispositionHeader,
  resolveConfinedFile,
} = require('../middleware/file-response-safety');

const router = express.Router();
const prisma = new PrismaClient();
const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../uploads');
const audioDir = path.join(uploadRoot, 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function audioContentType(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case '.wav':
      return 'audio/wav';
    case '.m4a':
    case '.mp4':
      return 'audio/mp4';
    case '.webm':
      return 'audio/webm';
    case '.ogg':
      return 'audio/ogg';
    case '.mp3':
    case '.mpeg':
    default:
      return 'audio/mpeg';
  }
}

function generatedAudioFilename(prefix, extension = 'mp3') {
  return `${prefix}_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.${extension}`;
}

ensureDir(audioDir);

// Configure multer for audio file uploads
const upload = multer({
  dest: audioDir,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/mp3', 'audio/m4a', 'audio/webm', 'audio/ogg', 'audio/mp4'];
    console.log('Uploaded file details:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    });
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid audio file type: ${file.mimetype}. Allowed types: ${allowedTypes.join(', ')}`), false);
    }
  }
});

// ElevenLabs API configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Lazy ElevenLabs client init — instantiating at module load crashes the
// whole backend when ELEVENLABS_API_KEY is missing in dev. Defer until
// the first request actually needs it.
let elevenlabsClient = null;
function elevenlabs() {
  if (!ELEVENLABS_API_KEY) return null;
  if (!elevenlabsClient) elevenlabsClient = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
  return elevenlabsClient;
}

// Get available voices
router.get('/voices', authenticateToken, async (req, res) => {
  try {
    console.log('ElevenLabs API Key configured:', !!ELEVENLABS_API_KEY);

    if (!ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }

    console.log('Fetching voices from ElevenLabs...');
    const voices = await elevenlabs().voices.getAll();

    // ElevenLabs API might return { voices: [...] } or just [...]
    // Ensure we always return { voices: [...] } format
    const voicesArray = voices?.voices || voices || [];
    res.json({ voices: voicesArray });
  } catch (error) {
    console.error('Error fetching voices:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/models', authenticateToken, async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }
    console.log('Fetching models from ElevenLabs...');
    const models = await elevenlabs().models.list();
    console.log('Models fetched:', models?.length || 0);

    // API seedha array return karti hai, hum use object mein wrap kar rahe hain
    res.json({ models: models || [] });
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: error.message });
  }
});

// Text-to-Speech
router.post('/text-to-speech', [
  body('text').trim().notEmpty().isLength({ max: 5000 }).withMessage('Text is required (max 5000 chars)'),
  body('voice_id').optional().isString().trim().isLength({ max: 120 }),
  body('model_id').optional().isString().trim().isLength({ max: 80 }),
  body('voice_settings').optional().isObject()
], authenticateToken, requirePaidPlan({ feature: 'voice_generation' }), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }

    const {
      text,
      voice_id, // No default - must be provided by frontend
      model_id = 'eleven_monolingual_v1',
      voice_settings = {
        stability: 0.5,
        similarity_boost: 0.5,
        style: 0.0,
        use_speaker_boost: true
      }
    } = req.body;

    // Validate voice_id is provided
    if (!voice_id) {
      return res.status(400).json({ error: 'voice_id is required' });
    }

    console.log('TTS Request received:', { text: text.substring(0, 50) + '...', voice_id, model_id });

    // Generate audio using ElevenLabs client
    console.log('Calling ElevenLabs TTS API...');
    const audioStream = await elevenlabs().textToSpeech.convert(voice_id, {
      text,
      model_id,
      voice_settings
    });

    console.log('Audio stream received from ElevenLabs');

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    // Generate unique filename
    const filename = generatedAudioFilename('tts');
    const filepath = path.join(audioDir, filename);
    ensureDir(audioDir);

    // Save audio file
    fs.writeFileSync(filepath, audioBuffer);

    // Track usage
    await prisma.apiUsage.create({
      data: {
        userId: req.user.id,
        model: 'elevenlabs-tts',
        tokens: text.length,
        cost: text.length * 0.0001 // Approximate cost
      }
    });

    res.json({
      success: true,
      audio_url: `/elevenlabs/audio/${filename}`,
      filename,
      text_length: text.length
    });

  } catch (error) {
    console.error('Text-to-Speech error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Speech-to-Text (using ElevenLabs)
router.post('/speech-to-text', authenticateToken, requirePaidPlan({ feature: 'voice_transcription' }), upload.single('audio'), async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Audio file is required' });
    }

    console.log('Processing speech-to-text with ElevenLabs:', {
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path
    });

    // Check if ElevenLabs STT is actually available
    console.log('ElevenLabs API Key present:', !!ELEVENLABS_API_KEY);
    console.log('File size in MB:', (req.file.size / 1024 / 1024).toFixed(2));

    // Use the official ElevenLabs client method
    try {
      console.log('Using ElevenLabs client speechToText.convert method...');

      // Read the audio file and create a Blob (async — don't block the event
      // loop on disk I/O for the upload duration).
      const audioBuffer = await fs.promises.readFile(req.file.path);
      const audioBlob = new Blob([audioBuffer], {
        type: req.file.mimetype || 'audio/webm'
      });

      // Get parameters from request body
      const {
        model = 'scribe_v1',
        language = null,
        tagAudioEvents = true,
        diarize = false
      } = req.body;

      console.log('ElevenLabs STT parameters:', {
        modelId: model,
        languageCode: language,
        tagAudioEvents,
        diarize,
        fileType: req.file.mimetype
      });

      // Use the official ElevenLabs client method
      const transcription = await elevenlabs().speechToText.convert({
        file: audioBlob,
        modelId: model, // Only "scribe_v1" is supported currently
        tagAudioEvents: tagAudioEvents, // Tag audio events like laughter, applause, etc.
        languageCode: language, // Language code (e.g., "eng", "spa", etc.) or null for auto-detect
        diarize: diarize // Whether to annotate who is speaking
      });

      console.log('ElevenLabs STT transcription result:', transcription);

      // Clean up uploaded file
      fs.unlinkSync(req.file.path);

      // Extract text from transcription result
      let transcribedText = '';
      if (typeof transcription === 'string') {
        transcribedText = transcription;
      } else if (transcription && transcription.text) {
        transcribedText = transcription.text;
      } else if (transcription && transcription.transcript) {
        transcribedText = transcription.transcript;
      } else if (transcription && Array.isArray(transcription.segments)) {
        // If it returns segments, combine them
        transcribedText = transcription.segments.map(segment => segment.text || segment.transcript).join(' ');
      } else {
        transcribedText = 'Transcription completed successfully';
      }

      // Track usage
      await prisma.apiUsage.create({
        data: {
          userId: req.user.id,
          model: 'elevenlabs-scribe-v1',
          tokens: transcribedText.length,
          cost: 0.003 // Approximate cost
        }
      });

      return res.json({
        success: true,
        text: transcribedText,
        provider: 'elevenlabs',
        model: model,
        fullResult: transcription // Include full result for debugging
      });

    } catch (clientError) {
      console.error('ElevenLabs client STT error:', clientError);

      // Clean up uploaded file
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      // Check if it's a plan/availability issue
      if (clientError.message && (
        clientError.message.includes('not available') ||
        clientError.message.includes('plan') ||
        clientError.message.includes('subscription') ||
        clientError.message.includes('quota') ||
        clientError.message.includes('unauthorized') ||
        clientError.message.includes('forbidden')
      )) {
        // Provide helpful fallback message
        const fallbackText = 'Audio received successfully. ElevenLabs Speech-to-Text requires a compatible subscription plan.';

        // Track usage
        await prisma.apiUsage.create({
          data: {
            userId: req.user.id,
            model: 'elevenlabs-stt-unavailable',
            tokens: fallbackText.length,
            cost: 0.001
          }
        });

        return res.json({
          success: true,
          text: fallbackText,
          fallback: true,
          note: 'ElevenLabs Speech-to-Text may require a higher subscription plan.',
          error: clientError.message
        });
      }

      // For other errors, return error response
      res.status(500).json({
        error: `ElevenLabs STT error: ${clientError.message}`,
        details: clientError.toString()
      });
    }

  } catch (error) {
    console.error('Speech-to-Text error:', error);

    // Clean up file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({ error: error.message });
  }
});

// Serve audio files
router.get('/audio/:filename', (req, res) => {
  try {
    const resolved = resolveConfinedFile(audioDir, req.params.filename, {
      allowedExtensions: ['.mp3', '.mpeg', '.wav', '.m4a', '.mp4', '.webm', '.ogg'],
    });
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid audio filename' });
    }

    if (!fs.existsSync(resolved.filePath)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }
    const stat = fs.statSync(resolved.filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    res.setHeader('Content-Type', audioContentType(resolved.filename));
    res.setHeader('Content-Disposition', contentDispositionHeader('inline', resolved.filename));
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(resolved.filePath);
    stream.on('error', (err) => {
      console.error('Error streaming audio file:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error streaming audio file' });
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);

  } catch (error) {
    console.error('Error serving audio file:', error);
    res.status(500).json({ error: 'Error serving audio file' });
  }
});

// Get voice settings for a specific voice
router.get('/voices/:voice_id/settings', authenticateToken, async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }

    const { voice_id } = req.params;
    const voice = await elevenlabs().voices.get(voice_id);

    res.json(voice.settings || {
      stability: 0.5,
      similarity_boost: 0.5,
      style: 0.0,
      use_speaker_boost: true
    });
  } catch (error) {
    console.error('Error fetching voice settings:', error);
    res.status(500).json({ error: error.message });
  }
});



// Test ElevenLabs STT availability
router.get('/test-stt', authenticateToken, async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }

    // Test if STT endpoint exists
    const testResponse = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'OPTIONS',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      signal: AbortSignal.timeout(Number(process.env.ELEVENLABS_TIMEOUT_MS) || 30000),
    });

    console.log('ElevenLabs STT test response:', testResponse.status, testResponse.statusText);

    res.json({
      sttAvailable: testResponse.status !== 404,
      status: testResponse.status,
      statusText: testResponse.statusText,
      headers: Object.fromEntries(testResponse.headers.entries())
    });
  } catch (error) {
    console.error('Error testing STT:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user's subscription info
router.get('/user/subscription', authenticateToken, async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }

    const subscriptionResponse = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(Number(process.env.ELEVENLABS_TIMEOUT_MS) || 30000),
    });

    const subscription = await subscriptionResponse.json().catch(() => ({}));
    if (!subscriptionResponse.ok) {
      return res.status(subscriptionResponse.status).json({
        error: subscription?.detail || subscription?.message || 'Failed to fetch ElevenLabs subscription',
      });
    }

    res.json(subscription);
  } catch (error) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ error: error.message });
  }
});
// ...existing code...

// Music Generation using ElevenLabs
router.post('/generate-music', [
  body('text').trim().notEmpty().isLength({ max: 2000 }).withMessage('Text prompt is required (max 2000 chars)'),
  body('duration').optional().isInt({ min: 1, max: 300 }).toInt().withMessage('Duration must be an integer between 1 and 300 seconds'),
  body('model_id').optional().isString().trim().isLength({ max: 80 }),
  body('output_format').optional().isString().trim().isLength({ max: 40 }),
], authenticateToken, requirePaidPlan({ feature: 'music_generation' }), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!ELEVENLABS_API_KEY) {
      return res.status(400).json({ error: 'ElevenLabs API key not configured' });
    }

    const {
      text,
      duration: rawDuration = 10, // Default 10 seconds
      // prompt_influence = 0.3, // Default prompt influence
      // normalize_output = true
      output_format = 'mp3_44100_128',
      model_id = 'music_v1'
    } = req.body;
    // Defense-in-depth: clamp the duration (1–300s) even if validation is
    // bypassed, so a bad value can never inflate the ElevenLabs request length
    // or the billed cost row below.
    const duration = Math.min(300, Math.max(1, Math.round(Number(rawDuration) || 10)));

    console.log('Music generation request received:', {
      text: text.substring(0, 50) + '...',
      duration,
    });

    // Generate music using ElevenLabs Music API
    console.log('Calling ElevenLabs Music Generation API...');

    const musicResponse = await fetch('https://api.elevenlabs.io/v1/music', {
      method: 'POST',
      // Music generation is slower than the probes — give it a larger budget.
      signal: AbortSignal.timeout(Number(process.env.ELEVENLABS_MUSIC_TIMEOUT_MS) || 120000),
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      // body: JSON.stringify({
      //   text,
      //   duration_seconds: duration,
      //   prompt_influence,
      //   normalize_output
      // })
      body: JSON.stringify({
        prompt: text,
        music_length_ms: duration * 1000,  // convert seconds → ms
        model_id,
        output_format
      })
    });

    if (!musicResponse.ok) {
      const errorData = await musicResponse.text();
      console.error('ElevenLabs Music API error:', musicResponse.status, errorData);

      if (musicResponse.status === 402) {
        return res.status(402).json({
          error: 'Insufficient credits for music generation. Please upgrade your ElevenLabs subscription.'
        });
      } else if (musicResponse.status === 400) {
        return res.status(400).json({
          error: 'Invalid music generation parameters. Please check your input.'
        });
      } else {
        return res.status(musicResponse.status).json({
          error: `Music generation failed: ${errorData}`
        });
      }
    }

    console.log('Music generated successfully from ElevenLabs');

    // Get the audio buffer from response
    const audioBuffer = await musicResponse.arrayBuffer();
    const musicBuffer = Buffer.from(audioBuffer);

    // Generate unique filename
    const filename = generatedAudioFilename('music');
    const filepath = path.join(audioDir, filename);
    ensureDir(audioDir);

    // Save music file
    fs.writeFileSync(filepath, musicBuffer);

    // Track usage
    await prisma.apiUsage.create({
      data: {
        userId: req.user.id,
        model: 'elevenlabs-music',
        tokens: text.length,
        cost: duration * 0.01 // Approximate cost per second
      }
    });

    res.json({
      success: true,
      audio_url: `/elevenlabs/audio/${filename}`,
      filename,
      duration: duration,
      text_prompt: text,
      // prompt_influence: prompt_influence
    });

  } catch (error) {
    console.error('Music generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get available music styles/genres (placeholder for future enhancement)
router.get('/music-styles', authenticateToken, async (req, res) => {
  try {
    // For now, return predefined styles. In future, this could be dynamic from ElevenLabs
    const styles = [
      { id: 'ambient', name: 'Ambient', description: 'Atmospheric and peaceful sounds' },
      { id: 'electronic', name: 'Electronic', description: 'Synthesized and digital sounds' },
      { id: 'classical', name: 'Classical', description: 'Orchestral and traditional instruments' },
      { id: 'jazz', name: 'Jazz', description: 'Smooth and improvised melodies' },
      { id: 'rock', name: 'Rock', description: 'Energetic and guitar-driven' },
      { id: 'pop', name: 'Pop', description: 'Catchy and mainstream melodies' },
      { id: 'cinematic', name: 'Cinematic', description: 'Epic and dramatic soundscapes' },
      { id: 'nature', name: 'Nature', description: 'Natural sounds and environments' }
    ];

    res.json({ styles });
  } catch (error) {
    console.error('Error fetching music styles:', error);
    res.status(500).json({ error: error.message });
  }
});

// ...existing code...


module.exports = router;
