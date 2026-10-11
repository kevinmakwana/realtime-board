import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectCards, type BoardEvent, type BoardSnapshot, type Card } from '@board/shared';
import { BoardClient, type BoardSocket } from '../src/lib/boardClient';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOARD = uid(1);
const COL_A = uid(10);
const COL_B = uid(11);
const ME = { id: uid(2), name: 'Ada', color: '#0091ff' };

const card = (n: number, columnId: string, position: string, version = 1): Card => ({
  id: uid(100 + n),
  boardId: BOARD,
  columnId,
  title: `Card ${n}`,
  description: '',
  position,
  version,
  updatedAt: 'x',
});

const snapshot = (seq = 3): BoardSnapshot => ({
  board: { id: BOARD, name: 'Roadmap', createdAt: 'x' },
  columns: [
    { id: COL_A, boardId: BOARD, name: 'To do', position: 'a0' },
    { id: COL_B, boardId: BOARD, name: 'Done', position: 'a1' },
  ],
  cards: [card(1, COL_A, 'a0'), card(2, COL_A, 'a1')],
  comments: [],
  seq,
});

const event = (seq: number, c: Card, type: 'card.moved' | 'card.updated' = 'card.moved'): BoardEvent => ({
  seq,
  type,
  boardId: BOARD,
  actorId: uid(9),
  ts: 'x',
  card: c,
});

/** A scriptable stand-in for socket.io-client: tests answer each emitted command by hand. */
class FakeSocket {
  connected = true;
  id = 'sock-1';
  handlers = new Map<string, ((...a: any[]) => void)[]>();
  sent: { event: string; payload: any; ack?: (err: Error | null, a: any) => void }[] = [];

  on(ev: string, fn: (...a: any[]) => void) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  off() {
    this.handlers.clear();
    return this;
  }
  fire(ev: string, ...args: any[]) {
    for (const fn of this.handlers.get(ev) ?? []) fn(...args);
  }
  emit(event: string, payload: any) {
    this.sent.push({ event, payload });
  }
  timeout() {
    return { emit: (event: string, payload: any, ack: (err: Error | null, a: any) => void) => this.sent.push({ event, payload, ack }) };
  }
  disconnect() {
    this.connected = false;
  }
  last(event: string) {
    return this.sent.filter((s) => s.event === event).at(-1)!;
  }
  count(event: string) {
    return this.sent.filter((s) => s.event === event).length;
  }
}

async function setup(seq = 3) {
  const socket = new FakeSocket();
  const client = new BoardClient(socket as unknown as BoardSocket, BOARD, ME);
  const join = socket.last('board:join');
  join.ack!(null, { ok: true, mode: 'snapshot', snapshot: snapshot(seq), instance: 'server-1', presence: [] });
  await vi.advanceTimersByTimeAsync(0);
  return { socket, client };
}

const colIds = (client: BoardClient, col: string) =>
  selectCards(client.getSnapshot().state!, col).map((c) => c.id);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('BoardClient', () => {
  it('joins on connect, loads the snapshot and reports the serving instance', async () => {
    const { client } = await setup();
    const m = client.getSnapshot();
    expect(m.status).toBe('live');
    expect(m.instance).toBe('server-1');
    expect(m.state?.seq).toBe(3);
    expect(colIds(client, COL_A)).toEqual([uid(101), uid(102)]);
  });

  it('applies a move optimistically, and keeps it through ack -> event without flicker', async () => {
    const { socket, client } = await setup();
    client.moveCard(uid(101), COL_B, 0);
    await vi.advanceTimersByTimeAsync(0);
    // Optimistic: visible before any server round trip.
    expect(colIds(client, COL_B)).toEqual([uid(101)]);

    const cmd = socket.last('card:move');
    expect(cmd.payload).toMatchObject({ id: uid(101), columnId: COL_B, baseVersion: 1 });
    cmd.ack!(null, { ok: true, seq: 4, version: 2 });
    await vi.advanceTimersByTimeAsync(0);
    // Acked but the event has not arrived yet: still shown, not reverted.
    expect(colIds(client, COL_B)).toEqual([uid(101)]);

    socket.fire('board:event', event(4, { ...card(1, COL_B, cmd.payload.position, 2) }));
    expect(colIds(client, COL_B)).toEqual([uid(101)]);
    expect(client.getSnapshot().state?.seq).toBe(4);
  });

  it('rolls back the optimistic change when the server rejects it', async () => {
    const { socket, client } = await setup();
    const notices: string[] = [];
    client.onNotice((n) => notices.push(n.message));
    client.moveCard(uid(101), COL_B, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(colIds(client, COL_B)).toEqual([uid(101)]);

    socket.last('card:move').ack!(null, { ok: false, code: 'VALIDATION', message: 'nope' });
    await vi.advanceTimersByTimeAsync(0);
    expect(colIds(client, COL_B)).toEqual([]);
    expect(colIds(client, COL_A)).toEqual([uid(101), uid(102)]);
    expect(notices).toEqual(['nope']);
  });

  it('on a version conflict rolls back, explains, and resyncs from the last seen seq', async () => {
    const { socket, client } = await setup();
    const notices: string[] = [];
    client.onNotice((n) => notices.push(n.message));
    client.updateCard(uid(101), { title: 'Mine' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().state!.cards[uid(101)]!.title).toBe('Mine');

    socket.last('card:update').ack!(null, { ok: false, code: 'VERSION_CONFLICT', message: 'stale', current: card(1, COL_A, 'a0', 2) });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().state!.cards[uid(101)]!.title).toBe('Card 1');
    expect(notices[0]).toMatch(/Someone else changed that card/);
    expect(socket.count('board:join')).toBe(2);
    expect(socket.last('board:join').payload).toEqual({ boardId: BOARD, lastSeq: 3 });
  });

  it('chains commands on the same card so the second uses the version the first produced', async () => {
    const { socket, client } = await setup();
    client.updateCard(uid(101), { title: 'Renamed' });
    await vi.advanceTimersByTimeAsync(0);
    client.moveCard(uid(101), COL_B, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.count('card:move')).toBe(0); // waits for the update's ack
    socket.last('card:update').ack!(null, { ok: true, seq: 4, version: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.last('card:move').payload.baseVersion).toBe(2);
  });

  it('buffers out-of-order events and applies them in sequence', async () => {
    const { socket, client } = await setup();
    socket.fire('board:event', event(5, card(2, COL_B, 'a0', 3), 'card.moved'));
    expect(client.getSnapshot().state?.seq).toBe(3); // held back: 4 is missing
    socket.fire('board:event', event(4, card(1, COL_B, 'a1', 2), 'card.moved'));
    expect(client.getSnapshot().state?.seq).toBe(5);
    expect(colIds(client, COL_B)).toEqual([uid(102), uid(101)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.count('board:join')).toBe(1); // gap healed itself: no resync needed
  });

  it('requests catch-up when a gap does not heal', async () => {
    const { socket, client } = await setup();
    socket.fire('board:event', event(6, card(2, COL_B, 'a0', 3)));
    expect(client.getSnapshot().state?.seq).toBe(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.count('board:join')).toBe(2);
    expect(socket.last('board:join').payload).toEqual({ boardId: BOARD, lastSeq: 3 });
  });

  it('after a disconnect, re-joins with its last seq and applies the replayed events', async () => {
    const { socket, client } = await setup();
    socket.fire('disconnect');
    expect(client.getSnapshot().status).toBe('reconnecting');

    socket.fire('connect');
    const rejoin = socket.last('board:join');
    expect(rejoin.payload).toEqual({ boardId: BOARD, lastSeq: 3 });
    rejoin.ack!(null, {
      ok: true,
      mode: 'replay',
      seq: 5,
      events: [event(4, card(1, COL_B, 'a0', 2)), event(5, card(2, COL_B, 'a1', 2))],
      instance: 'server-2',
      presence: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    const m = client.getSnapshot();
    expect(m.status).toBe('live');
    expect(m.instance).toBe('server-2');
    expect(m.state?.seq).toBe(5);
    expect(colIds(client, COL_B)).toEqual([uid(101), uid(102)]);
  });

  it('refuses optimistic writes while offline', async () => {
    const { socket, client } = await setup();
    const notices: string[] = [];
    client.onNotice((n) => notices.push(n.message));
    socket.fire('disconnect');
    client.createCard(COL_A, 'Offline card');
    expect(Object.keys(client.getSnapshot().state!.cards)).toHaveLength(2);
    expect(notices[0]).toMatch(/offline/i);
  });

  it('throttles cursor packets and always sends the latest position', async () => {
    const { socket, client } = await setup();
    for (let i = 1; i <= 10; i++) client.sendCursor(i / 10, 0.5);
    expect(socket.count('presence:cursor')).toBe(1); // first goes out immediately
    await vi.advanceTimersByTimeAsync(60);
    expect(socket.count('presence:cursor')).toBe(2);
    expect(socket.last('presence:cursor').payload).toMatchObject({ x: 1, y: 0.5 });
  });
});
