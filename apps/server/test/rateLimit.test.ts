import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/rateLimit.js';

describe('TokenBucket', () => {
  it('allows a burst up to capacity then rejects', () => {
    let t = 0;
    const b = new TokenBucket(3, 1, () => t);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
  });

  it('refills over time and never exceeds capacity', () => {
    let t = 0;
    const b = new TokenBucket(2, 2, () => t);
    b.take();
    b.take();
    expect(b.take()).toBe(false);
    t += 500; // +1 token
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    t += 60_000;
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
  });
});
