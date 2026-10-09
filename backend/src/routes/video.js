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
//               const stat = await fs.promises.stat(localImagePath);
  if (!stat.isFile() || stat.size > LIMITS.image) throw Object.assign(new Error('La imagen supera el tamaño permitido.'), { code: 'MEDIA_TOO_LARGE' });
  const imageBuffer = await fs.promises.readFile(localImagePath);
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
const requirePaidPlan = require('../middleware/require-paid-plan');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
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
const {
  buildFalVideoInputPayload,
  extractFalVideoUrl,
  resolveFalVideoModelRequest,
  validateFalVideoSettings,
} = require('../services/fal-video-model-catalog');
const { getFalApiKey, resolveFalApiKey } = require('../services/fal/fal-auth');
const { classifyFalVideoError } = require('../services/fal/fal-video-errors');
const videoPromptDirector = require('../services/video-prompt-director');
const { getMediaJobStore, requestKey } = require('../services/media/job-store');
const { registerMediaRunner } = require('../services/media/job-worker');
const { createVideoJobRunner, publicVideoOperation } = require('../services/media/video-job-runner');
const { LIMITS } = require('../services/media/transfer');
const objectStorage = require('../services/object-storage');
const router = express.Router();
const prisma = require('../config/database');

// Configure Fal.ai client from server-only env. The SDK sends it as
// `Authorization: Key <credentials>`; keep aliases for existing deployments.
fal.config({
  credentials: getFalApiKey(),
});

// Deprecated inspection-only cache retained for compatibility with cleanup tests.
// Public state and execution are exclusively backed by media_jobs.
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
  // Release the fd if the client aborts mid-download (pipe doesn't destroy the
  // source on destination close). No-op on a complete response (writableFinished).
  res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
  stream.pipe(res);
}

// Helper function to generate operation ID
function generateOperationId() {
  return `veo3_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// Recent video history for a user (continuity / "hilación" between clips).
// Reads the in-memory operations created by this instance, oldest first,
// capped so prompts stay bounded. Entries expose the ORIGINAL prompt plus
// capture settings so the prompt director can anchor the next generation.
async function getRecentVideoHistoryForUser(userId, limit = 5) {
  const jobs = await getMediaJobStore().list(userId, 'video', { limit: Math.max(1, Math.min(limit, 5)) });
  return jobs.reverse().map(publicVideoOperation).map(op => ({
    prompt: op.originalPrompt || op.prompt, enhancedPrompt: op.enhancedPrompt || null,
    aspect_ratio: op.aspect_ratio, resolution: op.resolution, audio: op.audio,
    model: op.resolvedModel || op.requestedModel, createdAt: op.createdAt,
  }));
}

function resolveVeoFastDuration(requestedDuration, model) {
  const rawDuration = Number(requestedDuration);
  const modelName = String(model || '').toLowerCase();
  const isVeoFast = modelName === 'veo-fast'
    || modelName === 'fal-ai/veo3/fast'
    || modelName === 'fal-ai/veo3/fast/image-to-video';
  const duration = isVeoFast && (!Number.isFinite(rawDuration) || rawDuration === 5)
    ? 8
    : rawDuration;
  return Math.min(Math.max(Number(duration) || 8, 4), 15);
}

// Enhanced video generation with Fal.ai
router.post('/generate', [
  body('prompt').trim().notEmpty().withMessage('Video prompt is required'),
  body('aspect_ratio').optional().isIn(['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']).withMessage('Invalid aspect ratio'),
  body('resolution').optional().isIn(['360p', '480p', '720p', '1080p', '4k']).withMessage('Invalid resolution'),
  body('duration').optional().isInt({ min: 3, max: 15 }).withMessage('Invalid duration'),
  body('audio').optional().isBoolean().withMessage('Audio must be a boolean').toBoolean(),
  body('negative_prompt').optional().isString().withMessage('Negative prompt must be a string'),
  body('image_url').optional().isString().withMessage('Image URL must be a string'),
  body('image_urls').optional().isArray({ max: 12 }).withMessage('Image URLs must be an array'),
  body('image_urls.*').optional().isString().withMessage('Image URL must be a string'),
  body('model').optional().isString().withMessage('Model must be a string'),
  body('history').optional().isArray({ max: 5 }).withMessage('History must be an array'),
  body('continuation').optional().isBoolean().withMessage('Continuation must be a boolean'),
  body('professionalize').optional().isBoolean().withMessage('Professionalize must be a boolean')
], authenticateToken, requirePaidPlan({ feature: 'video_generation' }), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { apiKey: falApiKey, source: falKeySource } = await resolveFalApiKey({ prisma });
    if (!falApiKey) {
      return res.status(400).json({ error: 'Fal.ai API key not configured' });
    }

    fal.config({ credentials: falApiKey });

    const {
      prompt,
      aspect_ratio = '16:9',
      resolution = '720p',
      duration: requestedDuration = 8,
      audio = true,
      negative_prompt,
      image_url,
      image_urls,
      model = 'veo-fast', // Default model
      history: providedHistory = null,
      continuation = null,
      professionalize = true
    } = req.body;

    const inputImageUrls = [
      ...(Array.isArray(image_urls) ? image_urls : []),
      image_url,
    ]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);

    let modelRouting = resolveFalVideoModelRequest(model, {
      hasImage: inputImageUrls.length > 0,
      imageCount: inputImageUrls.length,
    });
    if (!modelRouting.ok) {
      return res.status(422).json({
        error: 'Invalid video model',
        message: modelRouting.message,
        code: modelRouting.code,
        requestedModel: model,
      });
    }

    let resolvedModel = modelRouting.endpoint;
    // Check the user's actual choices before normalization, quota writes or
    // starting an operation. Unsupported settings must never become a paid
    // provider rejection or a silently different video.
    const requestedSettings = validateFalVideoSettings({
      endpoint: resolvedModel, aspectRatio: aspect_ratio,
      duration: requestedDuration, resolution, audio,
    });
    if (!requestedSettings.ok) {
      return res.status(422).json({
        code: requestedSettings.code, error: requestedSettings.message,
        message: requestedSettings.message,
      });
    }
    const numericDuration = modelRouting.model?.apiData?.fal?.durationFormat === 'seconds-int'
      ? Number(requestedDuration)
      : resolveVeoFastDuration(requestedDuration, resolvedModel);
    const duration = `${numericDuration}s`;

    // Professional direction + cross-clip continuity ("hilación").
    // The prompt is directed once here (cinematic camera/pacing/quality +
    // bible anchor to the previous clip) so retries reuse the exact same
    // directed prompt. Strict continuity locks capture settings to the
    // previous clip so consecutive videos cut cleanly against each other.
    const history = Array.isArray(providedHistory) && providedHistory.length
      ? providedHistory.slice(-5)
      : await getRecentVideoHistoryForUser(req.user.id, 5);
    const resolvedFalCaps = modelRouting.model?.apiData?.fal || {};
    let direction = null;
    try {
      direction = videoPromptDirector.directVideoPrompt({
        prompt,
        aspectRatio: aspect_ratio,
        durationSeconds: numericDuration,
        resolution,
        audio,
        endpoint: resolvedModel,
        supportsAudio: typeof resolvedFalCaps.supportsAudio === 'boolean' ? resolvedFalCaps.supportsAudio : null,
        history,
        continuation: typeof continuation === 'boolean' ? continuation : null,
        professionalize,
      });
    } catch (directorError) {
      console.error('🎬 Video prompt director failed, using raw prompt:', directorError?.message || directorError);
      direction = null;
    }

    let effectiveAspectRatio = aspect_ratio;
    let effectiveResolution = resolution;
    let effectiveAudio = audio;
    if (direction && direction.continuityMode === 'strict') {
      if (direction.settings.aspect_ratio) effectiveAspectRatio = direction.settings.aspect_ratio;
      if (direction.settings.resolution) effectiveResolution = direction.settings.resolution;
      if (typeof direction.settings.audio === 'boolean') effectiveAudio = direction.settings.audio;
      if (direction.settings.model && direction.settings.model !== resolvedModel) {
        const lockedRouting = resolveFalVideoModelRequest(direction.settings.model, {
          hasImage: inputImageUrls.length > 0,
          imageCount: inputImageUrls.length,
        });
        if (lockedRouting.ok) {
          modelRouting = lockedRouting;
          resolvedModel = lockedRouting.endpoint;
        }
      }
    }

    const effectiveSettings = validateFalVideoSettings({
      endpoint: resolvedModel, aspectRatio: effectiveAspectRatio,
      duration: numericDuration, resolution: effectiveResolution, audio: effectiveAudio,
    });
    if (!effectiveSettings.ok) {
      return res.status(422).json({
        code: effectiveSettings.code, error: effectiveSettings.message,
        message: effectiveSettings.message,
      });
    }

    const directedPrompt = direction ? direction.prompt : prompt;
    const effectiveNegativePrompt = negative_prompt || (direction ? direction.negativePrompt : null);
    const continuityMode = direction ? direction.continuityMode : 'none';
    const settingsLocked = direction ? direction.settingsLocked : [];

    console.log('Video generation request received:', {
      prompt: prompt.substring(0, 50) + '...',
      duration,
      resolution: effectiveResolution,
      audio: effectiveAudio,
      aspect_ratio: effectiveAspectRatio,
      hasImageUrl: inputImageUrls.length > 0,
      imageCount: inputImageUrls.length,
      requestedModel: model,
      resolvedModel,
      usingPairedEndpoint: modelRouting.usingPairedEndpoint,
      falKeySource: falKeySource || 'none',
      continuityMode,
      historyUsed: history.length,
      settingsLocked,
    });

    // Quota and idempotency are reserved atomically by the durable store.
    try {
      const operationId = generateOperationId();
      const filename = `video_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.mp4`;

      // Store operation info
      const operationData = {
        operationId,
        filename,
        prompt: directedPrompt,
        originalPrompt: prompt,
        enhancedPrompt: directedPrompt,
        continuityMode,
        settingsLocked,
        historyUsed: history.length,
        duration,
        aspect_ratio: effectiveAspectRatio,
        resolution: effectiveResolution,
        audio: effectiveAudio,
        userId: req.user.id,
        status: 'processing',
        createdAt: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        sourceImageUrl: inputImageUrls[0] || null,
        sourceImageUrls: inputImageUrls,
        imageCount: inputImageUrls.length,
        generationType: inputImageUrls.length > 1 ? 'reference-to-video' : (inputImageUrls.length === 1 ? 'image-to-video' : 'text-to-video'),
        requestedModel: model,
        resolvedModel,
        modelDisplayName: modelRouting.model?.displayName || resolvedModel,
        usingPairedEndpoint: modelRouting.usingPairedEndpoint
      };
      const pricing = await prisma.aiModel.findUnique({ where: { name: resolvedModel }, select: { pricing: true } });
      const fingerprint = {
        prompt, aspect_ratio, resolution, requestedDuration, audio, negative_prompt: negative_prompt || null,
        imageUrls: inputImageUrls, model, history: req.body.historyIsDerived === true ? null : providedHistory, continuation, professionalize,
        chatId: req.body.chatId || null,
      };
      const admitted = await getMediaJobStore().admit({
        id: operationId, userId: req.user.id, chatId: req.body.chatId || null,
        lane: 'video', kind: 'video.generate', key: requestKey(req), fingerprint,
        quotaUnits: 1000, pricing: pricing?.pricing,
        payload: { model: resolvedModel, prompt: directedPrompt, aspectRatio: effectiveAspectRatio,
          duration, durationSeconds: numericDuration, negativePrompt: effectiveNegativePrompt,
          resolution: effectiveResolution, audio: effectiveAudio, imageUrls: inputImageUrls, filename,
          publicOperation: operationData },
      });
      const operation = publicVideoOperation(admitted.job);
      if (!admitted.created) res.setHeader('Idempotency-Replayed', 'true');
      res.status(202).json({

        success: true,
        operationId: operation.operationId,
        filename: operation.filename,
        status: operation.status,
        quotaManaged: true,
        message: 'Video generation started successfully. This may take 2-5 minutes.',
        estimatedTime: '2-5 minutes',
        checkUrl: `/video/status/${operation.operationId}`,
        prompt: prompt,
        duration: duration,
        aspect_ratio: effectiveAspectRatio,
        requestedModel: model,
        model: resolvedModel,
        modelDisplayName: modelRouting.model?.displayName || resolvedModel,
        usingPairedEndpoint: modelRouting.usingPairedEndpoint,
        sourceImageUrl: inputImageUrls[0] || null,
        sourceImageUrls: inputImageUrls,
        imageCount: inputImageUrls.length,
        generationType: inputImageUrls.length > 1 ? 'reference-to-video' : (inputImageUrls.length === 1 ? 'image-to-video' : 'text-to-video'),
        continuity: {
          mode: continuityMode,
          historyUsed: history.length,
          settingsLocked,
        }
      });

    } catch (apiError) {
      const status = Number(apiError.status) || 503;
      return res.status(status).json({ code: apiError.code || 'E_PROVIDER',
        error: status < 500 ? apiError.message : 'No se pudo iniciar la generación. Reintenta.',
        message: status < 500 ? apiError.message : 'No se pudo iniciar la generación. Reintenta.' });
    }

  } catch (error) {
    console.error('🚨 General video generation error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error.message
    });
  }
});

function normalizeVideoImageUrls(value) {
  const urls = Array.isArray(value) ? value : [value];
  return urls
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
}

async function prepareFalImageUrl(imageUrl) {
  if (!imageUrl) return null;
  if (!imageUrl.includes('localhost') && !imageUrl.includes('127.0.0.1') && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
    return imageUrl;
  }

  console.log('📤 Uploading local image to Fal.ai for processing...');

  const localImagePath = resolveLocalUploadFile(imageUrl);
  if (!localImagePath) {
    throw new Error('Invalid local image path');
  }

  console.log('📁 Local image path:', localImagePath);
  if (!fs.existsSync(localImagePath)) {
    throw new Error(`Local image file not found: ${localImagePath}`);
  }

  const stat = await fs.promises.stat(localImagePath);
  if (!stat.isFile() || stat.size > LIMITS.image) throw Object.assign(new Error('La imagen supera el tamaño permitido.'), { code: 'MEDIA_TOO_LARGE' });
  const imageBuffer = await fs.promises.readFile(localImagePath);
  const fileName = path.basename(localImagePath);
  const fileBlob = new Blob([imageBuffer], { type: getImageMimeType(fileName) });
  const uploadedUrl = await fal.storage.upload(fileBlob);

  console.log('✅ Image uploaded to Fal.ai successfully:', uploadedUrl);
  return uploadedUrl;
}

registerMediaRunner('video.generate', async (ctx, spec) => {
  const { apiKey } = await resolveFalApiKey({ prisma });
  if (!apiKey) throw Object.assign(new Error('Sira Vídeo no está disponible.'), { code: 'E_PROVIDER' });
  fal.config({ credentials: apiKey });
  return createVideoJobRunner({ fal, storage: objectStorage, prepareImageUrl: prepareFalImageUrl, videosDir,
    submit: (endpoint, options) => require('../services/media/fal-submit-once').submitFalQueueOnce(endpoint,
      { input: options.input, signal: options.abortSignal, credentials: apiKey }),
  })(ctx, spec);
});

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

router.post('/cancel/:operationId', authenticateToken, async (req, res) => {
  try {
    const job = await getMediaJobStore().cancel(req.user.id, req.params.operationId);
    if (!job || job.lane !== 'video') return res.status(404).json({ error: 'Operation not found' });
    res.json(publicVideoOperation(job));
  } catch { res.status(503).json({ code: 'E_PROVIDER', error: 'No se pudo cancelar. Reintenta.' }); }
});

router.get('/status/:operationId', authenticateToken, async (req, res) => {
  try {
    const job = await getMediaJobStore().owned(req.params.operationId, req.user.id);
    if (!job || job.lane !== 'video') return res.status(404).json({ error: 'Operation not found' });
    res.json(publicVideoOperation(job));
  } catch { res.status(503).json({ code: 'E_PROVIDER', error: 'No se pudo consultar el vídeo. Reintenta.' }); }
});

// Add a download endpoint for proper file downloads
router.get('/download/:filename', async (req, res) => {
  try {
    const resolved = resolveVideoFile(req.params.filename);
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid video filename' });
    }

    // Prefer a local copy (dev); otherwise stream from R2 (production).
    if (fs.existsSync(resolved.filePath)) {
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
      return streamFile(res, resolved.filePath, { headers: res.getHeaders() });
    }

    if (objectStorage.enabled()) {
      const ref = objectStorage.refFromKey(objectStorage.videoKey(resolved.filename));
      const meta = await objectStorage.stat(ref);
      if (meta && meta.size != null) {
        res.set({
          'Content-Type': 'video/mp4',
          'Content-Disposition': contentDispositionHeader('attachment', resolved.filename),
          'Content-Length': meta.size,
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        const { stream } = await objectStorage.readStream(ref);
        stream.on('error', (err) => {
          console.error(`❌ R2 video download stream error: ${err && err.message}`);
          if (!res.headersSent) res.status(502).json({ error: 'Error downloading video file' });
          else res.destroy();
        });
        // Release the R2 socket if the client aborts mid-download.
        res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
        return stream.pipe(res);
      }
    }

    return res.status(404).json({ error: 'Video file not found' });
  } catch (error) {
    console.error('❌ Error downloading video file:', error);
    res.status(500).json({ error: 'Error downloading video file' });
  }
});

// Also update the watch endpoint with better path handling
router.get('/watch/:filename', async (req, res) => {
  try {
    const resolved = resolveVideoFile(req.params.filename);
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid video filename' });
    }

    // Determine the source: local disk (dev) or R2 (production). Range
    // requests are honoured in both cases for smooth video seeking.
    let fileSize;
    let fromR2 = false;
    if (fs.existsSync(resolved.filePath)) {
      const stat = fs.statSync(resolved.filePath);
      if (!stat.isFile()) {
        return res.status(404).json({ error: 'Video file not found' });
      }
      fileSize = stat.size;
    } else if (objectStorage.enabled()) {
      const ref = objectStorage.refFromKey(objectStorage.videoKey(resolved.filename));
      const meta = await objectStorage.stat(ref);
      if (!meta || meta.size == null) {
        return res.status(404).json({ error: 'Video file not found' });
      }
      fileSize = meta.size;
      fromR2 = true;
    } else {
      return res.status(404).json({ error: 'Video file not found' });
    }

    const r2ref = () => objectStorage.refFromKey(objectStorage.videoKey(resolved.filename));
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
      if (fromR2) {
        res.writeHead(206, head);
        const { stream } = await objectStorage.readStream(r2ref(), { range: `bytes=${range.start}-${range.end}` });
        stream.on('error', (err) => {
          console.error(`Error streaming video range from R2: ${err && err.message}`);
          res.destroy();
        });
        // Release the R2 socket if the client aborts mid-download.
        res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
        return stream.pipe(res);
      }
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
      if (fromR2) {
        res.writeHead(200, head);
        const { stream } = await objectStorage.readStream(r2ref());
        stream.on('error', (err) => {
          console.error(`Error streaming video from R2: ${err && err.message}`);
          res.destroy();
        });
        // Release the R2 socket if the client aborts mid-download.
        res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
        return stream.pipe(res);
      }
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
    // Clamp pagination so non-numeric/negative input can't produce NaN offsets
    // or `pages: NaN`.
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;

    const store = getMediaJobStore();
    const [rows, total] = await Promise.all([
      store.list(req.user.id, 'video', { limit, offset }), store.count(req.user.id, 'video'),
    ]);
    const userOperations = rows.map(publicVideoOperation);

    res.json({
      videos: userOperations,
      pagination: {
        page,
        limit,
        total: total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching video history:', error);
    res.status(500).json({ error: 'Failed to fetch video history' });
  }
});

// Cleanup old operations (run periodically).
// Terminal ops (completed/failed) are evicted after VIDEO_OP_TERMINAL_TTL_MS.
// A hard age ceiling (VIDEO_OP_HARD_MAX_AGE_MS) also evicts ANY operation —
// including ones orphaned in pending/processing (provider never called back,
// worker died) — which the status-only rule previously leaked forever.
const VIDEO_OP_TERMINAL_TTL_MS = Number.parseInt(process.env.SIRAGPT_VIDEO_OP_TTL_MS || String(2 * 60 * 60 * 1000), 10);
const VIDEO_OP_HARD_MAX_AGE_MS = Number.parseInt(process.env.SIRAGPT_VIDEO_OP_MAX_AGE_MS || String(6 * 60 * 60 * 1000), 10);

function cleanupActiveOperations(now = Date.now()) {
  const terminalCutoff = now - VIDEO_OP_TERMINAL_TTL_MS;
  const hardCutoff = now - VIDEO_OP_HARD_MAX_AGE_MS;
  let removed = 0;
  for (const [operationId, operationData] of activeOperations.entries()) {
    const createdAt = new Date(operationData.createdAt).getTime();
    if (Number.isNaN(createdAt)) continue;
    const terminal = operationData.status === 'completed' || operationData.status === 'failed';
    if ((terminal && createdAt < terminalCutoff) || createdAt < hardCutoff) {
      activeOperations.delete(operationId);
      removed += 1;
    }
  }
  return removed;
}

const cleanupInterval = setInterval(() => {
  const removed = cleanupActiveOperations(Date.now());
  if (removed > 0) console.log(`🧹 Cleaned up ${removed} old video operation(s)`);
}, 30 * 60 * 1000); // Run every 30 minutes
cleanupInterval.unref?.();

module.exports = router;
module.exports.INTERNAL = { activeOperations, cleanupActiveOperations };
