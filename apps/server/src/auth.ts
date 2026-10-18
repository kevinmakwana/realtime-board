import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { PublicUser, User } from '@board/shared';
import type { Redis } from 'ioredis';
import type { Pool } from './db.js';

const PALETTE = ['#e5484d', '#f76b15', '#d6a100', '#30a46c', '#0091ff', '#6e56cf', '#d6409f', '#12a594'];

export const colorFor = (seed: string): string => {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? PALETTE[0]!;
};

const claimsSchema = z.object({ sub: z.uuid(), name: z.string(), color: z.string() });

export function signToken(user: PublicUser, secret: string): string {
  return jwt.sign({ name: user.name, color: user.color }, secret, { subject: user.id, expiresIn: '7d' });
}

/** Returns the claims as a PublicUser, or null for a missing/invalid/expired token. */
export function verifyToken(token: string | undefined, secret: string): PublicUser | null {
  if (!token) return null;
  try {
    const claims = claimsSchema.parse(jwt.verify(token, secret));
    return { id: claims.sub, name: claims.name, color: claims.color };
  } catch {
    return null;
  }
}

export const nameFromEmail = (email: string): string =>
  (email.split('@')[0] ?? 'user')
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(' ');

export async function upsertUser(pool: Pool, email: string, name?: string): Promise<User> {
  const normalized = email.trim().toLowerCase();
  const { rows } = await pool.query<User>(
    `INSERT INTO users (id, email, name, color) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET name = COALESCE($5, users.name)
     RETURNING id, email, name, color`,
    [randomUUID(), normalized, name ?? nameFromEmail(normalized), colorFor(normalized), name ?? null],
  );
  const user = rows[0]!;
  // Pending invites for this address become memberships. Every sign-in path goes through here.
  await pool.query(
    `WITH claimed AS (DELETE FROM board_invites WHERE email = $1 RETURNING board_id, role)
     INSERT INTO board_members (board_id, user_id, role)
     SELECT board_id, $2, role FROM claimed
     ON CONFLICT (board_id, user_id) DO NOTHING`,
    [normalized, user.id],
  );
  return user;
}

const MAGIC_TTL_SECONDS = 15 * 60;

/** Stores a single-use token in Redis and returns the link that would be emailed. */
export async function createMagicLink(redis: Redis, email: string, webOrigin: string): Promise<string> {
  const token = randomBytes(24).toString('hex');
  await redis.set(`magic:${token}`, email.trim().toLowerCase(), 'EX', MAGIC_TTL_SECONDS);
  return `${webOrigin}/auth/verify?token=${token}`;
}

/** Consumes a magic-link token (single use). Returns the email, or null if unknown/expired/used. */
export async function consumeMagicToken(redis: Redis, token: string): Promise<string | null> {
  return redis.getdel(`magic:${token}`);
}
