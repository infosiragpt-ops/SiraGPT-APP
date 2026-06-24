const Stripe = require('stripe');
const { logger: defaultLogger } = require('../middleware/logger');
const {
  redactErrorMessage,
  redactString,
} = require('../utils/secret-redactor');

const STRIPE_API_VERSION = '2026-02-25.clover';
const AUTH_LOG_THROTTLE_MS = 60 * 1000;

function compactObject(value) {
  const out = {};
  for (const [key, child] of Object.entries(value || {})) {
    if (child !== undefined && child !== null && child !== '') out[key] = child;
  }
  return out;
}

function sanitizeLogContext(context = {}) {
  const out = {};
  for (const [key, value] of Object.entries(context || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else {
      out[key] = redactString(String(value), { maxLen: 180 });
    }
  }
  return out;
}

function hasMaskedStripeKey(value) {
  if (!value) return false;
  const key = String(value).trim();
  return key === 'sk_test_...'
    || key === 'sk_live_...'
    || key.includes('*')
    || key.includes('\u2026')
    || /\b(?:redacted|masked)\b/i.test(key);
}

function hasUsableStripeSecret(value) {
  if (!value || !String(value).trim()) return false;
  if (hasMaskedStripeKey(value)) return false;
  return /^(sk|rk)_(test|live)_/.test(String(value).trim());
}

function stripeRequestId(error) {
  return error?.requestId
    || error?.request_id
    || error?.raw?.requestId
    || error?.raw?.request_id
    || error?.raw?.headers?.['request-id']
    || error?.headers?.['request-id']
    || null;
}

function sanitizeStripeError(error) {
  if (!error) return null;

  const raw = typeof error === 'object' ? error : {};
  return compactObject({
    name: redactString(raw.name || 'Error', { maxLen: 120 }),
    type: redactString(raw.type || raw.rawType, { maxLen: 120 }),
    code: redactString(raw.code, { maxLen: 120 }),
    statusCode: raw.statusCode || raw.status || raw.raw?.statusCode,
    requestId: redactString(stripeRequestId(raw), { maxLen: 160 }),
    declineCode: redactString(raw.decline_code || raw.declineCode, { maxLen: 120 }),
    param: redactString(raw.param, { maxLen: 120 }),
    message: redactErrorMessage(error),
  });
}

function isStripeLikeError(error) {
  if (!error || typeof error !== 'object') return false;
  return Boolean(
    error.isStripeOperationalError
    || error.type
    || error.rawType
    || /^Stripe/.test(error.name || '')
    || (error.raw && (error.raw.type || error.raw.statusCode))
  );
}

function isStripeAuthError(error) {
  if (!error || typeof error !== 'object') return false;
  const message = String(error.message || '');
  return error.type === 'StripeAuthenticationError'
    || error.name === 'StripeAuthenticationError'
    || error.statusCode === 401
    || /invalid api key|api key provided/i.test(message);
}

class StripeOperationalError extends Error {
  constructor({
    code,
    message,
    publicError = 'Payment provider unavailable',
    publicMessage = 'Payment processing is temporarily unavailable. Please contact support.',
    statusCode = 503,
    operation = null,
    retryable = false,
    providerError = null,
  }) {
    super(message);
    this.name = 'StripeOperationalError';
    this.code = code;
    this.publicError = publicError;
    this.publicMessage = publicMessage;
    this.statusCode = statusCode;
    this.operation = operation;
    this.retryable = retryable;
    this.providerError = providerError;
    this.isStripeOperationalError = true;
  }
}

class StripeService {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.logger = options.logger || defaultLogger;
    this.stripeFactory = options.stripeFactory || ((secret, config) => new Stripe(secret, config));
    this.lastAuthFailureLogAt = 0;
    this.configurationState = 'configured';
    this.configurationIssue = null;

    const secretKey = this.env.STRIPE_SECRET_KEY ? String(this.env.STRIPE_SECRET_KEY).trim() : '';
    this.isConfigured = hasUsableStripeSecret(secretKey);
    this.demoAllowed = this.env.NODE_ENV !== 'production'
      && this.env.ALLOW_STRIPE_DEMO === 'true';

    if (!this.isConfigured) {
      this.configurationState = secretKey ? 'invalid' : 'missing';
      this.configurationIssue = hasMaskedStripeKey(secretKey)
        ? 'STRIPE_SECRET_KEY looks masked or redacted'
        : 'STRIPE_SECRET_KEY is missing or malformed';
      this.stripe = null;
      this.logConfigurationWarning(secretKey);
    } else {
      this.stripe = this.stripeFactory(secretKey, {
        apiVersion: STRIPE_API_VERSION,
      });
    }

    this.plans = {
      PRO: {
        name: 'Go Plan',
        price: 500,
        credits: 500000,
        features: ['500,000 tokens per month', 'All AI models', 'Priority support', 'Advanced features']
      },
      PRO_MAX: {
        name: 'Plus Plan',
        price: 2000,
        credits: 1000000,
        features: ['1,000,000 tokens per month', 'All AI models', 'Priority support', 'Advanced features', 'Enhanced rate limits']
      },
      ENTERPRISE: {
        name: 'Pro Plan',
        price: 20000,
        credits: 10000000,
        features: ['10,000,000 tokens per month', 'All features', 'Dedicated support', 'Custom integrations', 'SLA guaranteed']
      }
    };
  }

  logConfigurationWarning(secretKey) {
    const payload = {
      provider: 'stripe',
      state: this.configurationState,
      issue: this.configurationIssue,
      hasSecret: Boolean(secretKey),
      demoAllowed: this.demoAllowed,
    };

    if (this.env.NODE_ENV === 'production') {
      this.logger.error(
        payload,
        '[stripe] payment endpoints disabled; set a valid STRIPE_SECRET_KEY'
      );
    } else if (this.demoAllowed) {
      this.logger.warn(
        payload,
        '[stripe] payments running in local demo mode'
      );
    } else {
      this.logger.warn(
        payload,
        '[stripe] payment endpoints disabled until STRIPE_SECRET_KEY is configured'
      );
    }
  }

  assertConfigured(operation = 'stripe') {
    if (this.isConfigured && this.stripe) return;
    throw new StripeOperationalError({
      code: 'STRIPE_NOT_CONFIGURED',
      message: `${this.configurationIssue || 'Stripe is not configured'}.`,
      publicError: 'Stripe not configured',
      publicMessage: 'Payment processing is not available. Please contact support.',
      statusCode: 503,
      operation,
      retryable: false,
      providerError: compactObject({
        state: this.configurationState,
        issue: this.configurationIssue,
      }),
    });
  }

  markAuthenticationFailure() {
    this.isConfigured = false;
    this.configurationState = 'invalid';
    this.configurationIssue = 'STRIPE_SECRET_KEY was rejected by Stripe';
    // The latch used to be PERMANENT: one auth failure disabled Stripe
    // until a full backend restart, so a key rotation never recovered.
    // Re-arm after a cooldown so the next call re-probes the key.
    const REPROBE_COOLDOWN_MS = 5 * 60 * 1000;
    if (this._reprobeTimer) clearTimeout(this._reprobeTimer);
    this._reprobeTimer = setTimeout(() => {
      this._reprobeTimer = null;
      if (this.configurationState !== 'invalid') return;
      const secretKey = process.env.STRIPE_SECRET_KEY;
      if (hasUsableStripeSecret(secretKey)) {
        this.isConfigured = true;
        this.configurationState = 'reprobing';
        this.configurationIssue = null;
      }
    }, REPROBE_COOLDOWN_MS);
    if (typeof this._reprobeTimer?.unref === 'function') this._reprobeTimer.unref();
  }

  shouldLogAuthFailure() {
    const now = Date.now();
    if (now - this.lastAuthFailureLogAt < AUTH_LOG_THROTTLE_MS) return false;
    this.lastAuthFailureLogAt = now;
    return true;
  }

  toOperationalError(error, operation = 'stripe') {
    if (error?.isStripeOperationalError) return error;

    const providerError = sanitizeStripeError(error);

    if (isStripeAuthError(error)) {
      this.markAuthenticationFailure();
      return new StripeOperationalError({
        code: 'STRIPE_AUTHENTICATION_FAILED',
        message: 'Stripe rejected STRIPE_SECRET_KEY. Rotate the secret and restart the backend.',
        publicError: 'Payment provider unavailable',
        publicMessage: 'Payment processing is temporarily unavailable. Please contact support.',
        statusCode: 503,
        operation,
        retryable: false,
        providerError,
      });
    }

    const type = error?.type || error?.name || '';
    if (type === 'StripeRateLimitError') {
      return new StripeOperationalError({
        code: 'STRIPE_RATE_LIMITED',
        message: 'Stripe rate limit exceeded.',
        statusCode: 503,
        operation,
        retryable: true,
        providerError,
      });
    }

    if (type === 'StripeConnectionError' || type === 'StripeAPIError') {
      return new StripeOperationalError({
        code: 'STRIPE_PROVIDER_UNAVAILABLE',
        message: 'Stripe provider temporarily unavailable.',
        statusCode: 503,
        operation,
        retryable: true,
        providerError,
      });
    }

    if (type === 'StripeSignatureVerificationError') {
      return new StripeOperationalError({
        code: 'STRIPE_WEBHOOK_SIGNATURE_INVALID',
        message: providerError?.message || 'Invalid Stripe webhook signature.',
        publicError: 'Invalid webhook signature',
        publicMessage: 'Invalid Stripe webhook signature.',
        statusCode: 400,
        operation,
        retryable: false,
        providerError,
      });
    }

    if (type === 'StripeCardError') {
      return new StripeOperationalError({
        code: 'STRIPE_CARD_ERROR',
        message: providerError?.message || 'Stripe card error.',
        publicError: 'Payment required',
        publicMessage: providerError?.message || 'The payment method was declined.',
        statusCode: 402,
        operation,
        retryable: false,
        providerError,
      });
    }

    if (type === 'StripeInvalidRequestError') {
      return new StripeOperationalError({
        code: 'STRIPE_INVALID_REQUEST',
        message: 'Stripe rejected the request.',
        publicError: 'Payment request failed',
        publicMessage: 'The payment request could not be completed. Please contact support.',
        statusCode: 400,
        operation,
        retryable: false,
        providerError,
      });
    }

    return new StripeOperationalError({
      code: 'STRIPE_PROVIDER_ERROR',
      message: providerError?.message || 'Stripe provider error.',
      statusCode: 502,
      operation,
      retryable: false,
      providerError,
    });
  }

  logStripeError(operation, error, context = {}, options = {}) {
    const operationalError = this.toOperationalError(error, operation);
    if (operationalError.code === 'STRIPE_AUTHENTICATION_FAILED' && !this.shouldLogAuthFailure()) {
      return operationalError;
    }

    const level = options.level
      || (operationalError.statusCode >= 500 ? 'error' : 'warn');

    const payload = {
      provider: 'stripe',
      operation,
      code: operationalError.code,
      statusCode: operationalError.statusCode,
      retryable: operationalError.retryable,
      error: operationalError.providerError,
      context: sanitizeLogContext(context),
    };

    const log = typeof this.logger[level] === 'function'
      ? this.logger[level].bind(this.logger)
      : this.logger.error.bind(this.logger);

    log(payload, `[stripe] ${operation} failed`);
    return operationalError;
  }

  toHttpError(error, opts = {}) {
    const operation = opts.operation || error?.operation || 'stripe';
    const operationalError = this.toOperationalError(error, operation);
    const body = compactObject({
      error: operationalError.publicError,
      message: operationalError.publicMessage,
      code: operationalError.code,
      retryable: operationalError.retryable,
      requestId: opts.requestId,
      fallbackAvailable: operationalError.code === 'STRIPE_NOT_CONFIGURED' ? true : undefined,
    });

    return {
      statusCode: operationalError.statusCode,
      body,
    };
  }

  async callStripe(operation, fn, context = {}) {
    this.assertConfigured(operation);
    try {
      return await fn();
    } catch (error) {
      throw this.logStripeError(operation, error, context);
    }
  }

  async ping() {
    return this.callStripe('ping', () => this.stripe.products.list({ limit: 1 }));
  }

  async createOrUpdateProducts() {
    const results = {};

    for (const [planKey, planData] of Object.entries(this.plans)) {
      const result = await this.callStripe(
        'createOrUpdateProducts',
        async () => {
          const products = await this.stripe.products.list({
            active: true,
            limit: 100
          });

          let product = products.data.find(p => p.metadata.plan === planKey);

          if (!product) {
            product = await this.stripe.products.create({
              name: planData.name,
              description: `${planData.name} subscription with ${planData.credits.toLocaleString()} monthly API calls`,
              metadata: {
                plan: planKey,
                credits: planData.credits.toString()
              }
            });
          }

          const prices = await this.stripe.prices.list({
            product: product.id,
            active: true
          });

          let price = prices.data.find(p =>
            p.unit_amount === planData.price &&
            p.recurring?.interval === 'month'
          );

          if (!price) {
            price = await this.stripe.prices.create({
              product: product.id,
              unit_amount: planData.price,
              currency: 'usd',
              recurring: {
                interval: 'month'
              },
              metadata: {
                plan: planKey
              }
            });
          }

          return {
            product,
            price,
            planData
          };
        },
        { plan: planKey }
      );

      results[planKey] = result;
    }

    return results;
  }

  async createCustomer(email, name, userId) {
    return this.callStripe(
      'createCustomer',
      () => this.stripe.customers.create({
        email,
        name,
        metadata: {
          userId
        }
      }),
      { userId, email }
    );
  }

  async createCheckoutSession(priceId, customerId, userId, plan, successUrl, cancelUrl) {
    return this.callStripe(
      'createCheckoutSession',
      () => this.stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{
          price: priceId,
          quantity: 1,
        }],
        mode: 'subscription',
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          userId,
          plan
        },
        subscription_data: {
          metadata: {
            userId,
            plan
          }
        }
      }),
      { userId, customerId, priceId, plan }
    );
  }

  async createPaymentIntent(amount, customerId, userId, plan) {
    return this.callStripe(
      'createPaymentIntent',
      () => this.stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        customer: customerId,
        metadata: {
          userId,
          plan
        },
        automatic_payment_methods: {
          enabled: true,
        },
      }),
      { userId, customerId, amount, plan }
    );
  }

  async retrieveCustomer(customerId) {
    return this.callStripe(
      'retrieveCustomer',
      () => this.stripe.customers.retrieve(customerId),
      { customerId }
    );
  }

  async retrieveCheckoutSession(sessionId) {
    return this.callStripe(
      'retrieveCheckoutSession',
      () => this.stripe.checkout.sessions.retrieve(sessionId),
      { sessionId }
    );
  }

  async retrieveSubscription(subscriptionId) {
    return this.callStripe(
      'retrieveSubscription',
      () => this.stripe.subscriptions.retrieve(subscriptionId),
      { subscriptionId }
    );
  }

  async updateSubscription(subscriptionId, params, operation = 'updateSubscription') {
    return this.callStripe(
      operation,
      () => this.stripe.subscriptions.update(subscriptionId, params),
      { subscriptionId }
    );
  }

  async cancelSubscription(subscriptionId) {
    return this.updateSubscription(
      subscriptionId,
      { cancel_at_period_end: true },
      'cancelSubscription'
    );
  }

  async reactivateSubscription(subscriptionId) {
    return this.updateSubscription(
      subscriptionId,
      { cancel_at_period_end: false },
      'reactivateSubscription'
    );
  }

  async retrieveUpcomingInvoice(paramsOrCustomerId) {
    const params = typeof paramsOrCustomerId === 'string'
      ? { customer: paramsOrCustomerId }
      : paramsOrCustomerId;
    return this.callStripe(
      'retrieveUpcomingInvoice',
      () => this.stripe.invoices.retrieveUpcoming(params),
      { customerId: params?.customer, subscriptionId: params?.subscription }
    );
  }

  async getUpcomingInvoice(customerId) {
    return this.retrieveUpcomingInvoice(customerId);
  }

  async listCustomerSubscriptions(customerId) {
    return this.callStripe(
      'listCustomerSubscriptions',
      () => this.stripe.subscriptions.list({
        customer: customerId,
        status: 'all'
      }),
      { customerId }
    );
  }

  async listInvoices(params = {}) {
    return this.callStripe(
      'listInvoices',
      () => this.stripe.invoices.list(params),
      {
        customerId: params.customer,
        subscriptionId: params.subscription,
        limit: params.limit,
      }
    );
  }

  async retrieveInvoice(invoiceId) {
    return this.callStripe(
      'retrieveInvoice',
      () => this.stripe.invoices.retrieve(invoiceId),
      { invoiceId }
    );
  }

  constructWebhookEvent(payload, signature) {
    if (!this.env.STRIPE_WEBHOOK_SECRET) {
      throw new StripeOperationalError({
        code: 'STRIPE_WEBHOOK_NOT_CONFIGURED',
        message: 'STRIPE_WEBHOOK_SECRET is not configured.',
        publicError: 'Stripe webhook not configured',
        publicMessage: 'Stripe webhook verification is not configured.',
        statusCode: 503,
        operation: 'constructWebhookEvent',
        retryable: false,
      });
    }

    try {
      if (!this.stripe && hasUsableStripeSecret('sk_test_webhook_verifier')) {
        this.stripe = this.stripeFactory('sk_test_webhook_verifier', {
          apiVersion: STRIPE_API_VERSION,
        });
      }
      return this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      throw this.logStripeError(
        'constructWebhookEvent',
        error,
        { hasSignature: Boolean(signature) },
        { level: 'warn' }
      );
    }
  }
}

const stripeService = new StripeService();

module.exports = stripeService;
module.exports.StripeService = StripeService;
module.exports.StripeOperationalError = StripeOperationalError;
module.exports.sanitizeStripeError = sanitizeStripeError;
module.exports.isStripeLikeError = isStripeLikeError;
module.exports.hasUsableStripeSecret = hasUsableStripeSecret;
module.exports.STRIPE_API_VERSION = STRIPE_API_VERSION;
