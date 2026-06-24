'use strict';

/**
 * SSE Upload Progress — Real-time Server-Sent Events endpoint
 * for tracking file processing progress without polling.
 *
 * Clients connect with: GET /api/files/progress-stream?fileIds=id1,id2,id3
 *
 * Events emitted:
 *   event: stage        { fileId, stage, timestamp }
 *   event: complete     { fileId, success, extractedChars }
 *   event: error        { fileId, error }
 *   event: heartbeat    { ts }  (every 15s while idle)
 */

const prisma = require('../config/database');

function progressStream(req, res) {
  const userId = req.user?.id;
  const fileIdsParam = String(req.query.fileIds || '');
  const fileIds = fileIdsParam.split(',').map(s => s.trim()).filter(Boolean);

  if (fileIds.length === 0) {
    res.status(400).json({ error: 'Missing fileIds parameter' });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  let lastKnown = new Map();
  const handled = new Set();
  let autoCleanupTimer = null;

  // On disconnect, actually tear the stream down: previously this only set
  // closed=true and left both intervals + the 5-min timeout running forever
  // (one leaked interval pair per dropped client).
  req.on('close', () => { closed = true; cleanup(); });

  // Heartbeat
  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    res.write(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`);
  }, 15000);
  heartbeatTimer.unref?.();

  // Poll loop — check every 500ms
  const pollTimer = setInterval(async () => {
    if (closed) return;
    try {
      const records = await prisma.file.findMany({
        where: { id: { in: fileIds }, userId },
        select: { id: true, processingStatus: true, extractedTextLength: true },
      });

      let allDone = true;
      for (const rec of records) {
        const current = rec.processingStatus || 'unknown';
        const previous = lastKnown.get(rec.id) || '';

        if (current !== previous) {
          lastKnown.set(rec.id, current);
          const event = JSON.stringify({
            fileId: rec.id,
            stage: current,
            extractedChars: rec.extractedTextLength || 0,
            timestamp: Date.now(),
          });
          res.write(`event: stage\ndata: ${event}\n\n`);

          if (current === 'ready') {
            handled.add(rec.id);
            const complete = JSON.stringify({
              fileId: rec.id,
              success: true,
              extractedChars: rec.extractedTextLength || 0,
            });
            res.write(`event: complete\ndata: ${complete}\n\n`);
          } else if (current === 'error') {
            handled.add(rec.id);
            const error = JSON.stringify({
              fileId: rec.id,
              error: 'Processing failed',
            });
            res.write(`event: error\ndata: ${error}\n\n`);
          }
        }

        if (!handled.has(rec.id)) allDone = false;
      }

      if (allDone && records.length === fileIds.length) {
        // Send a final "all complete" event
        res.write(`event: done\ndata: {"fileIds":${JSON.stringify(fileIds)},"allComplete":true}\n\n`);
        cleanup();
      }
    } catch (err) {
      if (!closed) {
        res.write(`event: error\ndata: {"error":"polling failed"}\n\n`);
      }
    }
  }, 500);
  pollTimer.unref?.();

  function cleanup() {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    if (autoCleanupTimer) {
      clearTimeout(autoCleanupTimer);
      autoCleanupTimer = null;
    }
    if (!closed) {
      try { res.end(); } catch (_) {}
      closed = true;
    }
  }

  // Auto-cleanup after 5 min max
  autoCleanupTimer = setTimeout(() => {
    if (!closed) {
      res.write(`event: timeout\ndata: {"message":"Progress stream timed out"}\n\n`);
      cleanup();
    }
  }, 300000);
  autoCleanupTimer.unref?.();
}

module.exports = { progressStream };