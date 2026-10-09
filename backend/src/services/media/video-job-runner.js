'use strict';

const { extractFalVideoUrl, buildFalVideoInputPayload } = require('../fal-video-model-catalog');
const { classifyFalVideoError } = require('../fal/fal-video-errors');
const { downloadAndStore } = require('./transfer');

const pause = (ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal });

function createVideoJobRunner({ fal, storage, prepareImageUrl, videosDir, submit = (endpoint, options) => fal.queue.submit(endpoint, options), path = require('node:path') }) {
  return async function runVideoJob(ctx, spec) {
    let state = ctx.job.checkpoint || {};
    if (state.dispatchState === 'submitting' && !state.providerRequestId) {
      throw Object.assign(new Error('No se confirmó la aceptación del proveedor.'), { code: 'MEDIA_DISPATCH_UNKNOWN' });
    }
    let endpoint = spec.model;
    let requestId = state.providerRequestId;
    try {
      if (!requestId) {
        const images = state.processedImageUrls || (await Promise.all((spec.imageUrls || []).map(prepareImageUrl))).filter(Boolean);
        await ctx.checkpoint({ processedImageUrls: images }, { phase: 'Preparando', progress: 5 });
        const request = buildFalVideoInputPayload({ endpoint, prompt: spec.prompt, aspectRatio: spec.aspectRatio, duration: spec.duration,
          negativePrompt: spec.negativePrompt, imageUrl: images[0] || null, imageUrls: images, resolution: spec.resolution, audio: spec.audio });
        // A persisted intent precedes the paid request. A crash in this window
        // is indeterminate, never permission for a blind second generation.
        await ctx.checkpoint({ dispatchState: 'submitting' }, { phase: 'Generando', progress: 10 });
        let accepted;
        try { accepted = await submit(endpoint, { input: request, abortSignal: ctx.signal }); }
        catch (error) {
          if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
            await ctx.checkpoint({ dispatchState: 'rejected' });
          }
          throw error;
        }
        requestId = accepted?.request_id || accepted?.requestId;
        if (!requestId) throw Object.assign(new Error('No se recibió el identificador del proveedor.'), { code: 'MEDIA_DISPATCH_UNKNOWN' });
        await ctx.checkpoint({ providerRequestId: requestId, dispatchState: 'submitted' });
      }
      const deadline = Date.now() + Math.max(0, 15 * 60 * 1000 - Number(ctx.job.age_ms || 0));
      let result = state.providerResult;
      while (!result) {
        ctx.signal.throwIfAborted();
        if (Date.now() > deadline) throw Object.assign(new Error('La generación no terminó a tiempo.'), { code: 'E_TIMEOUT' });
        const status = await fal.queue.status(endpoint, { requestId, logs: false, abortSignal: ctx.signal });
        if (status.status === 'COMPLETED') {
          result = await fal.queue.result(endpoint, { requestId, abortSignal: ctx.signal });
          // Persist the upstream result before asset copy. Download failure or
          // a restart can then resume without submitting another paid request.
          await ctx.checkpoint({ providerResult: result, dispatchState: 'returned' }, { phase: 'Posproceso', progress: 90 });
        } else if (['FAILED', 'CANCELLED'].includes(status.status)) {
          throw Object.assign(new Error('El proveedor no pudo completar la generación.'), { code: status.status === 'CANCELLED' ? 'E_CANCELLED' : 'E_PROVIDER' });
        } else {
          await ctx.progress({ stage: 'Generando', progress: 15 });
          await pause(1500, ctx.signal);
        }
      }
      const url = extractFalVideoUrl(result);
      if (!url) throw Object.assign(new Error('El proveedor no devolvió un vídeo.'), { code: 'E_PROVIDER' });
      const video = result?.data?.video || result?.video || {};
      const meta = await downloadAndStore(url, { key: storage.videoKey(spec.filename), localPath: path.join(videosDir, spec.filename), signal: ctx.signal, storage });
      return {
        video_url: `/video/watch/${spec.filename}`, download_url: `/video/download/${spec.filename}`, filename: spec.filename,
        duration: spec.duration, file_size: meta.sizeBytes, resolution: video.width && video.height ? `${video.width}x${video.height}` : spec.resolution,
        aspect_ratio: spec.aspectRatio, audio: Boolean(spec.audio), imageCount: (spec.imageUrls || []).length,
        generationType: spec.imageUrls?.length > 1 ? 'reference-to-video' : spec.imageUrls?.length ? 'image-to-video' : 'text-to-video',
        requestedModel: spec.publicOperation.requestedModel, model: endpoint, modelDisplayName: spec.publicOperation.modelDisplayName,
        prompt: spec.prompt, originalPrompt: spec.publicOperation.originalPrompt, enhanced_prompt: spec.prompt,
        continuityMode: spec.publicOperation.continuityMode, settingsLocked: spec.publicOperation.settingsLocked, completedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (ctx.signal.reason?.code === 'E_CANCELLED' && requestId) {
        // Cancel via the persisted ID even if Stop arrived on another replica.
        await fal.queue.cancel(endpoint, { requestId }).catch(() => {});
      }
      if (['LEASE_LOST', 'E_CANCELLED', 'MEDIA_DISPATCH_UNKNOWN'].includes(error?.code)) throw error;
      const classified = classifyFalVideoError(error, { endpoint });
      error.publicMessage = classified.message;
      error.code = error.code || classified.code || 'E_PROVIDER';
      throw error;
    }
  };
}
function publicVideoOperation(job) {
  if (!job) return null;
  const status = job.status === 'queued' || job.status === 'running' ? 'processing' : job.status === 'unknown' ? 'failed' : job.status;
  return { ...job.payload.publicOperation, operationId: job.id, status, createdAt: job.created_at, updatedAt: job.updated_at,
    ...(job.result ? { result: job.result } : {}), ...(job.error_code ? { error: job.error_message, errorDetails: { code: job.error_code, retryable: job.status !== 'unknown' } } : {}),
    phase: job.cancel_requested_at && ['queued', 'running'].includes(job.status) ? 'Cancelando' : job.phase, progress: job.progress, quotaManaged: true,
    cost: { estimatedUSD: job.estimated_cost_usd == null ? null : Number(job.estimated_cost_usd), actualUSD: job.actual_cost_usd == null ? null : Number(job.actual_cost_usd), source: job.cost_source },
  };
}
module.exports = { createVideoJobRunner, publicVideoOperation };
