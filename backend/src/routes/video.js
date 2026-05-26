// const express = require('express');
// const { body, validationResult } = require('express-validator');
// const { authenticateToken } = require('../middleware/auth');
// const fs = require('fs');
// const path = require('path');
// const { PrismaClient } = require('@prisma/client');
// const { fal } = require('@fal-ai/client');
// const router = express.Router();
// const prisma = new PrismaClient();

// // Configure Fal.ai client
// fal.config({
//   credentials: process.env.FAL_KEY, // Your Fal.ai API key
// });

// // Store active operations
// const activeOperations = new Map();

// // Helper function to generate operation ID
// function generateOperationId() {
//   return `veo3_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
// }

// // Enhanced video generation with Fal.ai
// router.post('/generate', [
//   body('prompt').trim().notEmpty().withMessage('Video prompt is required'),
//   body('aspect_ratio').optional().isIn(['16:9', '9:16', '1:1']).withMessage('Invalid aspect ratio'),
//   body('negative_prompt').optional().isString().withMessage('Negative prompt must be a string'),
//   body('image_url').optional().isString().withMessage('Image URL must be a string')
// ], authenticateToken, async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({ errors: errors.array() });
//     }

//     if (!process.env.FAL_KEY) {
//       return res.status(400).json({ error: 'Fal.ai API key not configured' });
//     }

//     const {
//       prompt,
//       aspect_ratio = '16:9',
//       negative_prompt,
//       image_url
//     } = req.body;

//     // Force duration to be exactly 8 seconds as per Fal.ai requirement
//     const duration = "8s";

//     console.log('Video generation request received:', { 
//       prompt: prompt.substring(0, 50) + '...', 
//       duration, 
//       aspect_ratio,
//       hasImageUrl: !!image_url
//     });

//     // Check user's monthly limit
//     const currentUsage = await prisma.apiUsage.aggregate({
//       where: {
//         userId: req.user.id,
//         timestamp: {
//           gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
//         },
//         model: 'veo-3.0'
//       },
//       _sum: {
//         tokens: true
//       }
//     });

//     const usageThisMonth = currentUsage._sum.tokens || 0;
//     if (usageThisMonth >= req.user.monthlyLimit) {
//       return res.status(429).json({
//         error: 'Monthly video generation limit exceeded',
//         usage: { current: usageThisMonth, limit: req.user.monthlyLimit }
//       });
//     }

//     console.log('Calling Fal.ai Veo3 Video Generation API...');

//     try {
//       const operationId = generateOperationId();
//       const filename = `video_${Date.now()}_${Math.random().toString(36).substring(2, 11)}.mp4`;

//       // Store operation info
//       const operationData = {
//         operationId,
//         filename,
//         prompt,
//         duration,
//         aspect_ratio,
//         userId: req.user.id,
//         status: 'processing',
//         createdAt: new Date().toISOString(),
//         lastChecked: new Date().toISOString(),
//         sourceImageUrl: image_url || null
//       };
//       activeOperations.set(operationId, operationData);

//       // Start video generation with Fal.ai (async)
//          generateVideoAsync(operationId, prompt, aspect_ratio, duration, negative_prompt, filename, req.user.id, image_url);

//       // Track initial usage
//       await prisma.apiUsage.create({
//         data: {
//           userId: req.user.id,
//           model: 'veo-3.0',
//           tokens: prompt.length,
//           cost: 1.00 // Fixed cost for 8s video
//         }
//       });

//       res.json({
//         success: true,
//         operationId: operationId,
//         filename: filename,
//         status: 'processing',
//         message: 'Video generation started successfully. This may take 2-5 minutes.',
//         estimatedTime: '2-5 minutes',
//         checkUrl: `/video/status/${operationId}`,
//         prompt: prompt,
//         duration: duration,
//         aspect_ratio: aspect_ratio
//       });

//     } catch (apiError) {
//       console.error('🚨 Fal.ai Veo3 API Error:', apiError);

//       if (apiError.status === 422) {
//         return res.status(422).json({
//           error: 'Invalid request parameters',
//           message: 'The request parameters are invalid for Fal.ai Veo3 API.',
//           code: 'VALIDATION_ERROR',
//           details: apiError.body || apiError.message
//         });
//       } else if (apiError.message?.includes('quota') || apiError.message?.includes('429')) {
//         return res.status(429).json({
//           error: 'API quota exceeded',
//           message: 'You have exceeded your Fal.ai API quota. Please try again later or upgrade your plan.',
//           code: 'QUOTA_EXCEEDED'
//         });
//       } else if (apiError.message?.includes('401') || apiError.message?.includes('403')) {
//         return res.status(401).json({
//           error: 'API authentication failed',
//           message: 'Invalid Fal.ai API key. Please check your configuration.',
//           code: 'AUTH_FAILED'
//         });
//       } else {
//         return res.status(500).json({
//           error: 'Video generation failed',
//           message: apiError.message || 'Unknown error occurred',
//           code: 'GENERATION_FAILED',
//           details: apiError.body || null
//         });
//       }
//     }

//   } catch (error) {
//     console.error('🚨 General video generation error:', error);
//     res.status(500).json({ 
//       error: 'Internal Server Error', 
//       message: error.message
//     });
//   }
// });

// // generateVideoAsync function with proper variable scoping and syntax fix
// async function generateVideoAsync(operationId, prompt, aspectRatio, duration, negativePrompt, filename, userId, imageUrl = null) {
//   const maxRetries = 3;
//   let retryCount = 0;

//   while (retryCount < maxRetries) {
//     try {
//       console.log(`🎬 Starting video generation attempt ${retryCount + 1}/${maxRetries} for operation: ${operationId}`);
//       console.log(`🖼️ Generation Mode: ${imageUrl ? 'Image-to-Video' : 'Text-to-Video'}`);

//       // Update status
//       let operationData = activeOperations.get(operationId) || {};
//       operationData.status = 'processing';
//       operationData.updatedAt = new Date().toISOString();
//       activeOperations.set(operationId, operationData);

//       // Declare variables at function scope to avoid scope issues
//       let endpoint, requestPayload, processedImageUrl = null;

//       if (imageUrl) {
//         //  Handle image URL - upload to Fal.ai if it's a local file
//         processedImageUrl = imageUrl;

//         // If it's a local file URL, upload it to Fal.ai
//         if (imageUrl.includes('localhost') || imageUrl.includes('127.0.0.1') || (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://'))) {
//           try {
//             console.log('📤 Uploading local image to Fal.ai for processing...');

//             // Extract the local file path from URL
//             let localImagePath;
//             if (imageUrl.includes('/uploads/')) {
//               // Extract path after /uploads/
//               const pathAfterUploads = imageUrl.split('/uploads/')[1];
//               localImagePath = path.join('uploads', pathAfterUploads);
//             } else {
//               // Direct file path
//               localImagePath = imageUrl;
//             }

//             console.log('📁 Local image path:', localImagePath);

//             // Check if file exists
//             if (fs.existsSync(localImagePath)) {
//               // Read the file and upload to Fal.ai
//               const imageBuffer = fs.readFileSync(localImagePath);
//               const fileName = path.basename(localImagePath);

//               // Create a Blob from the buffer
//               const fileBlob = new Blob([imageBuffer], { 
//                 type: getImageMimeType(fileName) 
//               });

//               // Upload to Fal.ai storage
//               const uploadedUrl = await fal.storage.upload(fileBlob);
//               processedImageUrl = uploadedUrl;

//               console.log('✅ Image uploaded to Fal.ai successfully:', uploadedUrl);
//             } else {
//               throw new Error(`Local image file not found: ${localImagePath}`); // 
//             }
//           } catch (uploadError) {
//             console.error(' Failed to upload image to Fal.ai:', uploadError);
//             throw new Error(`Failed to process image for video generation: ${uploadError.message}`);
//           }
//         }

//         //  Use Image-to-Video endpoint
//         endpoint = "fal-ai/veo3/fast/image-to-video";
//         requestPayload = {
//           prompt: prompt,
//           image_url: processedImageUrl,
//           aspect_ratio: aspectRatio === '16:9' ? '16:9' : 
//                        aspectRatio === '9:16' ? '9:16' : 'auto',
//           duration: duration,
//           generate_audio: true,
//           resolution: "720p"
//         };
//         console.log('🖼️➡️🎬 Using Image-to-Video model (fal-ai/veo3/fast/image-to-video)');
//         console.log('🔗 Using processed image URL:', processedImageUrl.substring(0, 50) + '...');
//       } else {
//         //  Use Text-to-Video endpoint
//         endpoint = "fal-ai/veo3/fast";
//         requestPayload = {
//           prompt: prompt,
//           duration: duration,
//           aspect_ratio: aspectRatio,
//           negative_prompt: negativePrompt || undefined
//         };
//         console.log('📝➡️🎬 Using Text-to-Video model (fal-ai/veo3/fast)');
//       }

//       console.log('📡 Fal.ai request details:', {
//         endpoint: endpoint,
//         payload: {
//           ...requestPayload,
//           image_url: processedImageUrl ? '[PROCESSED_IMAGE_URL]' : undefined
//         }
//       });

//       //  Make API call with better error handling
//       const result = await fal.subscribe(endpoint, {
//         input: requestPayload,
//         logs: true,
//         onQueueUpdate: (update) => {
//           let updateData = activeOperations.get(operationId) || {};
//           updateData.queuePosition = update.queue_position;
//           updateData.status = update.status === "IN_PROGRESS" ? 'processing' : updateData.status;
//           updateData.updatedAt = new Date().toISOString();
//           activeOperations.set(operationId, updateData);

//           // Log progress updates
//           if (update.logs) {
//             update.logs.forEach(log => {
//               console.log(`📊 ${operationId}: ${log.message}`);
//             });
//           }
//         },
//       });

//       console.log(`✅ Fal.ai API response for ${operationId}:`, JSON.stringify(result, null, 2));

//       // Validate the response structure
//       if (!result || !result.data) {
//         throw new Error('Invalid API response: Missing data object');
//       }

//       if (!result.data.video || !result.data.video.url) {
//         throw new Error('Invalid API response: Missing video URL');
//       }

//       // Download and save the video
//       console.log(`📥 Downloading video from: ${result.data.video.url}`);
//       const resp = await fetch(result.data.video.url);
//       if (!resp.ok) {
//         throw new Error(`Failed to download video: ${resp.status} ${resp.statusText}`);
//       }

//       const videoBuffer = await resp.arrayBuffer();
//       const videosDir = path.join('uploads', 'videos');
//       if (!fs.existsSync(videosDir)) {
//         fs.mkdirSync(videosDir, { recursive: true });
//       }

//       const videoPath = path.join(videosDir, filename);
//       fs.writeFileSync(videoPath, Buffer.from(videoBuffer));

//       console.log(`📁 Video saved successfully: ${filename} (${Math.round(videoBuffer.byteLength / 1024 / 1024 * 100) / 100} MB)`);

//       //  Update operation status to completed with enhanced metadata
//       let completedData = activeOperations.get(operationId) || {};
//       completedData.status = 'completed';
//       completedData.result = {
//         video_url: `/video/watch/${filename}`,
//         download_url: `/video/download/${filename}`,
//         filename,
//         duration: "8s",
//         file_size: videoBuffer.byteLength,
//         resolution: result.data.video.width && result.data.video.height ? 
//                    `${result.data.video.width}x${result.data.video.height}` : "720p",
//         aspect_ratio: aspectRatio,
//         fal_video_url: result.data.video.url,
//         fal_request_id: result.requestId || null,
//         sourceImageUrl: imageUrl,
//         processedImageUrl: processedImageUrl, //  Now properly scoped
//         generationType: imageUrl ? 'image-to-video' : 'text-to-video',
//         model: endpoint,
//         prompt: prompt,
//         completedAt: new Date().toISOString()
//       };
//       completedData.updatedAt = new Date().toISOString();
//       activeOperations.set(operationId, completedData);

//       console.log(`🎉 Video generation completed successfully for ${operationId}`);
//       break; // Success, exit retry loop

//     } catch (error) {
//       console.error(`❌ Video generation failed for ${operationId} (attempt ${retryCount + 1}/${maxRetries}):`, error);

//       //  Enhanced error logging
//       if (error.status === 422) {
//         console.error('📋 Validation Error Details:', error.body);
//       }

//       retryCount++;
//       if (retryCount >= maxRetries) {
//         let failedData = activeOperations.get(operationId) || {};
//         failedData.status = 'failed';
//         failedData.error = error?.message || 'Video generation failed after maximum retries';
//         failedData.errorDetails = {
//           totalAttempts: retryCount,
//           timestamp: new Date().toISOString(),
//           error_type: error.constructor.name,
//           original_error: error.message,
//           status_code: error.status,
//           response_body: error.body,
//           generationType: imageUrl ? 'image-to-video' : 'text-to-video',
//           endpoint: imageUrl ? 'fal-ai/veo3/fast/image-to-video' : 'fal-ai/veo3/fast'
//         };
//         failedData.updatedAt = new Date().toISOString();
//         activeOperations.set(operationId, failedData);

//         console.error(` Final failure for ${operationId} after ${retryCount} attempts`);
//         break;
//       }

//       // Wait before retry with exponential backoff
//       const waitTime = Math.pow(2, retryCount) * 1000;
//       console.log(` Waiting ${waitTime}ms before retry ${retryCount + 1}/${maxRetries}...`);
//       await new Promise(resolve => setTimeout(resolve, waitTime));
//     }
//   }
// }

// // Helper function to determine image MIME type
// function getImageMimeType(filename) {
//   const ext = path.extname(filename).toLowerCase();
//   switch (ext) {
//     case '.jpg':
//     case '.jpeg':
//       return 'image/jpeg';
//     case '.png':
//       return 'image/png';
//     case '.gif':
//       return 'image/gif';
//     case '.webp':
//       return 'image/webp';
//     default:
//       return 'image/jpeg'; // Default fallback
//   }
// }
// // Check video generation status - THIS WAS MISSING!
// router.get('/status/:operationId', authenticateToken, async (req, res) => {
//   try {
//     const { operationId } = req.params;
//     console.log('📊 Checking status for operation:', operationId);

//     const operationData = activeOperations.get(operationId);

//     if (!operationData) {
//       return res.status(404).json({ 
//         error: 'Operation not found',
//         message: 'The video generation operation was not found or has expired.'
//       });
//     }

//     // Check if this operation belongs to the current user
//     if (operationData.userId !== req.user.id) {
//       return res.status(403).json({ 
//         error: 'Access denied',
//         message: 'You do not have permission to access this operation.'
//       });
//     }

//     console.log(`📋 Operation ${operationId} status:`, operationData.status);
//     res.json(operationData);

//   } catch (error) {
//     console.error('❌ Error checking video status:', error);
//     res.status(500).json({ error: error.message });
//   }
// });


// // Add a download endpoint for proper file downloads
// router.get('/download/:filename', (req, res) => {
//   try {
//     const filename = req.params.filename;
//     const filepath = path.join(__dirname, '..', '..', '..', 'uploads', 'videos', filename);

//     console.log('📥 Download request for:', filename);
//     console.log('📁 Looking for file at:', filepath);

//     if (!fs.existsSync(filepath)) {
//       console.error('❌ File not found at:', filepath);

//       // Try alternative path
//       const altPath = path.join('uploads', 'videos', filename);
//       console.log('📁 Trying alternative path:', altPath);

//       if (!fs.existsSync(altPath)) {
//         console.error('❌ File not found at alternative path either');
//         return res.status(404).json({ error: 'Video file not found' });
//       } else {
//         // Use alternative path
//         console.log('✅ Found file at alternative path');
//         const stat = fs.statSync(altPath);
//         res.set({
//           'Content-Type': 'video/mp4',
//           'Content-Disposition': `attachment; filename="${filename}"`,
//           'Content-Length': stat.size,
//           'Cache-Control': 'no-cache'
//         });

//         const stream = fs.createReadStream(altPath);
//         stream.pipe(res);
//         return;
//       }
//     }

//     // File exists at main path
//     console.log('✅ File found, starting download');
//     const stat = fs.statSync(filepath);

//     res.set({
//       'Content-Type': 'video/mp4',
//       'Content-Disposition': `attachment; filename="${filename}"`,
//       'Content-Length': stat.size,
//       'Cache-Control': 'no-cache',
//       'Access-Control-Allow-Origin': '*'
//     });

//     // Stream the file
//     const stream = fs.createReadStream(filepath);

//     stream.on('error', (err) => {
//       console.error('❌ Stream error:', err);
//       if (!res.headersSent) {
//         res.status(500).json({ error: 'Error streaming file' });
//       }
//     });

//     stream.pipe(res);

//   } catch (error) {
//     console.error('❌ Error downloading video file:', error);
//     res.status(500).json({ error: 'Error downloading video file' });
//   }
// });

// // Also update the watch endpoint with better path handling
// router.get('/watch/:filename', (req, res) => {
//   try {
//     const filename = req.params.filename;
//     let filepath = path.join(__dirname, '..', '..', '..', 'uploads', 'videos', filename);

//     // Check if file exists, if not try alternative path
//     if (!fs.existsSync(filepath)) {
//       filepath = path.join('uploads', 'videos', filename);
//       if (!fs.existsSync(filepath)) {
//         return res.status(404).json({ error: 'Video file not found' });
//       }
//     }

//     const stat = fs.statSync(filepath);
//     const fileSize = stat.size;
//     const range = req.headers.range;

//     if (range) {
//       // Support video streaming with range requests
//       const parts = range.replace(/bytes=/, "").split("-");
//       const start = parseInt(parts[0], 10);
//       const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
//       const chunksize = (end - start) + 1;
//       const file = fs.createReadStream(filepath, { start, end });
//       const head = {
//         'Content-Range': `bytes ${start}-${end}/${fileSize}`,
//         'Accept-Ranges': 'bytes',
//         'Content-Length': chunksize,
//         'Content-Type': 'video/mp4',
//         'Cache-Control': 'public, max-age=31536000',
//       };
//       res.writeHead(206, head);
//       file.pipe(res);
//     } else {
//       const head = {
//         'Content-Length': fileSize,
//         'Content-Type': 'video/mp4',
//         'Accept-Ranges': 'bytes',
//         'Cache-Control': 'public, max-age=31536000',
//       };
//       res.writeHead(200, head);
//       fs.createReadStream(filepath).pipe(res);
//     }

//   } catch (error) {
//     console.error('Error serving video file:', error);
//     res.status(500).json({ error: 'Error serving video file' });
//   }
// });

// // Get video history
// router.get('/history', authenticateToken, async (req, res) => {
//   try {
//     const { page = 1, limit = 10 } = req.query;
//     const offset = (parseInt(page) - 1) * parseInt(limit);

//     // Get user's video operations from activeOperations
//     const userOperations = Array.from(activeOperations.values())
//       .filter(op => op.userId === req.user.id)
//       .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
//       .slice(offset, offset + parseInt(limit));

//     const total = Array.from(activeOperations.values())
//       .filter(op => op.userId === req.user.id).length;

//     res.json({
//       videos: userOperations,
//       pagination: {
//         page: parseInt(page),
//         limit: parseInt(limit),
//         total: total,
//         pages: Math.ceil(total / parseInt(limit))
//       }
//     });
//   } catch (error) {
//     console.error('Error fetching video history:', error);
//     res.status(500).json({ error: 'Failed to fetch video history' });
//   }
// });

// // Cleanup old operations (run periodically)
// setInterval(() => {
//   const now = new Date();
//   const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours

//   for (const [operationId, operationData] of activeOperations.entries()) {
//     const createdAt = new Date(operationData.createdAt);
//     if (createdAt < twoHoursAgo && (operationData.status === 'completed' || operationData.status === 'failed')) {
//       activeOperations.delete(operationId);
//       console.log(`🧹 Cleaned up old operation: ${operationId}`);
//     }
//   }
// }, 30 * 60 * 1000); // Run every 30 minutes

// module.exports = router;





const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { fal } = require('@fal-ai/client');
const {
  contentDispositionHeader,
  parseHttpByteRange,
  resolveConfinedFile,
} = require('../middleware/file-response-safety');
const {
  normaliseUploadPath,
  resolveConfinedPath,
} = require('../middleware/upload-static-access');
const router = express.Router();
const prisma = new PrismaClient();

function getFalApiKey() {
  return process.env.FAL_KEY || process.env.FAL_API_KEY || process.env.TAL_AI_API_KEY || '';
}

// Configure Fal.ai client. FAL_API_KEY is the key name present in the
// local SiraGPT env; keep FAL_KEY and TAL_AI_API_KEY as aliases.
fal.config({
  credentials: getFalApiKey(),
});

// Store active operations
const activeOperations = new Map();
const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../uploads');
const videosDir = path.join(uploadRoot, 'videos');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveVideoFile(rawFilename) {
  return resolveConfinedFile(videosDir, rawFilename, { allowedExtensions: ['.mp4'] });
}

function extractLocalUploadRelativePath(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let candidate = raw;
  try {
    const parsed = new URL(raw);
    candidate = parsed.pathname || '';
  } catch {
    candidate = raw.split('?')[0];
  }

  const marker = '/uploads/';
  const markerIndex = candidate.indexOf(marker);
  if (markerIndex >= 0) {
    candidate = candidate.slice(markerIndex + marker.length);
  }

  candidate = candidate.replace(/^\/+/, '');
  if (candidate.startsWith('uploads/')) {
    candidate = candidate.slice('uploads/'.length);
  }

  return normaliseUploadPath(candidate);
}

function resolveLocalUploadFile(input) {
  const relativePath = extractLocalUploadRelativePath(input);
  if (!relativePath) return null;
  return resolveConfinedPath(uploadRoot, relativePath);
}

function streamFile(res, filePath, { status = 200, headers = {}, start, end } = {}) {
  res.writeHead(status, headers);
  const stream = Number.isInteger(start) || Number.isInteger(end)
    ? fs.createReadStream(filePath, { start, end })
    : fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('❌ Media stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error streaming file' });
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
}

// Helper function to generate operation ID
function generateOperationId() {
  return `veo3_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// Enhanced video generation with Fal.ai
router.post('/generate', [
  body('prompt').trim().notEmpty().withMessage('Video prompt is required'),
  body('aspect_ratio').optional().isIn(['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']).withMessage('Invalid aspect ratio'),
  body('resolution').optional().isIn(['480p', '720p']).withMessage('Invalid resolution'),
  body('duration').optional().isInt({ min: 4, max: 15 }).withMessage('Invalid duration'),
  body('audio').optional().isBoolean().withMessage('Audio must be a boolean'),
  body('negative_prompt').optional().isString().withMessage('Negative prompt must be a string'),
  body('image_url').optional().isString().withMessage('Image URL must be a string'),
  body('model').optional().isString().withMessage('Model must be a string')
], authenticateToken, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const falApiKey = getFalApiKey();
    if (!falApiKey) {
      return res.status(400).json({ error: 'Fal.ai API key not configured' });
    }

    fal.config({ credentials: falApiKey });

    const {
      prompt,
      aspect_ratio = '16:9',
      resolution = '720p',
      duration: requestedDuration = 5,
      audio = true,
      negative_prompt,
      image_url,
      model = 'veo-fast' // Default model
    } = req.body;

    const numericDuration = Math.min(Math.max(Number(requestedDuration) || 5, 4), 15);
    const duration = `${numericDuration}s`;

    console.log('Video generation request received:', {
      prompt: prompt.substring(0, 50) + '...',
      duration,
      resolution,
      audio,
      aspect_ratio,
      hasImageUrl: !!image_url,
      model
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
      const filename = `video_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.mp4`;

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
        lastChecked: new Date().toISOString(),
        sourceImageUrl: image_url || null
      };
      activeOperations.set(operationId, operationData);

      // Start video generation with Fal.ai (async)
      generateVideoAsync(operationId, prompt, aspect_ratio, duration, negative_prompt, filename, req.user.id, image_url, model, resolution, audio);

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

// generateVideoAsync function with proper variable scoping and syntax fix
async function generateVideoAsync(operationId, prompt, aspectRatio, duration, negativePrompt, filename, userId, imageUrl = null, model = 'veo-fast', resolution = '720p', audio = true) {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      console.log(`🎬 Starting video generation attempt ${retryCount + 1}/${maxRetries} for operation: ${operationId}`);
      console.log(`🖼️ Generation Mode: ${imageUrl ? 'Image-to-Video' : 'Text-to-Video'}`);

      // Update status
      let operationData = activeOperations.get(operationId) || {};
      operationData.status = 'processing';
      operationData.updatedAt = new Date().toISOString();
      activeOperations.set(operationId, operationData);

      // Declare variables at function scope to avoid scope issues
      let endpoint, requestPayload, processedImageUrl = null;

      if (imageUrl) {
        //  Handle image URL - upload to Fal.ai if it's a local file
        processedImageUrl = imageUrl;

        // If it's a local file URL, upload it to Fal.ai
        if (imageUrl.includes('localhost') || imageUrl.includes('127.0.0.1') || (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://'))) {
          try {
            console.log('📤 Uploading local image to Fal.ai for processing...');

            const localImagePath = resolveLocalUploadFile(imageUrl);
            if (!localImagePath) {
              throw new Error('Invalid local image path');
            }

            console.log('📁 Local image path:', localImagePath);

            // Check if file exists
            if (fs.existsSync(localImagePath)) {
              // Read the file and upload to Fal.ai
              const imageBuffer = fs.readFileSync(localImagePath);
              const fileName = path.basename(localImagePath);

              // Create a Blob from the buffer
              const fileBlob = new Blob([imageBuffer], {
                type: getImageMimeType(fileName)
              });

              // Upload to Fal.ai storage
              const uploadedUrl = await fal.storage.upload(fileBlob);
              processedImageUrl = uploadedUrl;

              console.log('✅ Image uploaded to Fal.ai successfully:', uploadedUrl);
            } else {
              throw new Error(`Local image file not found: ${localImagePath}`); // 
            }
          } catch (uploadError) {
            console.error(' Failed to upload image to Fal.ai:', uploadError);
            throw new Error(`Failed to process image for video generation: ${uploadError.message}`);
          }
        }

        //  Use Image-to-Video endpoint
        switch (model) {
          case 'kling-1.6-pro':
            endpoint = "fal-ai/kling-video/v1.6/pro/image-to-video";
            break;
          case 'kling-2-master':
            endpoint = "fal-ai/kling-video/v2.1/master/image-to-video";
            break;
          case 'fal-ai/veo3/fast':
          case 'fal-ai/veo3/fast/image-to-video':
          case 'veo-fast':
          default: // veo-fast
            endpoint = "fal-ai/veo3/fast/image-to-video";
        }
        requestPayload = {
          prompt: prompt,
          image_url: processedImageUrl,
          aspect_ratio: aspectRatio === '16:9' ? '16:9' :
            aspectRatio === '9:16' ? '9:16' : 'auto',
          duration: duration,
          generate_audio: Boolean(audio),
          resolution
        };
        console.log(`🖼️➡️🎬 Using Image-to-Video model (${endpoint})`);
        console.log('🔗 Using processed image URL:', processedImageUrl.substring(0, 50) + '...');
      } else {
        //  Use Text-to-Video endpoint
        console.log("MODEL", model);

        switch (model) {
          case 'kling-1.6-pro':
            endpoint = "fal-ai/kling-video/v1.6/pro/text-to-video";
            break;
          case 'kling-2-master':
            endpoint = "fal-ai/kling-video/v2.1/master/text-to-video";
            break;
          case 'fal-ai/veo3/fast':
          case 'fal-ai/veo3/fast/image-to-video':
          case 'veo-fast':
          default: // veo-fast
            endpoint = "fal-ai/veo3/fast";
        }
        requestPayload = {
          prompt: prompt,
          duration: duration,
          aspect_ratio: aspectRatio === 'auto' ? '16:9' : aspectRatio,
          generate_audio: Boolean(audio),
          resolution,
          negative_prompt: negativePrompt || undefined
        };
        console.log(`📝➡️🎬 Using Text-to-Video model (${endpoint})`);
      }

      console.log('📡 Fal.ai request details:', {
        endpoint: endpoint,
        payload: {
          ...requestPayload,
          image_url: processedImageUrl ? '[PROCESSED_IMAGE_URL]' : undefined
        }
      });

      //  Make API call with better error handling
      const result = await fal.subscribe(endpoint, {
        input: requestPayload,
        logs: true,
        onQueueUpdate: (update) => {
          let updateData = activeOperations.get(operationId) || {};
          updateData.queuePosition = update.queue_position;
          updateData.status = update.status === "IN_PROGRESS" ? 'processing' : updateData.status;
          updateData.updatedAt = new Date().toISOString();
          activeOperations.set(operationId, updateData);

          // Log progress updates
          if (update.logs) {
            update.logs.forEach(log => {
              console.log(`📊 ${operationId}: ${log.message}`);
            });
          }
        },
      });

      console.log(`✅ Fal.ai API response for ${operationId}:`, JSON.stringify(result, null, 2));

      // Validate the response structure
      if (!result || !result.data) {
        throw new Error('Invalid API response: Missing data object');
      }

      if (!result.data.video || !result.data.video.url) {
        throw new Error('Invalid API response: Missing video URL');
      }

      // Download and save the video
      console.log(`📥 Downloading video from: ${result.data.video.url}`);
      const resp = await fetch(result.data.video.url);
      if (!resp.ok) {
        throw new Error(`Failed to download video: ${resp.status} ${resp.statusText}`);
      }

      const videoBuffer = await resp.arrayBuffer();
      ensureDir(videosDir);

      const videoPath = path.join(videosDir, filename);
      fs.writeFileSync(videoPath, Buffer.from(videoBuffer));

      console.log(`📁 Video saved successfully: ${filename} (${Math.round(videoBuffer.byteLength / 1024 / 1024 * 100) / 100} MB)`);

      //  Update operation status to completed with enhanced metadata
      let completedData = activeOperations.get(operationId) || {};
      completedData.status = 'completed';
      completedData.result = {
        video_url: `/video/watch/${filename}`,
        download_url: `/video/download/${filename}`,
        filename,
        duration,
        file_size: videoBuffer.byteLength,
        resolution: result.data.video.width && result.data.video.height ?
          `${result.data.video.width}x${result.data.video.height}` : resolution,
        aspect_ratio: aspectRatio,
        audio: Boolean(audio),
        fal_video_url: result.data.video.url,
        fal_request_id: result.requestId || null,
        sourceImageUrl: imageUrl,
        processedImageUrl: processedImageUrl, //  Now properly scoped
        generationType: imageUrl ? 'image-to-video' : 'text-to-video',
        model: endpoint,
        prompt: prompt,
        completedAt: new Date().toISOString()
      };
      completedData.updatedAt = new Date().toISOString();
      activeOperations.set(operationId, completedData);

      console.log(`🎉 Video generation completed successfully for ${operationId}`);
      break; // Success, exit retry loop

    } catch (error) {
      console.error(`❌ Video generation failed for ${operationId} (attempt ${retryCount + 1}/${maxRetries}):`, error);

      //  Enhanced error logging
      if (error.status === 422) {
        console.error('📋 Validation Error Details:', error.body);
      }

      retryCount++;
      if (retryCount >= maxRetries) {
        let failedData = activeOperations.get(operationId) || {};
        failedData.status = 'failed';
        failedData.error = error?.message || 'Video generation failed after maximum retries';
        failedData.errorDetails = {
          totalAttempts: retryCount,
          timestamp: new Date().toISOString(),
          error_type: error.constructor.name,
          original_error: error.message,
          status_code: error.status,
          response_body: error.body,
          generationType: imageUrl ? 'image-to-video' : 'text-to-video',
          endpoint: imageUrl ? 'fal-ai/veo3/fast/image-to-video' : 'fal-ai/veo3/fast'
        };
        failedData.updatedAt = new Date().toISOString();
        activeOperations.set(operationId, failedData);

        console.error(` Final failure for ${operationId} after ${retryCount} attempts`);
        break;
      }

      // Wait before retry with exponential backoff
      const waitTime = Math.pow(2, retryCount) * 1000;
      console.log(` Waiting ${waitTime}ms before retry ${retryCount + 1}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// Helper function to determine image MIME type
function getImageMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg'; // Default fallback
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
    const resolved = resolveVideoFile(req.params.filename);
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid video filename' });
    }

    console.log('📥 Download request for:', resolved.filename);
    console.log('📁 Looking for file at:', resolved.filePath);

    if (!fs.existsSync(resolved.filePath)) {
      return res.status(404).json({ error: 'Video file not found' });
    }

    console.log('✅ File found, starting download');
    const stat = fs.statSync(resolved.filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Video file not found' });
    }

    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': contentDispositionHeader('attachment', resolved.filename),
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });

    streamFile(res, resolved.filePath, { headers: res.getHeaders() });

  } catch (error) {
    console.error('❌ Error downloading video file:', error);
    res.status(500).json({ error: 'Error downloading video file' });
  }
});

// Also update the watch endpoint with better path handling
router.get('/watch/:filename', (req, res) => {
  try {
    const resolved = resolveVideoFile(req.params.filename);
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid video filename' });
    }

    if (!fs.existsSync(resolved.filePath)) {
      return res.status(404).json({ error: 'Video file not found' });
    }

    const stat = fs.statSync(resolved.filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Video file not found' });
    }
    const fileSize = stat.size;
    const range = parseHttpByteRange(req.headers.range, fileSize);

    if (range) {
      if (range.error) {
        res.setHeader('Content-Range', range.contentRange);
        return res.status(416).json({ error: 'Requested range not satisfiable' });
      }

      const head = {
        'Content-Range': range.contentRange,
        'Accept-Ranges': 'bytes',
        'Content-Length': range.contentLength,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=31536000',
      };
      streamFile(res, resolved.filePath, {
        status: 206,
        headers: head,
        start: range.start,
        end: range.end,
      });
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000',
      };
      streamFile(res, resolved.filePath, { headers: head });
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
const cleanupInterval = setInterval(() => {
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
cleanupInterval.unref?.();

module.exports = router;
