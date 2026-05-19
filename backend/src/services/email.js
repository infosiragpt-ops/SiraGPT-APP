const nodemailer = require('nodemailer');

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
      
      const subject = `${percentage}% Usage Alert - ${user.name}`;
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Usage Alert</h1>
          </div>
          
          <div style="padding: 20px; background: #f9f9f9;">
            <h2>Hi ${user.name},</h2>
            
            <p>You've reached <strong>${percentage}%</strong> of your ${type === 'api_usage' ? 'monthly API limit' : 'monthly call limit'}.</p>
            
            <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3>Current Usage:</h3>
              <p><strong>${usage.current.toLocaleString()}</strong> / ${usage.limit.toLocaleString()} ${type === 'api_usage' ? 'API calls' : 'calls'}</p>
              <div style="background: #e0e0e0; height: 10px; border-radius: 5px; overflow: hidden;">
                <div style="background: ${percentage >= 100 ? '#e74c3c' : percentage >= 90 ? '#f39c12' : '#3498db'}; height: 100%; width: ${Math.min(percentage, 100)}%;"></div>
              </div>
            </div>

            ${percentage >= 90 ? `
              <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <h3 style="color: #856404;">⚠️ Consider Upgrading</h3>
                <p style="color: #856404;">To avoid service interruption, consider upgrading your plan for higher limits.</p>
              </div>
            ` : ''}

            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/billing" style="background: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Manage Subscription
              </a>
            </div>
          </div>
          
          <div style="background: #34495e; color: white; padding: 15px; text-align: center; font-size: 12px;">
            <p>This is an automated message from OpenWebUI. If you no longer wish to receive these notifications, 
            <a href="${process.env.FRONTEND_URL}/profile" style="color: #3498db;">manage your preferences</a>.</p>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: `"OpenWebUI" <${process.env.SMTP_USER}>`,
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
    if (!this.isConfigured()) return;

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

      await this.transporter.sendMail({
        from: `"OpenWebUI" <${process.env.SMTP_USER}>`,
        to: user.email,
        subject,
        html: htmlContent
      });

      console.log(`Payment failure email sent to ${user.email}`);

    } catch (error) {
      console.error('Error sending payment failure email:', error);
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
        from: `"OpenWebUI" <${process.env.SMTP_USER}>`,
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
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
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
              <a href="${process.env.FRONTEND_URL}/chat" style="background: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Start Using Your Plan
              </a>
            </div>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: `"OpenWebUI" <${process.env.SMTP_USER}>`,
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
        from: `"OpenWebUI" <${process.env.SMTP_USER}>`,
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
        from: `"OpenWebUI" <${process.env.SMTP_USER}>`,
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
        from: `"OpenWebUI" <${process.env.SMTP_USER}>`,
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
        from: `"OpenWebUI" <${process.env.SMTP_USER}>`,
        to: email,
        subject,
        html: htmlContent
      });

      console.log(`Subscription downgrade notification sent to ${email}`);

    } catch (error) {
      console.error('Error sending subscription downgrade notification:', error);
    }
  }
}

module.exports = new EmailService();