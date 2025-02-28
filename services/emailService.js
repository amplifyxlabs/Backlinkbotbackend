const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Email Service for sending transactional emails using Resend
 */
class EmailService {
  constructor() {
    this.from = 'BacklinkBot <notifications@backlinkbotai.com>';
  }

  /**
   * Get user email from Supabase user_id
   * @param {Object} supabase - Supabase client
   * @param {string} userId - User ID from auth.users table
   * @returns {Promise<string>} - User's email
   */
  async getUserEmailById(supabase, userId) {
    if (!userId) throw new Error('User ID is required');
    
    // Try to get from auth.users first
    const { data: userData, error: userError } = await supabase
      .from('auth.users')
      .select('email')
      .eq('id', userId)
      .single();
    
    if (userData && userData.email) {
      return userData.email;
    }
    
    // If not found, try product_submissions table
    const { data: subData, error: subError } = await supabase
      .from('product_submissions')
      .select('email_user')
      .eq('user_id', userId)
      .single();
    
    if (subData && subData.email_user) {
      return subData.email_user;
    }
    
    throw new Error('User email not found');
  }

  /**
   * Send a welcome email to a new user
   */
  async sendWelcomeEmail(email, name = '') {
    return await resend.emails.send({
      from: this.from,
      to: email,
      subject: 'Welcome to BacklinkBot!',
      html: `
        <h1>Welcome to BacklinkBot!</h1>
        <p>Hi ${name || 'there'},</p>
        <p>Thank you for signing up! We're excited to have you on board.</p>
        <p>Get started by creating your first submission.</p>
        <a href="https://backlinkbotai.com/dashboard" style="display: inline-block; background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Go to Dashboard</a>
      `,
    });
  }

  /**
   * Send a payment request email for a new submission
   */
  async sendPaymentRequestEmail(email, submissionData) {
    return await resend.emails.send({
      from: this.from,
      to: email,
      subject: 'Complete Your Payment for BacklinkBot Submission',
      html: `
        <h1>Complete Your Payment</h1>
        <p>Your submission for "${submissionData.product_name}" requires payment to proceed.</p>
        <p>Plan: ${submissionData.submission_plan || 'Standard'}</p>
        <p>Price: $${submissionData.price}</p>
        <a href="https://backlinkbotai.com/payment/${submissionData.id}" style="display: inline-block; background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Complete Payment</a>
      `,
    });
  }

  /**
   * Send a payment confirmation email
   */
  async sendPaymentConfirmationEmail(email, paymentData) {
    return await resend.emails.send({
      from: this.from,
      to: email,
      subject: 'Payment Confirmed - BacklinkBot Submission',
      html: `
        <h1>Payment Confirmed</h1>
        <p>Thank you for your payment!</p>
        <p>Amount: $${paymentData.amount} ${paymentData.currency}</p>
        <p>Order ID: ${paymentData.order_id}</p>
        <p>Your submission is now in the verification queue.</p>
        <a href="https://backlinkbotai.com/dashboard" style="display: inline-block; background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Dashboard</a>
      `,
    });
  }

  /**
   * Send an email when submission verification begins
   */
  async sendVerificationStartedEmail(email, submissionData) {
    return await resend.emails.send({
      from: this.from,
      to: email,
      subject: 'Your Submission is Being Verified - BacklinkBot',
      html: `
        <h1>Verification In Progress</h1>
        <p>Good news! We're now verifying your submission for "${submissionData.product_name}".</p>
        <p>This typically takes 24-48 hours. We'll notify you once the verification is complete.</p>
        <a href="https://backlinkbotai.com/dashboard" style="display: inline-block; background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Check Status</a>
      `,
    });
  }

  /**
   * Send an email when submission is complete
   */
  async sendSubmissionCompletedEmail(email, submissionData) {
    return await resend.emails.send({
      from: this.from,
      to: email,
      subject: 'Congratulations! Your Submission is Live - BacklinkBot',
      html: `
        <h1>Your Submission is Live!</h1>
        <p>Great news! Your submission for "${submissionData.product_name}" has been approved and is now live.</p>
        <p>You can view your submission using the link below:</p>
        <a href="https://backlinkbotai.com/product/${submissionData.id}" style="display: inline-block; background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Submission</a>
      `,
    });
  }

  /**
   * Send a feedback request email
   */
  async sendFeedbackRequestEmail(email, submissionData) {
    return await resend.emails.send({
      from: this.from,
      to: email,
      subject: 'We Value Your Feedback - BacklinkBot',
      html: `
        <h1>How Was Your Experience?</h1>
        <p>We hope you're enjoying BacklinkBot!</p>
        <p>Your submission "${submissionData.product_name}" has been live for a while now, and we'd love to hear your feedback.</p>
        <a href="https://backlinkbotai.com/feedback/${submissionData.id}" style="display: inline-block; background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Share Your Feedback</a>
      `,
    });
  }
}

module.exports = new EmailService(); 