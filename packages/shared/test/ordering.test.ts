import { describe, expect, it } from 'vitest';
import { compareOrdered, isValidOrderKey, keyBetween, keyForAppend, keyForIndex, keysBetween, resolveCollision, sortOrdered } from '../src/index.js';

const item = (id: string, position: string) => ({ id, position });

describe('fractional ordering', () => {
  it('generates keys that sort between their neighbours', () => {
    const a = keyBetween(null, null);
    const c = keyBetween(a, null);
    const b = keyBetween(a, c);
    expect(a < b && b < c).toBe(true);
  });

  it('survives many repeated inserts at the same spot without rewriting neighbours', () => {
    let lo = keyBetween(null, null);
    const hi = keyBetween(lo, null);
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(lo, hi);
      expect(mid > lo && mid < hi).toBe(true);
      lo = mid;
    }
  });

  it('generates n keys in order', () => {
    const keys = keysBetween(null, null, 25);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(25);
  });

  it('validates keys', () => {
    expect(isValidOrderKey('a0')).toBe(true);
    expect(isValidOrderKey('not a key!')).toBe(false);
    expect(isValidOrderKey('')).toBe(false);
  });

  it('sorts by position then id for identical keys', () => {
    const sorted = sortOrdered([item('b', 'a1'), item('z', 'a0'), item('a', 'a1')]);
    expect(sorted.map((i) => i.id)).toEqual(['z', 'a', 'b']);
    expect(compareOrdered(item('a', 'a0'), item('a', 'a0'))).toBe(0);
  });

  it('appends and inserts by index', () => {
    const items = [item('x', 'a0'), item('y', 'a1'), item('z', 'a2')];
    expect(keyForAppend(items) > 'a2').toBe(true);
    const k = keyForIndex(items, 1);
    expect(k > 'a0' && k < 'a1').toBe(true);
    expect(keyForIndex(items, 0) < 'a0').toBe(true);
    expect(keyForIndex(items, 99) > 'a2').toBe(true);
    expect(keyForIndex([], 0)).toBe('a0');
  });

  it('resolves a concurrent-drop collision by placing after the colliding sibling', () => {
    const siblings = [item('x', 'a0'), item('y', 'a1'), item('z', 'a2')];
    expect(resolveCollision('a05', siblings)).toBe('a05');
    const fixed = resolveCollision('a1', siblings);
    expect(fixed > 'a1' && fixed < 'a2').toBe(true);
    const tail = resolveCollision('a2', siblings);
    expect(tail > 'a2').toBe(true);
  });
});
