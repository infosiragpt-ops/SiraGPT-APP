const nodemailer = require('nodemailer');

// Header-injection hardening. Nodemailer 8 tightened CRLF / control-char
// validation in several places (transport name, envelope size, address
// parser). Defensive sanitizer for user-supplied values that flow into
// header positions (subject / display names) so we never hand bytes to
// nodemailer that could trip its stricter validators or smuggle headers.
function sanitizeHeader(value, max = 200) {
  if (value == null) return '';
  return String(value)
    .replace(/[\r\n\x00-\x1F\x7F]+/g, ' ')
    .trim()
    .slice(0, max);
}

// Sender display name for every outgoing mail (SMTP_FROM_NAME, default
// SiraGPT — some templates still said «OpenWebUI»). Quotes are dropped so the
// name cannot break out of the quoted display-name.
function fromHeader() {
  const name = sanitizeHeader(process.env.SMTP_FROM_NAME || 'SiraGPT', 80).replace(/["\\]/g, '') || 'SiraGPT';
  return `"${name}" <${process.env.SMTP_USER}>`;
}

// Lazy PII-mask require — keeps module load light, defers the cost
// until we actually log a body preview.
let _piiMask = null;
function _maskBody(text) {
  try {
    if (!_piiMask) _piiMask = require('../utils/pii-mask');
    if (typeof text !== 'string') return text;
    return _piiMask.mask(text);
  } catch (_) {
    return text;
  }
}

class EmailService {
  constructor() {
    this.transporter = null;
    this._configured = false;
    this.initialize();
  }

  /**
   * Internal helper for log lines that include a sent-message body
   * preview. Always runs the text through the PII masker before
   * emitting. Off by default — gated behind EMAIL_DEBUG_LOG_BODY.
   */
  _logSentBody(label, body) {
    if (process.env.EMAIL_DEBUG_LOG_BODY !== '1') return;
    const masked = _maskBody(String(body || '')).slice(0, 2000);
    console.log(`[email-body] ${label}: ${masked}`);
  }

  /**
   * Internal sendMail wrapper — defends against header smuggling by
   * sanitizing user-derived header positions (subject + display
   * names in `from`). Nodemailer 8 will already reject CR/LF in
   * many places, but this gives a friendlier no-op fallback rather
   * than throwing from a fire-and-forget alert path.
   */
  async _send(message = {}) {
    if (!this.transporter) return null;
    const safe = { ...message };
    if (typeof safe.subject === 'string') safe.subject = sanitizeHeader(safe.subject, 300);
    if (typeof safe.from === 'string') safe.from = sanitizeHeader(safe.from, 320);
    return this.transporter.sendMail(safe);
  }

  initialize() {
    try {
      if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        this.transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: false,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });

        this._configured = true;
        console.log('✅ Email service configured');
      } else {
        // Single, loud WARN at boot so the operator sees it once.
        // All send* methods below are no-ops while unconfigured, so
        // fire-and-forget call sites never throw.
        console.warn(
          '⚠️  Email service not configured (missing SMTP_HOST / SMTP_USER / SMTP_PASS). '
          + 'Email-bound flows (verification, password reset, payment failure alerts) will no-op. '
          + 'Set SMTP_* env vars to enable.'
        );
      }
    } catch (error) {
      console.error('❌ Email service initialization failed:', error);
    }
  }

  /**
   * Returns true when SMTP is configured and the transporter is live.
   * Callers in auth flows (verification / password reset) should check
   * this and return a friendly 503 rather than silently dropping the
   * email. Other flows (notifications, fire-and-forget) can just call
   * send* methods directly — they no-op when unconfigured.
   */
  isConfigured() {
    return this._configured === true;
  }

  /**
   * Send usage alert email
   */
  async sendUsageAlert(user, alertData) {
    if (!this.isConfigured()) return;

    try {
      const { type, threshold, usage } = alertData;
      const percentage = threshold;
      
      const subject = sanitizeHeader(`${percentage}% Usage Alert - ${user.name}`);
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #2E7D32 0%, #1B5E20 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Usage Alert</h1>
          </div>
          
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${user.name},</h2>
            
            <p>You've reached <strong>${percentage}%</strong> of your ${type === 'api_usage' ? 'monthly API limit' : 'monthly call limit'}.</p>
            
            <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3>Current Usage:</h3>
              <p><strong>${usage.current.toLocaleString()}</strong> / ${usage.limit.toLocaleString()} ${type === 'api_usage' ? 'API calls' : 'calls'}</p>
              <div style="background: #e0e0e0; height: 10px; border-radius: 5px; overflow: hidden;">
                <div style="background: ${percentage >= 100 ? '#e74c3c' : percentage >= 90 ? '#f39c12' : '#2E7D32'}; height: 100%; width: ${Math.min(percentage, 100)}%;"></div>
              </div>
            </div>

            ${percentage >= 90 ? `
              <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <h3 style="color: #856404;">⚠️ Consider Upgrading</h3>
                <p style="color: #856404;">To avoid service interruption, consider upgrading your plan for higher limits.</p>
              </div>
            ` : ''}

            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/billing" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Manage Subscription
              </a>
            </div>
          </div>
          
          <div style="background: #34495e; color: white; padding: 15px; text-align: center; font-size: 12px;">
            <p>This is an automated message from SiraGPT. If you no longer wish to receive these notifications,
            <a href="${process.env.FRONTEND_URL}/profile" style="color: #2E7D32;">manage your preferences</a>.</p>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent
      });

      console.log(`Usage alert email sent to ${user.email}`);

    } catch (error) {
      console.error('Error sending usage alert email:', error);
    }
  }

  /**
   * Send payment failure notification
   */
  async sendPaymentFailureAlert(user, paymentData) {
    if (!this.isConfigured()) {
      return { ok: false, error: "email_not_configured" };
    }

    try {
      const subject = `Payment Failed - Action Required`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #e74c3c; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">⚠️ Payment Failed</h1>
          </div>
          
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${user.name},</h2>
            
            <p>We were unable to process your payment for the <strong>${user.plan}</strong> plan.</p>
            
            <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3>Payment Details:</h3>
              <p><strong>Amount:</strong> $${paymentData.amount || 'N/A'}</p>
              <p><strong>Plan:</strong> ${user.plan}</p>
              <p><strong>Next Retry:</strong> ${paymentData.nextRetry || 'Within 24 hours'}</p>
            </div>

            <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: #856404;">What happens next?</h3>
              <ul style="color: #856404;">
                <li>We'll automatically retry your payment</li>
                <li>You'll still have access during the grace period</li>
                <li>Please update your payment method if needed</li>
              </ul>
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/billing" style="background: #e74c3c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Update Payment Method
              </a>
            </div>
          </div>
        </div>
      `;

      const delivery = await this.transporter.sendMail({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent
      });

      console.log(`Payment failure email sent to ${user.email}`);
      return {
        ok: true,
        messageId: delivery?.messageId || null,
      };

    } catch (error) {
      console.error("Error sending payment failure email:", error);
      return {
        ok: false,
        error: error?.message || String(error),
      };
    }
  }

  /**
   * Send subscription ending notification
   */
  async sendSubscriptionEndingAlert(user, endDate) {
    if (!this.isConfigured()) return;

    try {
      const subject = `Your subscription ends in 3 days`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #f39c12; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">⏰ Subscription Ending Soon</h1>
          </div>
          
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${user.name},</h2>
            
            <p>Your <strong>${user.plan}</strong> subscription will end on <strong>${new Date(endDate).toLocaleDateString()}</strong>.</p>
            
            <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3>After your subscription ends:</h3>
              <ul>
                <li>Your account will switch to the FREE plan</li>
                <li>API limits will be reduced to 10,000 calls/month</li>
                <li>Some premium features will be disabled</li>
              </ul>
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/billing" style="background: #27ae60; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin-right: 10px;">
                Reactivate Subscription
              </a>
              <a href="${process.env.FRONTEND_URL}/chat" style="background: #95a5a6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Continue with FREE
              </a>
            </div>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent
      });

      console.log(`Subscription ending email sent to ${user.email}`);

    } catch (error) {
      console.error('Error sending subscription ending email:', error);
    }
  }

  /**
   * Send welcome email after successful subscription
   */
  async sendWelcomeEmail(user) {
    if (!this.isConfigured()) return;

    try {
      const subject = `Welcome to ${user.plan} plan! 🎉`;
      
      const planFeatures = {
        BASIC: ['10,000 API calls/month', 'Basic AI models', 'Email Support'],
        STANDARD: ['30,000 API calls/month', 'Advanced AI models', 'Image Generation', 'Priority Support'],
        ENTERPRISE: ['100,000 API calls/month', 'All AI models', 'Audio & Video Generation', 'Dedicated Support']
      };
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #2E7D32 0%, #1B5E20 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">🎉 Welcome to ${user.plan}!</h1>
          </div>
          
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${user.name},</h2>
            
            <p>Thank you for subscribing to our <strong>${user.plan}</strong> plan! Your account has been upgraded successfully.</p>
            
            <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3>What's included in your plan:</h3>
              <ul>
                ${planFeatures[user.plan]?.map(feature => `<li>${feature}</li>`).join('') || '<li>Premium features</li>'}
              </ul>
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/chat" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Start Using Your Plan
              </a>
            </div>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent
      });

      console.log(`Welcome email sent to ${user.email}`);

    } catch (error) {
      console.error('Error sending welcome email:', error);
    }
  }

  /**
   * Send subscription confirmation email
   */
  async sendSubscriptionConfirmation(email, data) {
    if (!this.isConfigured()) return;

    try {
      const { userName, plan, expirationDate, billingCycle } = data;
      
      const subject = `Welcome to ${plan} Plan - Subscription Confirmed`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Subscription Confirmed!</h1>
          </div>
          
          <div style="padding: 30px; background: #f9fafb; border-left: 4px solid #10b981;">
            <h2 style="color: #374151; margin-top: 0;">Welcome to ${plan} Plan, ${userName}!</h2>
            
            <p style="color: #6b7280; line-height: 1.6;">
              Your subscription has been successfully activated and you now have access to all ${plan} plan features.
            </p>

            <div style="background: white; border-radius: 8px; padding: 20px; margin: 20px 0; border: 1px solid #e5e7eb;">
              <h3 style="margin-top: 0; color: #374151;">Subscription Details:</h3>
              <p><strong>Plan:</strong> ${plan}</p>
              <p><strong>Billing Cycle:</strong> ${billingCycle}</p>
              <p><strong>Next Renewal:</strong> ${new Date(expirationDate).toLocaleDateString()}</p>
            </div>

            <p style="color: #6b7280; line-height: 1.6;">
              You can manage your subscription, view usage, and update payment methods in your account dashboard.
            </p>

            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.FRONTEND_URL}/profile" 
                 style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Manage Subscription
              </a>
            </div>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: fromHeader(),
        to: email,
        subject,
        html: htmlContent
      });

      console.log(`Subscription confirmation sent to ${email}`);

    } catch (error) {
      console.error('Error sending subscription confirmation:', error);
    }
  }

  /**
   * Send renewal confirmation email
   */
  async sendRenewalConfirmation(email, data) {
    if (!this.isConfigured()) return;

    try {
      const { userName, plan, newExpirationDate, billingCycle } = data;
      
      const subject = `${plan} Plan Renewed Successfully`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Subscription Renewed</h1>
          </div>
          
          <div style="padding: 30px; background: #f9fafb; border-left: 4px solid #3b82f6;">
            <h2 style="color: #374151; margin-top: 0;">Hello ${userName}!</h2>
            
            <p style="color: #6b7280; line-height: 1.6;">
              Your ${plan} plan subscription has been automatically renewed for another ${billingCycle}.
            </p>

            <div style="background: white; border-radius: 8px; padding: 20px; margin: 20px 0; border: 1px solid #e5e7eb;">
              <h3 style="margin-top: 0; color: #374151;">Renewal Details:</h3>
              <p><strong>Plan:</strong> ${plan}</p>
              <p><strong>Billing Cycle:</strong> ${billingCycle}</p>
              <p><strong>Next Renewal:</strong> ${new Date(newExpirationDate).toLocaleDateString()}</p>
            </div>

            <p style="color: #6b7280; line-height: 1.6;">
              Thank you for continuing to use our services. Your payment method has been charged for the renewal.
            </p>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: fromHeader(),
        to: email,
        subject,
        html: htmlContent
      });

      console.log(`Renewal confirmation sent to ${email}`);

    } catch (error) {
      console.error('Error sending renewal confirmation:', error);
    }
  }

  /**
   * Send payment failure notification
   */
  async sendPaymentFailureNotification(email, data) {
    if (!this.isConfigured()) return;

    try {
      const { userName, plan, failureReason, retryDate } = data;
      
      const subject = `Payment Failed - Action Required for ${plan} Plan`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Payment Failed</h1>
          </div>
          
          <div style="padding: 30px; background: #fef2f2; border-left: 4px solid #ef4444;">
            <h2 style="color: #374151; margin-top: 0;">Action Required, ${userName}</h2>
            
            <p style="color: #6b7280; line-height: 1.6;">
              We were unable to process the payment for your ${plan} subscription renewal.
            </p>

            <div style="background: white; border-radius: 8px; padding: 20px; margin: 20px 0; border: 1px solid #fee2e2;">
              <h3 style="margin-top: 0; color: #374151;">Payment Details:</h3>
              <p><strong>Plan:</strong> ${plan}</p>
              <p><strong>Failure Reason:</strong> ${failureReason}</p>
              <p><strong>Next Retry:</strong> ${new Date(retryDate).toLocaleDateString()}</p>
            </div>

            <p style="color: #6b7280; line-height: 1.6;">
              Please update your payment method to avoid service interruption. You have 24 hours before your subscription is downgraded to the free plan.
            </p>

            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.FRONTEND_URL}/profile" 
                 style="background: #ef4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Update Payment Method
              </a>
            </div>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: fromHeader(),
        to: email,
        subject,
        html: htmlContent
      });

      console.log(`Payment failure notification sent to ${email}`);

    } catch (error) {
      console.error('Error sending payment failure notification:', error);
    }
  }

  /**
   * Send email-verification magic link. Token is short-lived (24h) and
   * is minted by the caller (see services/email-verification.js) so this
   * method only renders + sends the message. No-op when unconfigured.
   */
  async sendEmailVerification(user, token) {
    if (!this.isConfigured()) return;
    try {
      const safeName = sanitizeHeader(user.name || 'there', 100);
      const subject = sanitizeHeader('Verify your email', 200);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const verifyUrl = `${base}/auth/verify-email/${encodeURIComponent(token)}`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #2E7D32 0%, #1B5E20 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Verify your email</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${safeName},</h2>
            <p>Click the button below to verify your email address. This link expires in 24 hours.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${verifyUrl}" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Verify Email
              </a>
            </div>
            <p style="color: #666; font-size: 12px;">If you didn't request this, you can safely ignore the message.</p>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('verify-email', htmlContent);
      console.log(`Verification email sent to ${user.email}`);
    } catch (error) {
      console.error('Error sending verification email:', error);
    }
  }

  /**
   * Send a password reset email with the magic-link token. Fire-and-forget;
   * returns true if handed off to the transporter, false otherwise.
   * The link expires per PASSWORD_RESET_TTL_MS (30m default).
   */
  async sendPasswordReset(user, token) {
    if (!this.isConfigured()) return false;
    try {
      const safeName = sanitizeHeader(user?.name || 'there', 100);
      const subject = sanitizeHeader('Restablece tu contraseña en SiraGPT', 200);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const resetUrl = `${base}/auth/reset/${encodeURIComponent(token)}`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #2E7D32 0%, #1B5E20 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Restablece tu contraseña</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hola ${safeName},</h2>
            <p>Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en SiraGPT. Haz clic en el botón a continuación para crear una nueva contraseña. Este enlace expira en 30 minutos.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Restablecer contraseña
              </a>
            </div>
            <p style="color: #666; font-size: 12px;">Si no fuiste tú quien solicitó este cambio, puedes ignorar este mensaje con seguridad. Tu contraseña actual no será modificada.</p>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('password-reset', htmlContent);
      console.log(`Password reset email sent to ${user.email}`);
      return true;
    } catch (error) {
      console.error('Error sending password reset email:', error);
      return false;
    }
  }

  /**
   * Send an organization invitation email with the accept magic link.
   * Fire-and-forget; returns true when handed off to the transporter,
   * false otherwise. The route still returns the magic link so admins
   * can share it manually when SMTP is unavailable.
   */
  async sendOrgInvitation(invitee, org, opts = {}) {
    if (!this.isConfigured()) return false;
    try {
      const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      const base = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || '').replace(/\/$/, '');
      const normalizeLink = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return base || '';
        if (raw.startsWith('/') && base) return `${base}${raw}`;
        return raw;
      };

      const safeOrgHeader = sanitizeHeader(org?.name || 'Sira', 200);
      const safeOrg = escapeHtml(safeOrgHeader);
      const safeRole = escapeHtml(sanitizeHeader(String(opts.role || 'MEMBER'), 32));
      const inviter = opts.invitedBy || {};
      const safeInviterHeader = sanitizeHeader(inviter.name || inviter.email || 'Un administrador', 200);
      const safeInviter = escapeHtml(safeInviterHeader);
      const safeProject = escapeHtml(sanitizeHeader(opts.projectName || '', 120));
      const inviteUrl = normalizeLink(opts.magicLink);
      const workspaceUrl = normalizeLink(opts.workspaceUrl);
      const safeInviteUrl = escapeHtml(inviteUrl);
      const safeWorkspaceUrl = workspaceUrl && workspaceUrl !== inviteUrl ? escapeHtml(workspaceUrl) : '';
      const subject = sanitizeHeader(`${safeInviterHeader} te invitó a ${safeOrgHeader}`, 240);
      const expiresAt = opts.expiresAt ? new Date(opts.expiresAt) : null;
      const expiry = expiresAt && !Number.isNaN(expiresAt.getTime())
        ? escapeHtml(expiresAt.toLocaleDateString('es', { year: 'numeric', month: 'short', day: 'numeric' }))
        : '';

      const projectBlock = safeProject
        ? `<p>Vas a colaborar en <strong>${safeProject}</strong>.</p>`
        : '';
      const workspaceBlock = safeWorkspaceUrl
        ? `
            <p style="color: #4b5563; line-height: 1.6;">Después de aceptar, puedes abrir el workspace aquí:</p>
            <p style="word-break: break-all; color: #4b5563; font-size: 13px;">${safeWorkspaceUrl}</p>
          `
        : '';

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #2E7D32; padding: 22px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">Invitación a Sira</h1>
          </div>
          <div style="padding: 24px; background: #f9fafb;">
            <h2 style="color: #111827; margin-top: 0;">${safeInviter} te invitó a ${safeOrg}</h2>
            <p style="color: #4b5563; line-height: 1.6;">Te agregaron como <strong>${safeRole}</strong> para trabajar en Sira.</p>
            ${projectBlock}
            <div style="text-align: center; margin: 30px 0;">
              <a href="${safeInviteUrl}" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">
                Aceptar invitación
              </a>
            </div>
            <p style="word-break: break-all; color: #6b7280; font-size: 13px;">${safeInviteUrl}</p>
            ${workspaceBlock}
            ${expiry ? `<p style="color: #6b7280; font-size: 12px;">Esta invitación expira el ${expiry}.</p>` : ''}
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: invitee.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('org-invitation', htmlContent);
      console.log(`Org invitation email sent to ${invitee.email}`);
      return true;
    } catch (error) {
      console.error('Error sending org invitation email:', error);
      return false;
    }
  }

  /**
   * Send org welcome email after a user accepts an invitation and a
   * membership row is created. Fire-and-forget — no-ops when SMTP is
   * not configured. Returns `true` when a message was handed off to
   * the transporter, `false` otherwise (useful for audit-log signal).
   */
  async sendOrgWelcome(user, org) {
    if (!this.isConfigured()) return false;
    try {
      const safeName = sanitizeHeader(user?.name || 'there', 100);
      const safeOrg = sanitizeHeader(org?.name || 'your organization', 200);
      const subject = sanitizeHeader(`Welcome to ${safeOrg}`, 200);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const orgUrl = org?.slug ? `${base}/org/${encodeURIComponent(org.slug)}` : `${base}/`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #2E7D32 0%, #1B5E20 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Welcome to ${safeOrg}</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${safeName},</h2>
            <p>You've been added to <strong>${safeOrg}</strong>. You can now access shared chats, files and team resources.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${orgUrl}" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Open ${safeOrg}
              </a>
            </div>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('org-welcome', htmlContent);
      console.log(`Org welcome email sent to ${user.email}`);
      return true;
    } catch (error) {
      console.error('Error sending org welcome email:', error);
      return false;
    }
  }

  /**
   * Notify a member that their role within an org changed. Fire-and-
   * forget; returns true when handed off to the transporter, false
   * otherwise so callers can record the outcome in audit logs.
   */
  async sendRoleChangeNotification(user, org, oldRole, newRole) {
    if (!this.isConfigured()) return false;
    try {
      const safeName = sanitizeHeader(user?.name || 'there', 100);
      const safeOrg = sanitizeHeader(org?.name || 'your organization', 200);
      const safeOld = sanitizeHeader(String(oldRole || ''), 32);
      const safeNew = sanitizeHeader(String(newRole || ''), 32);
      const subject = sanitizeHeader(`Your role in ${safeOrg} changed to ${safeNew}`, 200);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const orgUrl = org?.slug ? `${base}/org/${encodeURIComponent(org.slug)}` : `${base}/`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Role updated</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${safeName},</h2>
            <p>Your role in <strong>${safeOrg}</strong> changed from <strong>${safeOld}</strong> to <strong>${safeNew}</strong>.</p>
            <p>If you did not expect this change, contact an organization administrator.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${orgUrl}" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Open ${safeOrg}
              </a>
            </div>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('org-role-change', htmlContent);
      console.log(`Role change email sent to ${user.email}`);
      return true;
    } catch (error) {
      console.error('Error sending role change email:', error);
      return false;
    }
  }

  /**
   * Notify a user that they were removed from an organization by an
   * admin/owner. Fire-and-forget; returns true when handed off to the
   * transporter, false otherwise so callers can record the outcome in
   * audit logs.
   */
  async sendOrgRemoval(user, org, removedBy) {
    if (!this.isConfigured()) return false;
    try {
      const safeName = sanitizeHeader(user?.name || 'there', 100);
      const safeOrg = sanitizeHeader(org?.name || 'your organization', 200);
      const safeActor = sanitizeHeader(removedBy?.name || removedBy?.email || 'an administrator', 200);
      const subject = sanitizeHeader(`You were removed from ${safeOrg}`, 200);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const homeUrl = `${base}/`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Membership removed</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${safeName},</h2>
            <p>Your membership in <strong>${safeOrg}</strong> was removed by <strong>${safeActor}</strong>.</p>
            <p>You no longer have access to chats, files or resources that were shared inside that organization.</p>
            <p>If you believe this was a mistake, contact an organization administrator.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${homeUrl}" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Open SiraGPT
              </a>
            </div>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('org-removal', htmlContent);
      console.log(`Org removal email sent to ${user.email}`);
      return true;
    } catch (error) {
      console.error('Error sending org removal email:', error);
      return false;
    }
  }

  /**
   * Notify a user about an org ownership transfer. The same template
   * is used for both the demoted previous owner and the promoted new
   * owner — disambiguated by `opts.role` ('previousOwner' | 'newOwner').
   * Fire-and-forget; returns true on transporter hand-off, false
   * otherwise.
   */
  async sendOwnershipTransfer(user, org, opts = {}) {
    if (!this.isConfigured()) return false;
    try {
      const role = opts.role === 'previousOwner' ? 'previousOwner' : 'newOwner';
      const safeName = sanitizeHeader(user?.name || 'there', 100);
      const safeOrg = sanitizeHeader(org?.name || 'your organization', 200);
      const safePrev = sanitizeHeader(opts.previousOwner?.name || opts.previousOwner?.email || 'the previous owner', 200);
      const safeNew = sanitizeHeader(opts.newOwner?.name || opts.newOwner?.email || 'the new owner', 200);
      const subject = role === 'newOwner'
        ? sanitizeHeader(`You are now the owner of ${safeOrg}`, 200)
        : sanitizeHeader(`Ownership of ${safeOrg} was transferred`, 200);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const orgUrl = org?.slug ? `${base}/org/${encodeURIComponent(org.slug)}` : `${base}/`;

      const headline = role === 'newOwner'
        ? `You are now the owner of ${safeOrg}`
        : 'Ownership transferred';
      const bodyHtml = role === 'newOwner'
        ? `<p><strong>${safePrev}</strong> transferred ownership of <strong>${safeOrg}</strong> to you. You now have full control over members, billing and settings.</p>`
        : `<p>You transferred ownership of <strong>${safeOrg}</strong> to <strong>${safeNew}</strong>. Your role has been changed to <strong>ADMIN</strong> so you retain management rights.</p>`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">${headline}</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${safeName},</h2>
            ${bodyHtml}
            <p>If you did not expect this change, contact the organization immediately.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${orgUrl}" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Open ${safeOrg}
              </a>
            </div>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody(`org-ownership-${role}`, htmlContent);
      console.log(`Ownership transfer email (${role}) sent to ${user.email}`);
      return true;
    } catch (error) {
      console.error('Error sending ownership transfer email:', error);
      return false;
    }
  }

  /**
   * Broadcast a critical org announcement to a single member. Fire-and-
   * forget; returns true when handed off to the transporter, false
   * otherwise. The route layer is responsible for fanning out across
   * the member list and respecting per-user opt-outs — this method
   * only renders + sends a single message so the email-preferences
   * gating stays in one place (ratchet 45, Task 2).
   */
  async sendOrgAnnouncement(user, org, announcement) {
    if (!this.isConfigured()) return false;
    try {
      const safeName = sanitizeHeader(user?.name || 'there', 100);
      const safeOrg = sanitizeHeader(org?.name || 'your organization', 200);
      const safeTitle = sanitizeHeader(announcement?.title || 'Announcement', 200);
      const bodyText = typeof announcement?.body === 'string' ? announcement.body : '';
      // Escape so HTML special chars in the user-supplied body don't
      // smuggle markup. Keep newlines as <br/> for readability.
      const safeBody = bodyText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '<br/>');
      const subject = sanitizeHeader(`[${safeOrg}] ${safeTitle}`, 300);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const orgUrl = org?.slug ? `${base}/org/${encodeURIComponent(org.slug)}` : `${base}/`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Critical announcement</h1>
          </div>
          <div style="padding: 20px; background: #fef2f2; border-left: 4px solid #dc2626;">
            <h2 style="color: #374151;">Hi ${safeName},</h2>
            <p><strong>${safeOrg}</strong> posted a critical announcement:</p>
            <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0; border: 1px solid #fecaca;">
              <h3 style="margin-top: 0; color: #991b1b;">${safeTitle}</h3>
              <p style="color: #374151; line-height: 1.6;">${safeBody}</p>
            </div>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${orgUrl}" style="background: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Open ${safeOrg}
              </a>
            </div>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('org-announcement', htmlContent);
      console.log(`Org announcement email sent to ${user.email}`);
      return true;
    } catch (error) {
      console.error('Error sending org announcement email:', error);
      return false;
    }
  }

  /**
   * Send subscription downgrade notification
   */
  async sendSubscriptionDowngrade(email, data) {
    if (!this.isConfigured()) return;

    try {
      const { userName, previousPlan, reason } = data;
      
      const subject = `Subscription Downgraded to Free Plan`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Subscription Updated</h1>
          </div>
          
          <div style="padding: 30px; background: #f9fafb; border-left: 4px solid #6b7280;">
            <h2 style="color: #374151; margin-top: 0;">Hello ${userName}</h2>
            
            <p style="color: #6b7280; line-height: 1.6;">
              Your ${previousPlan} subscription has been downgraded to the Free plan due to: ${reason}
            </p>

            <div style="background: white; border-radius: 8px; padding: 20px; margin: 20px 0; border: 1px solid #e5e7eb;">
              <h3 style="margin-top: 0; color: #374151;">Current Plan Features:</h3>
              <ul style="color: #6b7280;">
                <li>3 API calls per month</li>
                <li>Basic AI chat functionality</li>
                <li>Community support</li>
              </ul>
            </div>

            <p style="color: #6b7280; line-height: 1.6;">
              You can reactivate your subscription anytime to regain access to premium features.
            </p>

            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.FRONTEND_URL}/profile" 
                 style="background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Reactivate Subscription
              </a>
            </div>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: fromHeader(),
        to: email,
        subject,
        html: htmlContent
      });

      console.log(`Subscription downgrade notification sent to ${email}`);

    } catch (error) {
      console.error('Error sending subscription downgrade notification:', error);
    }
  }

  /**
   * Security notification: a new Appshots device (Chrome-extension token)
   * was paired to the user's account. Fire-and-forget — failures are
   * logged but never block the originating /api/appshots/pair request.
   *
   * Re-uses the visual style of the other security-flavoured templates
   * (sendOrgRemoval, sendRoleChangeNotification): same 600px wrapper, same
   * gradient header, same CTA button. The red gradient is intentional —
   * this is the "alert early if someone stole your account" branch.
   */
  async sendAppshotsDeviceLinked(user, info = {}) {
    if (!this.isConfigured()) return false;
    try {
      const safeName = sanitizeHeader(user?.name || 'there', 100);
      const safeIp = sanitizeHeader(info.ip || 'unknown', 64);
      const when = info.when instanceof Date ? info.when : new Date();
      const safeWhen = sanitizeHeader(when.toUTCString(), 64);
      const subject = sanitizeHeader('Has vinculado un nuevo dispositivo a Appshots', 200);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const settingsUrl = `${base}/settings/appshots`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Nuevo dispositivo Appshots</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hola ${safeName},</h2>
            <p>Acabas de vincular un nuevo dispositivo a <strong>Appshots</strong>, la extensión de Chrome que sube capturas a Sira.</p>
            <ul>
              <li><strong>Fecha:</strong> ${safeWhen}</li>
              <li><strong>IP aproximada:</strong> ${safeIp}</li>
            </ul>
            <p>Si has sido tú, no tienes que hacer nada. Si no reconoces esta acción, revoca el dispositivo cuanto antes y cambia tu contraseña.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${settingsUrl}" style="background: #ef4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Revisar mis dispositivos
              </a>
            </div>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('appshots-device-linked', htmlContent);
      console.log(`Appshots device-linked email sent to ${user.email}`);
      return true;
    } catch (error) {
      console.error('Error sending appshots device-linked email:', error);
      return false;
    }
  }

  /**
   * Security notification: an Appshots device was revoked from the
   * user's account. Sent as a confirmation of the action — less
   * urgent than the pairing alert, hence the neutral gray gradient.
   */
  async sendAppshotsDeviceRevoked(user, info = {}) {
    if (!this.isConfigured()) return false;
    try {
      const safeName = sanitizeHeader(user?.name || 'there', 100);
      const when = info.when instanceof Date ? info.when : new Date();
      const safeWhen = sanitizeHeader(when.toUTCString(), 64);
      const subject = sanitizeHeader('Has revocado un dispositivo de Appshots', 200);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const settingsUrl = `${base}/settings/appshots`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Dispositivo Appshots revocado</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hola ${safeName},</h2>
            <p>Has revocado un dispositivo de <strong>Appshots</strong>. Ese dispositivo ya no podrá enviar capturas a Sira.</p>
            <ul>
              <li><strong>Fecha:</strong> ${safeWhen}</li>
            </ul>
            <p>Si no has sido tú, alguien con acceso a tu cuenta acaba de hacerlo. Cambia tu contraseña y revisa el resto de tus dispositivos.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${settingsUrl}" style="background: #2E7D32; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Revisar mis dispositivos
              </a>
            </div>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('appshots-device-revoked', htmlContent);
      console.log(`Appshots device-revoked email sent to ${user.email}`);
      return true;
    } catch (error) {
      console.error('Error sending appshots device-revoked email:', error);
      return false;
    }
  }

  /**
   * Security notification: an Appshots device session was revoked
   * AUTOMATICALLY by the backend (fingerprint mismatch detected in
   * the auth middleware, token expired, or administrative cleanup).
   * The user did NOT request this — so unlike sendAppshotsDeviceRevoked
   * we use the red "alert" gradient, surface the machine-detected
   * reason, and explicitly recommend a password change.
   *
   * `info.reason` is a stable machine code ('fingerprint_mismatch',
   * 'token_expired', 'admin_revoked', …) — we map it to a user-facing
   * Spanish sentence here so callers don't have to think about copy.
   */
  async sendAppshotsDeviceAutoRevoked(user, info = {}) {
    if (!this.isConfigured()) return false;
    try {
      const safeName = sanitizeHeader(user?.name || 'there', 100);
      const when = info.when instanceof Date ? info.when : new Date();
      const safeWhen = sanitizeHeader(when.toUTCString(), 64);
      const reasonCode = String(info.reason || 'security').toLowerCase();
      const reasonCopyMap = {
        fingerprint_mismatch:
          'Detectamos que el token se estaba usando desde una red o navegador distintos al que lo vinculó, así que lo hemos revocado por seguridad.',
        token_expired:
          'El token del dispositivo había caducado, así que lo hemos retirado automáticamente.',
        admin_revoked:
          'Un administrador ha revocado este dispositivo desde el panel de control.',
        inactivity:
          'Hemos retirado el dispositivo por inactividad prolongada.',
      };
      const reasonText = reasonCopyMap[reasonCode]
        || 'Hemos revocado este dispositivo automáticamente por un motivo de seguridad.';
      const safeReason = sanitizeHeader(reasonText, 400);
      const subject = sanitizeHeader('Hemos revocado un dispositivo de Appshots por seguridad', 200);
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const settingsUrl = `${base}/settings/appshots`;

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Dispositivo Appshots revocado por seguridad</h1>
          </div>
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hola ${safeName},</h2>
            <p>Hemos retirado automáticamente un dispositivo de <strong>Appshots</strong> de tu cuenta. <strong>Esta revocación NO la has solicitado tú.</strong></p>
            <ul>
              <li><strong>Fecha:</strong> ${safeWhen}</li>
              <li><strong>Motivo:</strong> ${safeReason}</li>
            </ul>
            <p>Si reconoces la actividad (por ejemplo, has cambiado de red o de equipo), puedes vincular el dispositivo de nuevo desde la configuración.</p>
            <p><strong>Si no reconoces esta actividad, alguien podría haber accedido a tu cuenta. Te recomendamos cambiar tu contraseña inmediatamente y revisar el resto de dispositivos vinculados.</strong></p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${settingsUrl}" style="background: #ef4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Revisar mis dispositivos
              </a>
            </div>
          </div>
        </div>
      `;

      await this._send({
        from: fromHeader(),
        to: user.email,
        subject,
        html: htmlContent,
      });
      this._logSentBody('appshots-device-auto-revoked', htmlContent);
      console.log(`Appshots device-auto-revoked email sent to ${user.email} (reason=${reasonCode})`);
      return true;
    } catch (error) {
      console.error('Error sending appshots device-auto-revoked email:', error);
      return false;
    }
  }
}

const _instance = new EmailService();
_instance._sanitizeHeader = sanitizeHeader;
module.exports = _instance;
module.exports.sanitizeHeader = sanitizeHeader;
