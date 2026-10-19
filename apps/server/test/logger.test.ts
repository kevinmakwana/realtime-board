import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

function capture(format: 'json' | 'text') {
  const lines: string[] = [];
  const log = createLogger({ format, instance: 'server-7', write: (l) => lines.push(l) });
  return { log, lines };
}

describe('createLogger', () => {
  it('writes one JSON object per line with time, level, instance, message and fields', () => {
    const { log, lines } = capture('json');
    log('listening', { port: 3001 });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ msg: 'listening', port: 3001, instance: 'server-7', level: 'info' });
    expect(new Date(entry.time).toISOString()).toBe(entry.time);
  });

  it('turns a level field into the log level instead of printing it as data', () => {
    const { log, lines } = capture('json');
    log('boom', { level: 'error', code: 'X' });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ msg: 'boom', level: 'error', code: 'X' });
  });

  it('keeps multi-line messages (such as a printed email) on one JSON line', () => {
    const { log, lines } = capture('json');
    log('To: a@example.test\nSubject: Hi\n\nBody');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('To: a@example.test\nSubject: Hi\n\nBody');
  });

  it('prints plain readable text in text mode, with fields appended as JSON', () => {
    const { log, lines } = capture('text');
    log('plain message');
    log('with fields', { status: 200 });
    expect(lines).toEqual(['plain message\n', 'with fields {"status":200}\n']);
  });
});
