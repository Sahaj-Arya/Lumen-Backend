import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Mail is behind an interface with a console transport as the default, so
 * signup works end to end in development with no SMTP account. Swap in a real
 * transport (nodemailer, Resend, SES) by adding a case here — nothing else in
 * the codebase needs to change.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

async function send(mail: Mail): Promise<void> {
  switch (config.MAIL_TRANSPORT) {
    case 'console':
      logger.info(
        { to: mail.to, subject: mail.subject, from: config.MAIL_FROM },
        `\n───── mail ─────\n${mail.text}\n────────────────`,
      );
      return;
    case 'noop':
      return;
    default:
      logger.warn({ transport: config.MAIL_TRANSPORT }, 'unknown mail transport, dropping mail');
  }
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = `${config.PUBLIC_APP_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  await send({
    to,
    subject: 'Verify your Lumen IoT email',
    text: [
      'Welcome to Lumen IoT.',
      '',
      'Confirm this address to activate your account:',
      link,
      '',
      'The link expires in 24 hours. If you did not sign up, ignore this email.',
    ].join('\n'),
  });
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const link = `${config.PUBLIC_APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await send({
    to,
    subject: 'Reset your Lumen IoT password',
    text: [
      'A password reset was requested for this address.',
      '',
      link,
      '',
      'The link expires in 1 hour. If this was not you, no action is needed —',
      'your password has not changed.',
    ].join('\n'),
  });
}
