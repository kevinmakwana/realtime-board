import { describe, expect, it } from 'vitest';
import { colorFor, nameFromEmail, signToken, verifyToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const user = { id: '11111111-1111-4111-8111-111111111111', name: 'Ada Lovelace', color: '#0091ff' };

describe('tokens', () => {
  it('round-trips a user', () => {
    expect(verifyToken(signToken(user, 'secret-123'), 'secret-123')).toEqual(user);
  });
  it('rejects wrong secret, garbage and missing tokens', () => {
    const t = signToken(user, 'secret-123');
    expect(verifyToken(t, 'other-secret')).toBeNull();
    expect(verifyToken('garbage', 'secret-123')).toBeNull();
    expect(verifyToken(undefined, 'secret-123')).toBeNull();
  });
});

describe('helpers', () => {
  it('derives a stable colour and a display name', () => {
    expect(colorFor('a@b.test')).toBe(colorFor('a@b.test'));
    expect(nameFromEmail('ada.lovelace@example.test')).toBe('Ada Lovelace');
  });
});

describe('config', () => {
  it('has dev defaults and disables dev login in production', () => {
    expect(loadConfig({}).AUTH_DEV_LOGIN).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production' }).AUTH_DEV_LOGIN).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', AUTH_DEV_LOGIN: 'true' }).AUTH_DEV_LOGIN).toBe(true);
  });
});
