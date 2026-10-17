import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig production guard', () => {
  it('refuses the built-in dev JWT secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'dev-only-change-me' })).toThrow(/JWT_SECRET/);
  });

  it('accepts a real secret in production', () => {
    const config = loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'a-long-random-production-secret' });
    expect(config.JWT_SECRET).toBe('a-long-random-production-secret');
  });

  it('keeps the dev default outside production', () => {
    expect(loadConfig({}).JWT_SECRET).toBe('dev-only-change-me');
    expect(loadConfig({ NODE_ENV: 'test' }).JWT_SECRET).toBe('dev-only-change-me');
  });

  it('does not trust proxy headers unless asked to', () => {
    expect(loadConfig({}).TRUST_PROXY).toBe(0);
    expect(loadConfig({ TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
  });
});
