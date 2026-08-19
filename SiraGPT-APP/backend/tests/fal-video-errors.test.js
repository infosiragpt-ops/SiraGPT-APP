'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyFalVideoError,
  getFalErrorStatus,
} = require('../src/services/fal/fal-video-errors');

test('classifyFalVideoError maps Unauthorized to non-retryable fal auth failure', () => {
  const classified = classifyFalVideoError(Object.assign(new Error('Unauthorized'), { status: 401 }), {
    endpoint: 'bytedance/seedance-2.0/text-to-video',
  });

  assert.equal(classified.code, 'fal_auth_failed');
  assert.equal(classified.retryable, false);
  assert.equal(classified.statusCode, 401);
  assert.match(classified.message, /FAL_KEY/);
  assert.equal(classified.endpoint, 'bytedance/seedance-2.0/text-to-video');
});

test('classifyFalVideoError maps quota and balance failures to non-retryable quota state', () => {
  const classified = classifyFalVideoError({
    status: 429,
    message: 'insufficient credits',
    body: { message: 'insufficient credits' },
  });

  assert.equal(classified.code, 'fal_quota_or_rate_limit');
  assert.equal(classified.retryable, false);
  assert.equal(classified.statusCode, 429);
});

test('classifyFalVideoError keeps transient 5xx retryable', () => {
  const classified = classifyFalVideoError({ response: { status: 503 }, message: 'Service unavailable' });

  assert.equal(classified.code, 'fal_video_provider_error');
  assert.equal(classified.retryable, true);
  assert.equal(classified.statusCode, 503);
});

test('getFalErrorStatus checks common SDK and axios status locations', () => {
  assert.equal(getFalErrorStatus({ statusCode: 403 }), 403);
  assert.equal(getFalErrorStatus({ response: { status: 422 } }), 422);
  assert.equal(getFalErrorStatus({ body: { statusCode: 401 } }), 401);
  assert.equal(getFalErrorStatus({}), null);
});
