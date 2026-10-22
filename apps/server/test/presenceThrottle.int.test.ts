import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../src/server.js';
import { createWorld, emit, join, startInstance, type TestWorld, waitFor } from './helpers.js';

describe('presence:editing rebroadcasts', () => {
  const world: TestWorld = createWorld();
  let server: ServerInstance;
  beforeAll(async () => {
    server = await startInstance('throttle-a', { PRESENCE_BROADCAST_MIN_MS: 200 });
  });
  afterAll(async () => {
    await world.close();
    await server.close();
  });

  async function twoOnABoard() {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const snap = await world.newBoard(ada.id, [grace.id]);
    const sa = await world.connect(server.port, ada.token);
    const sg = await world.connect(server.port, grace.token);
    await join(sa, snap.board.id);
    await join(sg, snap.board.id);
    return { sa, sg, boardId: snap.board.id };
  }

  it('sends the first change at once, folds a burst into one more, and ends on the latest value', async () => {
    const { sa, sg, boardId } = await twoOnABoard();
    const received: (string | null | undefined)[] = [];
    sg.on('presence:update', (p) => received.push(p.members.find((m) => m.socketId === sa.id)?.editingCardId));

    const cards = Array.from({ length: 12 }, () => randomUUID());
    const t0 = Date.now();
    for (const cardId of cards) await emit(sa, 'presence:editing', { boardId, cardId });
    await emit(sa, 'presence:editing', { boardId, cardId: null });
    const burstMs = Date.now() - t0;

    // The last state is always delivered, however many were folded away.
    await waitFor(sg, 'presence:update', (p) => p.members.find((m) => m.socketId === sa.id)?.editingCardId === null);
    expect(received.at(-1) ?? null).toBeNull();
    // 13 changes inside a few hundred ms: one immediately, then at most one per 200 ms window.
    const windows = Math.ceil(burstMs / 200) + 1;
    expect(received.length).toBeLessThanOrEqual(windows + 1);
    expect(received.length).toBeLessThan(13);
    expect(received[0]).toBe(cards[0]); // the first change was not delayed
  });

  it('a lone change is broadcast immediately and nothing more follows it', async () => {
    const { sa, sg, boardId } = await twoOnABoard();
    let updates = 0;
    sg.on('presence:update', () => updates++);
    const cardId = randomUUID();
    const seen = waitFor(sg, 'presence:update', (p) => p.members.some((m) => m.editingCardId === cardId), 150);
    await emit(sa, 'presence:editing', { boardId, cardId });
    await seen; // well inside the 200 ms window
    await new Promise((r) => setTimeout(r, 500));
    expect(updates).toBe(1);
  });

  it('keeps boards apart: a burst on one does not delay another', async () => {
    const one = await twoOnABoard();
    const two = await twoOnABoard();
    for (let i = 0; i < 5; i++) await emit(one.sa, 'presence:editing', { boardId: one.boardId, cardId: randomUUID() });
    const cardId = randomUUID();
    const seen = waitFor(two.sg, 'presence:update', (p) => p.members.some((m) => m.editingCardId === cardId), 150);
    await emit(two.sa, 'presence:editing', { boardId: two.boardId, cardId });
    await seen;
  });
});
