import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * Cards and columns are ordered by a fractional-indexing key (a short base-62
 * string). Inserting between two neighbours never rewrites any other row,
 * which is what makes concurrent drag & drop cheap to replicate.
 *
 * Keys are compared as plain strings (byte order) - use `compareOrdered`.
 */
export const keyBetween = (a: string | null, b: string | null): string => generateKeyBetween(a, b);
export const keysBetween = (a: string | null, b: string | null, n: number): string[] => generateNKeysBetween(a, b, n);

export function isValidOrderKey(key: string): boolean {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

export interface Ordered {
  id: string;
  position: string;
}

/** Strict byte-order comparison with id as a deterministic tiebreaker. */
export function compareOrdered(a: Ordered, b: Ordered): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const sortOrdered = <T extends Ordered>(items: readonly T[]): T[] => [...items].sort(compareOrdered);

/** Key that appends after the last item. */
export function keyForAppend(items: readonly Ordered[]): string {
  const sorted = sortOrdered(items);
  return keyBetween(sorted.at(-1)?.position ?? null, null);
}

/**
 * Key for dropping an item at `index` of `items` (items must NOT contain the
 * dragged item itself).
 */
export function keyForIndex(items: readonly Ordered[], index: number): string {
  const sorted = sortOrdered(items);
  const i = Math.max(0, Math.min(index, sorted.length));
  return keyBetween(sorted[i - 1]?.position ?? null, sorted[i]?.position ?? null);
}

/**
 * Server-side tie resolution: if `desired` collides with an existing sibling key
 * (two users dropped into the same gap concurrently), return a fresh key placed
 * directly after the colliding sibling.
 */
export function resolveCollision(desired: string, siblings: readonly Ordered[]): string {
  const sorted = sortOrdered(siblings);
  if (!sorted.some((s) => s.position === desired)) return desired;
  const next = sorted.find((s) => s.position > desired);
  return keyBetween(desired, next?.position ?? null);
}
