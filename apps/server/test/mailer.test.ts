import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConsoleMailer, SmtpMailer, createMailer, inviteMail, magicLinkMail } from '../src/mailer.js';

describe('ConsoleMailer', () => {
  it('prints the recipient, subject and body so a developer can follow the link', async () => {
    const logs: string[] = [];
    await new ConsoleMailer((m) => logs.push(m)).send({
      to: 'ada@example.test',
      subject: 'Hello',
      text: 'Open http://localhost:5180/auth/verify?token=abc',
    });
    const out = logs.join('\n');
    expect(out).toContain('ada@example.test');
    expect(out).toContain('Hello');
    expect(out).toContain('http://localhost:5180/auth/verify?token=abc');
  });
});

describe('SmtpMailer', () => {
  it('hands a plain-text message with the configured sender to the transport', async () => {
    let raw = '';
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const transport = {
      sendMail: async (message: Parameters<typeof stream.sendMail>[0]) => {
        const info = await stream.sendMail(message);
        raw = info.message.toString();
        return info;
      },
    };
    await new SmtpMailer(transport, 'Realtime Board <no-reply@example.test>').send({
      to: 'ada@example.test',
      subject: 'Hello there',
      text: 'Body line',
    });
    expect(raw).toMatch(/^From: Realtime Board <no-reply@example\.test>/m);
    expect(raw).toMatch(/^To: ada@example\.test/m);
    expect(raw).toMatch(/^Subject: Hello there/m);
    expect(raw).toContain('Body line');
  });

  it('lets a transport failure reach the caller', async () => {
    const transport = {
      sendMail: async () => {
        throw new Error('connection refused');
      },
    };
    await expect(
      new SmtpMailer(transport, 'x@example.test').send({ to: 'a@example.test', subject: 's', text: 't' }),
    ).rejects.toThrow('connection refused');
  });
});

describe('createMailer', () => {
  it('prints to the console unless SMTP_URL is set', () => {
    expect(createMailer(loadConfig({}), () => {})).toBeInstanceOf(ConsoleMailer);
    expect(createMailer(loadConfig({ SMTP_URL: 'smtp://localhost:2525' }), () => {})).toBeInstanceOf(SmtpMailer);
  });

  it('warns once when production has no SMTP_URL, because nobody would ever receive a link', () => {
    const logs: string[] = [];
    createMailer(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'a-private-production-secret' }), (m) =>
      logs.push(m),
    );
    expect(logs.join(' ')).toMatch(/SMTP_URL/);
    const quiet: string[] = [];
    createMailer(loadConfig({}), (m) => quiet.push(m));
    expect(quiet).toEqual([]);
  });
});

describe('config', () => {
  it('treats an empty SMTP_URL as unset and rejects a malformed one', () => {
    expect(loadConfig({ SMTP_URL: '' }).SMTP_URL).toBeUndefined();
    expect(() => loadConfig({ SMTP_URL: 'not a url' })).toThrow();
    expect(loadConfig({}).MAIL_FROM).toMatch(/no-reply@/);
  });
});

describe('message content', () => {
  it('puts the sign-in link and its lifetime in the magic-link email', () => {
    const mail = magicLinkMail('ada@example.test', 'http://localhost:5180/auth/verify?token=abc');
    expect(mail.to).toBe('ada@example.test');
    expect(mail.text).toContain('http://localhost:5180/auth/verify?token=abc');
    expect(mail.text).toMatch(/15 minutes/);
  });

  it('names who invited you, to what, as which role, and links the board', () => {
    const mail = inviteMail({
      to: 'grace@example.test',
      inviterName: 'Ada Lovelace',
      boardName: 'Launch plan',
      role: 'viewer',
      link: 'http://localhost:5180/boards/123',
    });
    expect(mail.subject).toBe('Ada Lovelace invited you to "Launch plan"');
    expect(mail.text).toContain('viewer');
    expect(mail.text).toContain('http://localhost:5180/boards/123');
    expect(mail.text).toContain('grace@example.test'); // tells a new user which address to sign in with
  });

  it('keeps the subject on one line even if a board name contains a line break', () => {
    const mail = inviteMail({
      to: 'g@example.test',
      inviterName: 'Ada',
      boardName: 'Plan\r\nBcc: evil@example.test',
      role: 'editor',
      link: 'http://localhost:5180/boards/1',
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});
