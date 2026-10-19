import type { GrantableRole } from '@board/shared';
import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Development default: "sends" the email by printing it, so the link is right there in the terminal. */
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: Logger) {}

  async send({ to, subject, text }: Mail): Promise<void> {
    const body = text
      .split('\n')
      .map((line) => `     ${line}`)
      .join('\n');
    this.log(`\n  ✉  To: ${to}\n     Subject: ${subject}\n${body}\n`);
  }
}

/** The one method of a nodemailer transport that we use (lets tests pass a stream transport). */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export class SmtpMailer implements Mailer {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {}

  async send({ to, subject, text }: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text });
  }
}

export function createMailer(config: Config, log: Logger): Mailer {
  if (config.SMTP_URL) return new SmtpMailer(nodemailer.createTransport(config.SMTP_URL), config.MAIL_FROM);
  if (config.NODE_ENV === 'production') {
    log('SMTP_URL is not set: sign-in and invitation emails are only printed to this log, nobody will receive them');
  }
  return new ConsoleMailer(log);
}

/** A header must stay on one line, whatever a user typed into a board or display name. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function magicLinkMail(to: string, link: string): Mail {
  return {
    to,
    subject: 'Your Realtime Board sign-in link',
    text: `Open this link to sign in. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for it, you can ignore this email.`,
  };
}

export interface InviteDetails {
  to: string;
  inviterName: string;
  boardName: string;
  role: GrantableRole;
  link: string;
}

export function inviteMail({ to, inviterName, boardName, role, link }: InviteDetails): Mail {
  const who = oneLine(inviterName);
  const board = oneLine(boardName);
  return {
    to,
    subject: `${who} invited you to "${board}"`,
    text: `${who} invited you to the board "${board}" as ${role === 'editor' ? 'an editor' : 'a viewer'} (${role}).\n\nOpen it: ${link}\n\nSign in with this email address (${to}) and the board will be in your list.`,
  };
}

/** Told about every new invitation; failures are the notifier's problem, never the invite's. */
export type InviteNotifier = (details: Omit<InviteDetails, 'link'> & { boardId: string }) => void;

export function createInviteNotifier(mailer: Mailer, webOrigin: string, log: Logger): InviteNotifier {
  return ({ boardId, ...rest }) => {
    const mail = inviteMail({ ...rest, link: `${webOrigin}/boards/${boardId}` });
    mailer.send(mail).catch((err) => log(`failed to send the invitation to ${rest.to}: ${String(err)}`));
  };
}
