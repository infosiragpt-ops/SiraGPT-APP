'use strict';

const EventEmitter = require('events');

const STAGES = Object.freeze({
  IDLE: 'idle',
  DETECTING_FORMAT: 'detecting_format',
  INGESTING: 'ingesting',
  ANALYZING_DOMAIN: 'analyzing_domain',
  EXTRACTING_ENTITIES: 'extracting_entities',
  ASSESSING_RISKS: 'assessing_risks',
  COMPUTING_QUALITY: 'computing_quality',
  BUILDING_STRUCTURE: 'building_structure',
  COMPARING: 'comparing',
  FINALIZING: 'finalizing',
  COMPLETE: 'complete',
  ERROR: 'error',
});

const STAGE_LABELS = {
  [STAGES.IDLE]: 'Ready',
  [STAGES.DETECTING_FORMAT]: 'Detecting format',
  [STAGES.INGESTING]: 'Ingesting content',
  [STAGES.ANALYZING_DOMAIN]: 'Analyzing domain',
  [STAGES.EXTRACTING_ENTITIES]: 'Extracting entities',
  [STAGES.ASSESSING_RISKS]: 'Assessing risks',
  [STAGES.COMPUTING_QUALITY]: 'Computing quality metrics',
  [STAGES.BUILDING_STRUCTURE]: 'Building document structure',
  [STAGES.COMPARING]: 'Comparing documents',
  [STAGES.FINALIZING]: 'Finalizing analysis',
  [STAGES.COMPLETE]: 'Analysis complete',
  [STAGES.ERROR]: 'Error',
};

const HEARTBEAT_INTERVAL_MS = 15_000;

class CoworkProgressStream extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.analysisId = opts.analysisId || `analysis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.currentStage = STAGES.IDLE;
    this.stageHistory = [];
    this.startedAt = Date.now();
    this.completedAt = null;
    this.error = null;
    this.results = null;
    this._heartbeat = null;
  }

  start() {
    this.startedAt = Date.now();
    this.emit('start', {
      analysisId: this.analysisId,
      timestamp: this.startedAt,
    });
    this._startHeartbeat();
    return this;
  }

  advance(stage, details = {}) {
    const prev = this.currentStage;
    this.currentStage = stage;

    const event = {
      analysisId: this.analysisId,
      stage,
      stageLabel: STAGE_LABELS[stage] || stage,
      previousStage: prev,
      timestamp: Date.now(),
      elapsedMs: Date.now() - this.startedAt,
      ...details,
    };

    this.stageHistory.push(event);
    this.emit('stage', event);
    return this;
  }

  complete(results = {}) {
    this.currentStage = STAGES.COMPLETE;
    this.completedAt = Date.now();
    this.results = results;

    this._stopHeartbeat();

    const event = {
      analysisId: this.analysisId,
      stage: STAGES.COMPLETE,
      stageLabel: STAGE_LABELS[STAGES.COMPLETE],
      timestamp: this.completedAt,
      elapsedMs: this.completedAt - this.startedAt,
      results,
    };

    this.stageHistory.push(event);
    this.emit('complete', event);
    return this;
  }

  fail(error) {
    this.currentStage = STAGES.ERROR;
    this.error = typeof error === 'string' ? error : error?.message || 'Unknown error';
    this.completedAt = Date.now();

    this._stopHeartbeat();

    const event = {
      analysisId: this.analysisId,
      stage: STAGES.ERROR,
      stageLabel: STAGE_LABELS[STAGES.ERROR],
      timestamp: this.completedAt,
      elapsedMs: this.completedAt - this.startedAt,
      error: this.error,
    };

    this.stageHistory.push(event);
    this.emit('error', event);
    return this;
  }

  getStatus() {
    return {
      analysisId: this.analysisId,
      stage: this.currentStage,
      stageLabel: STAGE_LABELS[this.currentStage] || this.currentStage,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      elapsedMs: Date.now() - this.startedAt,
      stageCount: this.stageHistory.length,
      error: this.error,
    };
  }

  toSSEFormat() {
    const status = this.getStatus();
    return {
      event: 'cowork_progress',
      data: JSON.stringify(status),
    };
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeat = setInterval(() => {
      this.emit('heartbeat', {
        analysisId: this.analysisId,
        stage: this.currentStage,
        elapsedMs: Date.now() - this.startedAt,
        timestamp: Date.now(),
      });
    }, HEARTBEAT_INTERVAL_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  destroy() {
    this._stopHeartbeat();
    this.removeAllListeners();
  }
}

function createProgressStream(opts = {}) {
  return new CoworkProgressStream(opts);
}

function writeSSE(res, stream) {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy/load-balancer response buffering (Caddy/nginx) so progress
    // frames flush to the client immediately instead of being held — otherwise
    // a buffering reverse proxy can stall the stream and leave it looking
    // zombie'd. Mirrors the SSE setup on the main chat path in routes/ai.js.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  function onStage(event) {
    if (res.writableEnded) return;
    res.write(`event: cowork_stage\ndata: ${JSON.stringify(event)}\n\n`);
  }

  function onComplete(event) {
    if (res.writableEnded) return;
    res.write(`event: cowork_complete\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }

  function onError(event) {
    if (res.writableEnded) return;
    res.write(`event: cowork_error\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }

  function onHeartbeat(event) {
    if (res.writableEnded) return;
    res.write(`event: heartbeat\ndata: ${JSON.stringify(event)}\n\n`);
  }

  stream.on('stage', onStage);
  stream.on('complete', onComplete);
  stream.on('error', onError);
  stream.on('heartbeat', onHeartbeat);

  res.on('close', () => {
    stream.off('stage', onStage);
    stream.off('complete', onComplete);
    stream.off('error', onError);
    stream.off('heartbeat', onHeartbeat);
    stream.destroy();
  });
}

module.exports = {
  CoworkProgressStream,
  createProgressStream,
  writeSSE,
  STAGES,
  STAGE_LABELS,
};
