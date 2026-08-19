'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');

const emailService = require('../src/services/email');

const originalConfigured = emailService._configured;
const originalTransporter = emailService.transporter;

afterEach(() => {
  emailService._configured = originalConfigured;
  emailService.transporter = originalTransporter;
});

const USER = {
  id: 'u1',
  name: 'Billing User',
  email: 'billing@example.com',
  plan: 'PRO',
};

test('payment-failure email exposes explicit SMTP success for durable outbox completion', async () => {
  emailService._configured = true;
  emailService.transporter = {
    async sendMail() {
      return { accepted: [USER.email], rejected: [], messageId: 'mail_123' };
    },
  };

  const result = await emailService.sendPaymentFailureAlert(USER, { amount: 5 });

  assert.deepEqual(result, {
    ok: true,
    messageId: 'mail_123',
  });
});

test('payment-failure email exposes a swallowed SMTP failure as an explicit error result', async () => {
  emailService._configured = true;
  emailService.transporter = {
    async sendMail() {
      throw new Error('SMTP connection reset');
    },
  };

  const result = await emailService.sendPaymentFailureAlert(USER, { amount: 5 });

  assert.equal(result.ok, false);
  assert.match(result.error, /SMTP connection reset/);
});

test('payment-failure email reports unconfigured delivery instead of returning undefined', async () => {
  emailService._configured = false;

  const result = await emailService.sendPaymentFailureAlert(USER, { amount: 5 });

  assert.deepEqual(result, {
    ok: false,
    error: 'email_not_configured',
  });
});
