import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyBetween } from '@board/shared';
import type { ServerInstance } from '../src/server.js';
import { addCard, collectEvents, createWorld, emit, join, startPair, type TestWorld } from './helpers.js';

describe('cross-instance broadcast (Redis adapter)', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;

  beforeAll(async () => {
    [a, b] = await startPair('instance-a', 'instance-b');
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  it('delivers an event committed on instance A to a client connected to instance B', async () => {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const snap = await world.newBoard(ada.id, [grace.id]);

    const onA = await world.connect(a.port, ada.token);
    const onB = await world.connect(b.port, grace.token);
    const eventsB = collectEvents(onB);

    const joinA = await join(onA, snap.board.id);
    const joinB = await join(onB, snap.board.id);
    expect(joinA).toMatchObject({ ok: true, instance: 'instance-a', mode: 'snapshot' });
    expect(joinB).toMatchObject({ ok: true, instance: 'instance-b' });

    const { ack } = await addCard(onA, snap, 'Write the launch post');
    expect(ack).toMatchObject({ ok: true, seq: 1, version: 1 });

    await expect.poll(() => eventsB.length, { timeout: 5000 }).toBe(1);
    expect(eventsB[0]).toMatchObject({ type: 'card.created', seq: 1, actorId: ada.id });
    expect((eventsB[0] as any).card.title).toBe('Write the launch post');
  });

  it('shows presence from both instances and relays cursors across instances', async () => {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const snap = await world.newBoard(ada.id, [grace.id]);
    const onA = await world.connect(a.port, ada.token);
    const onB = await world.connect(b.port, grace.token);
    await join(onA, snap.board.id);
    await join(onB, snap.board.id);

    const presenceOnA: string[][] = [];
    onA.on('presence:update', (p) => presenceOnA.push(p.members.map((m) => `${m.user.name}@${m.instance}`).sort()));
    const cursors: any[] = [];
    onA.on('presence:cursor', (c) => cursors.push(c));

    // Grace starts editing a card; Ada (other instance) must see the indicator.
    const { id: cardId } = await addCard(onB, snap, 'Shared card');
    await emit(onB, 'presence:editing', { boardId: snap.board.id, cardId });
    await expect.poll(() => presenceOnA.at(-1), { timeout: 5000 }).toEqual(['Ada@instance-a', 'Grace@instance-b']);

    let lastMembers: any;
    onA.on('presence:update', (p) => (lastMembers = p.members));
    await emit(onB, 'presence:editing', { boardId: snap.board.id, cardId });
    await expect
      .poll(() => lastMembers?.find((m: any) => m.user.name === 'Grace')?.editingCardId, { timeout: 5000 })
      .toBe(cardId);

    onB.emit('presence:cursor', { boardId: snap.board.id, x: 0.25, y: 0.75 });
    await expect.poll(() => cursors.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(cursors[0]).toMatchObject({ x: 0.25, y: 0.75, userId: grace.id });
  });

  it('keeps event sequence numbers gapless and unique under concurrent writers on both instances', async () => {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const snap = await world.newBoard(ada.id, [grace.id]);
    const onA = await world.connect(a.port, ada.token);
    const onB = await world.connect(b.port, grace.token);
    await join(onA, snap.board.id);
    await join(onB, snap.board.id);
    const seen = collectEvents(onA);

    const acks = await Promise.all(
      Array.from(
        { length: 24 },
        (_, i) => addCard(i % 2 ? onA : onB, snap, `Card ${i}`, keyBetween(null, null)), // all want the SAME position
      ),
    );
    expect(acks.every((r) => r.ack.ok)).toBe(true);

    await expect.poll(() => seen.length, { timeout: 8000 }).toBe(24);
    const seqs = seen.map((e) => e.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));

    // Same requested position -> the server resolved collisions: every card got a distinct key.
    const finalSnap = await world.service.getSnapshot(snap.board.id);
    const positions = finalSnap!.cards.map((c) => c.position);
    expect(new Set(positions).size).toBe(24);
    expect(finalSnap!.seq).toBe(24);
  });

  it('rejects sockets without a valid token', async () => {
    await expect(world.connect(a.port, 'not-a-jwt')).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('rejects commands for boards the socket has not joined', async () => {
    const ada = await world.newUser('Ada');
    const snap = await world.newBoard(ada.id);
    const s = await world.connect(a.port, ada.token);
    const { ack } = await addCard(s, snap, 'sneaky');
    expect(ack).toMatchObject({ ok: false, code: 'NOT_JOINED' });
    expect(randomUUID()).toBeTruthy();
  });
});
