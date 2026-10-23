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

describe('loadConfig retention and presence settings', () => {
  it('has sensible defaults', () => {
    const c = loadConfig({});
    expect([c.EVENT_RETENTION_DAYS, c.EVENT_RETENTION_MIN_EVENTS, c.RETENTION_INTERVAL_MINUTES]).toEqual([
      90, 1000, 60,
    ]);
    expect(c.PRESENCE_BROADCAST_MIN_MS).toBe(150);
  });

  it('can switch retention off, but never keeps fewer than the 500 events replay and the feed read', () => {
    expect(loadConfig({ EVENT_RETENTION_DAYS: '0' }).EVENT_RETENTION_DAYS).toBe(0);
    expect(() => loadConfig({ EVENT_RETENTION_MIN_EVENTS: '499' })).toThrow();
    expect(loadConfig({ EVENT_RETENTION_MIN_EVENTS: '500' }).EVENT_RETENTION_MIN_EVENTS).toBe(500);
  });

  it('sizes the Postgres pool, with a floor so a write and a read can both get a connection', () => {
    expect(loadConfig({}).PG_POOL_MAX).toBe(10);
    expect(loadConfig({ PG_POOL_MAX: '40' }).PG_POOL_MAX).toBe(40);
    expect(() => loadConfig({ PG_POOL_MAX: '1' })).toThrow();
  });

  it('rejects nonsense values', () => {
    expect(() => loadConfig({ EVENT_RETENTION_DAYS: '-1' })).toThrow();
    expect(() => loadConfig({ PRESENCE_BROADCAST_MIN_MS: 'fast' })).toThrow();
  });
});
