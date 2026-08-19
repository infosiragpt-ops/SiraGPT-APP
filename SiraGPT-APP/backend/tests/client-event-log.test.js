'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeClientEvent,
  buildClientEventAuditEntry,
  isExpectedAuthClientEvent,
  isExpectedQuotaClientEvent,
  redactText,
} = require('../src/services/client-event-log');

describe('client-event-log', () => {
  test('redacts common secrets from strings', () => {
    const out = redactText('Bearer abc.def.ghi sk_live_secret user@example.com');
    assert.match(out, /Bearer \[REDACTED\]/);
    assert.match(out, /\[REDACTED:key\]/);
    assert.match(out, /\[REDACTED:email\]/);
    assert.doesNotMatch(out, /sk_live_secret/);
  });

  test('sanitizes event shape and sensitive nested keys', () => {
    const event = sanitizeClientEvent({
      source: 'api',
      severity: 'fatal',
      page: '/chat',
      action: 'send_message',
      message: 'failed with Bearer abc.def.ghi',
      requestId: 'req_123',
      status: 500,
      method: 'POST',
      endpoint: '/api/ai/generate',
      extra: {
        password: 'secret',
        nested: { authorization: 'Bearer x.y.z', safe: 'ok' },
      },
    });

    assert.equal(event.source, 'api');
    assert.equal(event.severity, 'fatal');
    assert.equal(event.status, 500);
    assert.equal(event.extra.password, '[REDACTED]');
    assert.equal(event.extra.nested.authorization, '[REDACTED]');
    assert.equal(event.extra.nested.safe, 'ok');
    assert.doesNotMatch(event.message, /Bearer abc/);
  });

  test('builds audit entry with observability tags', () => {
    const event = sanitizeClientEvent({
      source: 'api',
      severity: 'error',
      page: '/chat',
      message: 'boom',
      requestId: 'req_abc',
      status: 503,
    });
    const entry = buildClientEventAuditEntry(event, { requestId: 'req_http' });

    assert.equal(entry.action, 'api_error_reported');
    assert.equal(entry.resource, 'client_event');
    assert.equal(entry.resourceId, 'req_abc');
    assert.ok(entry.tags.includes('observability'));
    assert.ok(entry.tags.includes('api-error'));
    assert.ok(entry.tags.includes('server-error'));
    assert.equal(entry.metadata.requestId, 'req_abc');
  });

  test('classifies expected auth API failures as non-alerting noise', () => {
    const invalidLogin = sanitizeClientEvent({
      source: 'api',
      status: 401,
      method: 'POST',
      endpoint: '/auth/login',
      message: 'Invalid credentials',
    });
    const staleVideoToken = sanitizeClientEvent({
      source: 'api',
      status: 401,
      method: 'POST',
      endpoint: '/api/ai/generate-video',
      message: 'Invalid or expired token',
    });
    const realForbidden = sanitizeClientEvent({
      source: 'api',
      status: 403,
      method: 'GET',
      endpoint: '/admin/users',
      message: 'Admin access required',
    });

    assert.equal(isExpectedAuthClientEvent(invalidLogin), true);
    assert.equal(isExpectedAuthClientEvent(staleVideoToken), true);
    assert.equal(isExpectedAuthClientEvent(realForbidden), false);
  });

  test('classifies expected plan-quota API failures as non-alerting noise', () => {
    const imageQuota = sanitizeClientEvent({
      source: 'api',
      status: 429,
      method: 'POST',
      endpoint: '/api/ai/generate-image',
      message: 'Monthly API limit exceeded',
      extra: { usage: { current: 100, limit: 100 } },
    });
    const videoQuota = sanitizeClientEvent({
      source: 'api',
      status: 429,
      method: 'POST',
      endpoint: '/ai/generate-video',
      message: 'Monthly video generation limit exceeded',
    });
    const realServerError = sanitizeClientEvent({
      source: 'api',
      status: 503,
      method: 'POST',
      endpoint: '/ai/generate-image',
      message: 'upstream unavailable',
    });

    assert.equal(isExpectedQuotaClientEvent(imageQuota), true);
    assert.equal(isExpectedQuotaClientEvent(videoQuota), true);
    assert.equal(isExpectedQuotaClientEvent(realServerError), false);
  });
});
