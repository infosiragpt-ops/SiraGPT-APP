const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { fal } = require('@fal-ai/client');
const router = express.Router();
const prisma = new PrismaClient();

// Configure Fal.ai client
fal.config({
  credentials: process.env.FAL_KEY, // Your Fal.ai API key
});

// Store active operations
const activeOperations = new Map();

// Helper function to generate operation ID
function generateOperationId() {
  return `veo3_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// Enhanced video generation with Fal.ai
router.post('/generate', [
  body('prompt').trim().notEmpty().withMessage('Video prompt is required'),
  body('aspect_ratio').optional().isIn(['16:9', '9:16', '1:1']).withMessage('Invalid aspect ratio'),
  body('negative_prompt').optional().isString().withMessage('Negative prompt must be a string')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!process.env.FAL_KEY) {
      return res.status(400).json({ error: 'Fal.ai API key not configured' });
    }

    const {
      prompt,
      aspect_ratio = '16:9',
      negative_prompt
    } = req.body;

    // Force duration to be exactly 8 seconds as per Fal.ai requirement
    const duration = "8s";

    console.log('Video generation request received:', { 
      prompt: prompt.substring(0, 50) + '...', 
      duration, 
      aspect_ratio 
    });

    // Check user's monthly limit
    const currentUsage = await prisma.apiUsage.aggregate({
      where: {
        userId: req.user.id,
        timestamp: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        },
        model: 'veo-3.0'
      },
      _sum: {
        tokens: true
      }
    });

    const usageThisMonth = currentUsage._sum.tokens || 0;
    if (usageThisMonth >= req.user.monthlyLimit) {
      return res.status(429).json({
        error: 'Monthly video generation limit exceeded',
        usage: { current: usageThisMonth, limit: req.user.monthlyLimit }
      });
    }

    console.log('Calling Fal.ai Veo3 Video Generation API...');
    
    try {
      const operationId = generateOperationId();
      const filename = `video_${Date.now()}_${Math.random().toString(36).substring(2, 11)}.mp4`;
      
      // Store operation info
      const operationData = {
        operationId,
        filename,
        prompt,
        duration,
        aspect_ratio,
        userId: req.user.id,
        status: 'processing',
        createdAt: new Date().toISOString(),
        lastChecked: new Date().toISOString()
      };

      activeOperations.set(operationId, operationData);

      // Start video generation with Fal.ai (async)
      generateVideoAsync(operationId, prompt, aspect_ratio, duration, negative_prompt, filename, req.user.id);

      // Track initial usage
      await prisma.apiUsage.create({
        data: {
          userId: req.user.id,
          model: 'veo-3.0',
          tokens: prompt.length,
          cost: 1.00 // Fixed cost for 8s video
        }
      });

      res.json({
        success: true,
        operationId: operationId,
        filename: filename,
        status: 'processing',
        message: 'Video generation started successfully. This may take 2-5 minutes.',
        estimatedTime: '2-5 minutes',
        checkUrl: `/video/status/${operationId}`,
        prompt: prompt,
        duration: duration,
        aspect_ratio: aspect_ratio
      });

    } catch (apiError) {
      console.error('🚨 Fal.ai Veo3 API Error:', apiError);
      
      if (apiError.status === 422) {
        return res.status(422).json({
          error: 'Invalid request parameters',
          message: 'The request parameters are invalid for Fal.ai Veo3 API.',
          code: 'VALIDATION_ERROR',
          details: apiError.body || apiError.message
        });
      } else if (apiError.message?.includes('quota') || apiError.message?.includes('429')) {
        return res.status(429).json({
          error: 'API quota exceeded',
          message: 'You have exceeded your Fal.ai API quota. Please try again later or upgrade your plan.',
          code: 'QUOTA_EXCEEDED'
        });
      } else if (apiError.message?.includes('401') || apiError.message?.includes('403')) {
        return res.status(401).json({
          error: 'API authentication failed',
          message: 'Invalid Fal.ai API key. Please check your configuration.',
          code: 'AUTH_FAILED'
        });
      } else {
        return res.status(500).json({
          error: 'Video generation failed',
          message: apiError.message || 'Unknown error occurred',
          code: 'GENERATION_FAILED',
          details: apiError.body || null
        });
      }
    }

  } catch (error) {
    console.error('🚨 General video generation error:', error);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      message: error.message
    });
  }
});

// Async video generation function with correct Fal.ai parameters
// ...existing code...

// Async video generation function with retries on transient network failures
async function generateVideoAsync(operationId, prompt, aspectRatio, duration, negativePrompt, filename, userId) {
  const maxRetries = 3;
  const baseDelayMs = 4000;

  const tryOnce = async () => {
    console.log(`🎬 Starting video generation for operation: ${operationId}`);

    const operationData = activeOperations.get(operationId);
    if (operationData) {
      operationData.status = 'processing';
      operationData.lastChecked = new Date().toISOString();
      activeOperations.set(operationId, operationData);
    }

    const apiInput = {
      prompt,
      aspect_ratio: aspectRatio || "16:9",
      duration: "8s",
      enhance_prompt: true,
      auto_fix: true,
      resolution: "720p",
      generate_audio: true,
    };
    if (negativePrompt && negativePrompt.trim() !== '') {
      apiInput.negative_prompt = negativePrompt;
    }

    console.log(`🔧 Calling Fal.ai API with input:`, JSON.stringify(apiInput, null, 2));

    // This may take minutes; subscribe returns when done or throws
    return await fal.subscribe('fal-ai/veo3/fast', {
      input: apiInput,
      logs: true,
      onQueueUpdate: (update) => {
        // keep status fresh for pollers
        const d = activeOperations.get(operationId);
        if (d) {
          d.queuePosition = update.queue_position || 0;
          d.status = update.status === 'COMPLETED' ? 'processing' : (update.status || 'processing');
          d.lastChecked = new Date().toISOString();
          if (update.metrics) d.metrics = update.metrics;
          activeOperations.set(operationId, d);
        }
      },
    });
  };

  const isConnectTimeout = (err) =>
    err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    err?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    /connect timeout/i.test(err?.message || '');

  try {
    let result;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        result = await tryOnce();
        break; // success
      } catch (err) {
        console.error(`❌ Fal.ai subscribe error (attempt ${attempt}/${maxRetries}):`, err);
        if (attempt < maxRetries && isConnectTimeout(err)) {
          const delay = baseDelayMs * attempt;
          console.log(`⏳ Retry in ${delay}ms due to network timeout...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err; // non-retryable or exhausted
      }
    }

    // Download and save the video
    if (!(result?.data?.video?.url)) {
      throw new Error('No video URL found in API response');
    }
    console.log(`📥 Downloading video from: ${result.data.video.url}`);

    const resp = await fetch(result.data.video.url);
    if (!resp.ok) throw new Error(`Failed to download video: ${resp.status} ${resp.statusText}`);
    const videoBuffer = await resp.arrayBuffer();

    const videosDir = path.join('uploads', 'videos');
    if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });
    const videoPath = path.join(videosDir, filename);
    fs.writeFileSync(videoPath, Buffer.from(videoBuffer));

    console.log(`📁 Video saved successfully: ${filename} (${videoBuffer.byteLength} bytes)`);

    const d = activeOperations.get(operationId) || {};
    d.status = 'completed';
    d.result = {
      video_url: `/video/watch/${filename}`,
      download_url: `/video/download/${filename}`,
      filename,
      duration: "8s",
      file_size: videoBuffer.byteLength,
      resolution: "720p",
      aspect_ratio: aspectRatio,
      fal_video_url: result.data.video.url,
      fal_request_id: result.requestId || null,
    };
    d.updatedAt = new Date().toISOString();
    activeOperations.set(operationId, d);

  } catch (error) {
    console.error(`❌ Video generation failed for ${operationId}:`, error);

    const d = activeOperations.get(operationId) || {};
    d.status = 'failed';
    d.error = error?.message || 'Video generation failed';
    d.errorDetails = {
      code: error?.code || error?.cause?.code || null,
      name: error?.name || null,
    };
    d.updatedAt = new Date().toISOString();
    activeOperations.set(operationId, d);
  }
}
// Check video generation status - THIS WAS MISSING!
router.get('/status/:operationId', authenticateToken, async (req, res) => {
  try {
    const { operationId } = req.params;
    console.log('📊 Checking status for operation:', operationId);
    
    const operationData = activeOperations.get(operationId);
    
    if (!operationData) {
      return res.status(404).json({ 
        error: 'Operation not found',
        message: 'The video generation operation was not found or has expired.'
      });
    }
    
    // Check if this operation belongs to the current user
    if (operationData.userId !== req.user.id) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'You do not have permission to access this operation.'
      });
    }
    
    console.log(`📋 Operation ${operationId} status:`, operationData.status);
    res.json(operationData);
    
  } catch (error) {
    console.error('❌ Error checking video status:', error);
    res.status(500).json({ error: error.message });
  }
});


// Add a download endpoint for proper file downloads
router.get('/download/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(__dirname, '..', '..', '..', 'uploads', 'videos', filename);
    
    console.log('📥 Download request for:', filename);
    console.log('📁 Looking for file at:', filepath);

    if (!fs.existsSync(filepath)) {
      console.error('❌ File not found at:', filepath);
      
      // Try alternative path
      const altPath = path.join('uploads', 'videos', filename);
      console.log('📁 Trying alternative path:', altPath);
      
      if (!fs.existsSync(altPath)) {
        console.error('❌ File not found at alternative path either');
        return res.status(404).json({ error: 'Video file not found' });
      } else {
        // Use alternative path
        console.log('✅ Found file at alternative path');
        const stat = fs.statSync(altPath);
        res.set({
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache'
        });
        
        const stream = fs.createReadStream(altPath);
        stream.pipe(res);
        return;
      }
    }

    // File exists at main path
    console.log('✅ File found, starting download');
    const stat = fs.statSync(filepath);
    
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });

    // Stream the file
    const stream = fs.createReadStream(filepath);
    
    stream.on('error', (err) => {
      console.error('❌ Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error streaming file' });
      }
    });
    
    stream.pipe(res);

  } catch (error) {
    console.error('❌ Error downloading video file:', error);
    res.status(500).json({ error: 'Error downloading video file' });
  }
});

// Also update the watch endpoint with better path handling
router.get('/watch/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    let filepath = path.join(__dirname, '..', '..', '..', 'uploads', 'videos', filename);
    
    // Check if file exists, if not try alternative path
    if (!fs.existsSync(filepath)) {
      filepath = path.join('uploads', 'videos', filename);
      if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Video file not found' });
      }
    }

    const stat = fs.statSync(filepath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Support video streaming with range requests
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filepath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=31536000',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000',
      };
      res.writeHead(200, head);
      fs.createReadStream(filepath).pipe(res);
    }

  } catch (error) {
    console.error('Error serving video file:', error);
    res.status(500).json({ error: 'Error serving video file' });
  }
});

// Get video history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get user's video operations from activeOperations
    const userOperations = Array.from(activeOperations.values())
      .filter(op => op.userId === req.user.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(offset, offset + parseInt(limit));

    const total = Array.from(activeOperations.values())
      .filter(op => op.userId === req.user.id).length;

    res.json({
      videos: userOperations,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching video history:', error);
    res.status(500).json({ error: 'Failed to fetch video history' });
  }
});

// Cleanup old operations (run periodically)
setInterval(() => {
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours
  
  for (const [operationId, operationData] of activeOperations.entries()) {
    const createdAt = new Date(operationData.createdAt);
    if (createdAt < twoHoursAgo && (operationData.status === 'completed' || operationData.status === 'failed')) {
      activeOperations.delete(operationId);
      console.log(`🧹 Cleaned up old operation: ${operationId}`);
    }
  }
}, 30 * 60 * 1000); // Run every 30 minutes

module.exports = router;