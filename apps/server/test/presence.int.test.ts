import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { PresenceMember } from '@board/shared';
import { Presence } from '../src/presence.js';
import { createWorld } from './helpers.js';

const member = (name: string, socketId = randomUUID()): PresenceMember => ({
  socketId,
  user: { id: randomUUID(), name, color: '#0091ff' },
  instance: 'x',
  editingCardId: null,
  joinedAt: Date.now(),
});

describe('presence in Redis', () => {
  const world = createWorld();
  afterAll(() => world.close());

  it('expires members whose heartbeat stops (crashed client) but keeps heartbeating ones', async () => {
    const presence = new Presence(world.redis, 3);
    const board = randomUUID();
    const crashed = member('Crashed');
    const alive = member('Alive');
    await presence.join(board, crashed);
    await presence.join(board, alive);
    expect((await presence.list(board)).map((m) => m.user.name).sort()).toEqual(['Alive', 'Crashed']);

    // Only "Alive" keeps being touched.
    const beat = setInterval(() => void presence.touch(board, [alive.socketId]), 500);
    await new Promise((r) => setTimeout(r, 3600));
    clearInterval(beat);

    expect((await presence.list(board)).map((m) => m.user.name)).toEqual(['Alive']);
    // Dangling index entry was pruned as a side effect of list().
    expect(await world.redis.zcard(`presence:idx:${board}`)).toBe(1);
  }, 15_000);

  it('updates the editing indicator and removes members on leave', async () => {
    const presence = new Presence(world.redis, 30);
    const board = randomUUID();
    const m = member('Ada');
    await presence.join(board, m);
    const card = randomUUID();
    await presence.setEditing(board, m.socketId, card);
    expect((await presence.list(board))[0]?.editingCardId).toBe(card);
    await presence.setEditing(board, m.socketId, null);
    expect((await presence.list(board))[0]?.editingCardId).toBeNull();
    await presence.leave(board, m.socketId);
    expect(await presence.list(board)).toEqual([]);
  });

  it('does not bring a member back to life when setEditing races with leave', async () => {
    const board = randomUUID();
    const m = member('Ada');
    // A client whose reads stall, so a leave can land between "read the member" and "write it back".
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new Proxy(world.redis, {
      get(target, prop, receiver) {
        if (prop !== 'get') return Reflect.get(target, prop, receiver);
        return async (...args: Parameters<typeof target.get>) => {
          const value = await target.get(...args);
          await gate;
          return value;
        };
      },
    });
    const presence = new Presence(slow, 30);
    await presence.join(board, m);
    const editing = presence.setEditing(board, m.socketId, randomUUID());
    await new Promise((r) => setTimeout(r, 50));
    await presence.leave(board, m.socketId);
    release();
    await editing;
    expect(await world.redis.exists(`presence:${board}:${m.socketId}`)).toBe(0);
    expect(await presence.list(board)).toEqual([]);
  });

  it('keeps every other field of the member when the editing card changes', async () => {
    const presence = new Presence(world.redis, 30);
    const board = randomUUID();
    const m = member('Ada');
    await presence.join(board, m);
    const card = randomUUID();
    await presence.setEditing(board, m.socketId, card);
    expect((await presence.list(board))[0]).toEqual({ ...m, editingCardId: card });
    expect(await world.redis.ttl(`presence:${board}:${m.socketId}`)).toBeGreaterThan(20);
  });
});
