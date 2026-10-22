import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  selectCards,
  selectColumns,
  selectComments,
  type BoardEvent,
  type BoardSnapshot,
  type Card,
  type Comment,
} from '@board/shared';
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
  dueDate: null,
  assigneeIds: [],
  labels: [],
});

const snapshot = (
  seq = 3,
  comments: Comment[] = [],
  olderComments?: BoardSnapshot['olderComments'],
): BoardSnapshot => ({
  board: { id: BOARD, name: 'Roadmap', createdAt: 'x' },
  columns: [
    { id: COL_A, boardId: BOARD, name: 'To do', position: 'a0' },
    { id: COL_B, boardId: BOARD, name: 'Done', position: 'a1' },
  ],
  cards: [card(1, COL_A, 'a0'), card(2, COL_A, 'a1')],
  comments,
  ...(olderComments && { olderComments }),
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
    return {
      emit: (event: string, payload: any, ack: (err: Error | null, a: any) => void) =>
        this.sent.push({ event, payload, ack }),
    };
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

async function setup(
  seq = 3,
  role: 'owner' | 'editor' | 'viewer' = 'editor',
  comments: Comment[] = [],
  older?: BoardSnapshot['olderComments'],
) {
  const socket = new FakeSocket();
  const client = new BoardClient(socket as unknown as BoardSocket, BOARD, ME);
  const join = socket.last('board:join');
  join.ack!(null, {
    ok: true,
    mode: 'snapshot',
    snapshot: snapshot(seq, comments, older),
    instance: 'server-1',
    presence: [],
    role,
  });
  await vi.advanceTimersByTimeAsync(0);
  return { socket, client };
}

const colIds = (client: BoardClient, col: string) => selectCards(client.getSnapshot().state!, col).map((c) => c.id);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

    socket.last('card:update').ack!(null, {
      ok: false,
      code: 'VERSION_CONFLICT',
      message: 'stale',
      current: card(1, COL_A, 'a0', 2),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().state!.cards[uid(101)]!.title).toBe('Card 1');
    expect(notices[0]).toMatch(/Someone else changed that card/);
    expect(socket.count('board:join')).toBe(2);
    expect(socket.last('board:join').payload).toEqual({ boardId: BOARD, lastSeq: 3 });
  });

  it('sends due date, assignees and labels, shows them at once, and rolls them back if refused', async () => {
    const { socket, client } = await setup();
    const notices: string[] = [];
    client.onNotice((n) => notices.push(n.message));
    client.updateCard(uid(101), { dueDate: '2026-03-15', assigneeIds: [ME.id], labels: ['bug'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().state!.cards[uid(101)]).toMatchObject({
      dueDate: '2026-03-15',
      assigneeIds: [ME.id],
      labels: ['bug'],
    });
    expect(socket.last('card:update').payload).toMatchObject({
      id: uid(101),
      dueDate: '2026-03-15',
      assigneeIds: [ME.id],
      labels: ['bug'],
    });

    socket.last('card:update').ack!(null, { ok: false, code: 'VALIDATION', message: 'Assignees must be members' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().state!.cards[uid(101)]).toMatchObject({ dueDate: null, assigneeIds: [], labels: [] });
    expect(notices).toEqual(['Assignees must be members']);
  });

  it('clears a due date by sending null', async () => {
    const { socket, client } = await setup();
    client.updateCard(uid(101), { dueDate: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.last('card:update').payload.dueDate).toBeNull();
  });

  it('does not send fields it was not given', async () => {
    const { socket, client } = await setup();
    client.updateCard(uid(101), { title: 'Only title' });
    await vi.advanceTimersByTimeAsync(0);
    const sent = socket.last('card:update').payload;
    expect('dueDate' in sent).toBe(false);
    expect('labels' in sent).toBe(false);
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

  it('tells the user an offline change was not saved instead of promising it will resume', async () => {
    const { socket, client } = await setup();
    const notices: { kind: string; message: string }[] = [];
    client.onNotice((n) => notices.push(n));
    socket.fire('disconnect');
    client.createCard(COL_A, 'Offline card');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe('error');
    expect(notices[0]?.message).toMatch(/not saved/i);
    expect(notices[0]?.message).not.toMatch(/resume/i);
    expect(socket.count('card:create')).toBe(0);
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

describe('roles', () => {
  it('remembers the role from the join ack', async () => {
    const { client } = await setup(3, 'viewer');
    expect(client.getSnapshot().role).toBe('viewer');
  });

  it('refuses writes from a viewer without touching the board or the network', async () => {
    const { socket, client } = await setup(3, 'viewer');
    const notices: { kind: string; message: string }[] = [];
    client.onNotice((n) => notices.push(n));
    client.createCard(COL_A, 'Nope');
    client.moveCard(uid(101), COL_B, 0);
    client.deleteCard(uid(101));
    expect(Object.keys(client.getSnapshot().state!.cards)).toHaveLength(2);
    expect(socket.count('card:create') + socket.count('card:move') + socket.count('card:delete')).toBe(0);
    expect(notices).toHaveLength(3);
    expect(notices.every((n) => n.kind === 'error' && /view-only/i.test(n.message))).toBe(true);
  });

  it('follows a live role change from the server', async () => {
    const { socket, client } = await setup(3, 'editor');
    socket.fire('board:access', { boardId: BOARD, role: 'viewer' });
    expect(client.getSnapshot().role).toBe('viewer');
    socket.fire('board:access', { boardId: BOARD, role: 'editor' });
    expect(client.getSnapshot().role).toBe('editor');
  });

  it('ignores access changes for another board', async () => {
    const { socket, client } = await setup(3, 'editor');
    socket.fire('board:access', { boardId: uid(77), role: null });
    expect(client.getSnapshot().status).toBe('live');
    expect(client.getSnapshot().role).toBe('editor');
  });

  it('marks the board as removed when access is revoked and discards unsent changes', async () => {
    const { socket, client } = await setup(3, 'editor');
    client.createCard(COL_A, 'In flight');
    socket.fire('board:access', { boardId: BOARD, role: null });
    const m = client.getSnapshot();
    expect(m.status).toBe('removed');
    expect(m.role).toBeNull();
    expect(Object.keys(m.state!.cards)).toHaveLength(2); // the optimistic card is gone
  });

  it('shows "removed" when rejoining a board it no longer has access to', async () => {
    const { socket, client } = await setup(3, 'editor');
    socket.fire('disconnect');
    socket.fire('connect');
    socket.last('board:join').ack!(null, { ok: false, code: 'NOT_FOUND', message: 'Board not found' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().status).toBe('removed');
  });
});

describe('healing lost broadcasts', () => {
  /** The ack the server sends when we are caught up: an empty replay. */
  const upToDate = (seq: number, events: BoardEvent[] = []) => ({
    ok: true,
    mode: 'replay',
    events,
    seq,
    instance: 'server-1',
    presence: [],
    role: 'editor',
  });

  it('asks the server where the log is every so often, even when nothing arrives', async () => {
    const { socket } = await setup(3);
    expect(socket.count('board:join')).toBe(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(socket.count('board:join')).toBe(2);
    expect(socket.last('board:join').payload).toMatchObject({ lastSeq: 3 });
  });

  it('keeps checking: each answered check schedules the next', async () => {
    const { socket } = await setup(3);
    for (let i = 2; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(40_000);
      expect(socket.count('board:join')).toBe(i);
      socket.last('board:join').ack!(null, upToDate(3));
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('applies an event the broadcast lost, without ever looking offline', async () => {
    const { socket, client } = await setup(3);
    await vi.advanceTimersByTimeAsync(40_000);
    // While the check is in flight the board still accepts edits.
    client.createCard(COL_A, 'During the check');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.count('card:create')).toBe(1);
    expect(client.getSnapshot().status).toBe('live');

    const missed = event(4, card(1, COL_B, 'a0', 2));
    socket.last('board:join').ack!(null, upToDate(4, [missed]));
    await vi.advanceTimersByTimeAsync(0);
    expect(colIds(client, COL_B)).toContain(uid(101));
    expect(client.getSnapshot().state?.seq).toBe(4);
    expect(client.getSnapshot().status).toBe('live');
  });

  it('checks as soon as the tab becomes visible again', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    const { socket } = await setup(3);
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(socket.count('board:join')).toBe(2);

    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(socket.count('board:join')).toBe(2); // hiding the tab asks nothing
  });

  it('does not check while disconnected or after the client is disposed', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    const { socket, client } = await setup(3);
    socket.fire('disconnect');
    await vi.advanceTimersByTimeAsync(120_000);
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(socket.count('board:join')).toBe(1);

    client.dispose();
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.count('board:join')).toBe(1);
  });

  it('shows "removed" if a check finds the board is no longer accessible', async () => {
    const { socket, client } = await setup(3);
    await vi.advanceTimersByTimeAsync(40_000);
    socket.last('board:join').ack!(null, { ok: false, code: 'NOT_FOUND', message: 'Board not found' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().status).toBe('removed');
  });
});

describe('column reorder', () => {
  const colOrder = (client: BoardClient) => selectColumns(client.getSnapshot().state!).map((c) => c.id);

  it('shows the new order at once and sends the new key', async () => {
    const { socket, client } = await setup(); // To do (a0), Done (a1)
    client.moveColumn(COL_A, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(colOrder(client)).toEqual([COL_B, COL_A]);
    const sent = socket.last('column:move').payload;
    expect(sent).toMatchObject({ id: COL_A, boardId: BOARD });
    expect(sent.position > 'a1').toBe(true);
  });

  it('keeps the order through ack and the confirming event', async () => {
    const { socket, client } = await setup(3);
    client.moveColumn(COL_A, 1);
    await vi.advanceTimersByTimeAsync(0);
    const { position } = socket.last('column:move').payload;
    socket.last('column:move').ack!(null, { ok: true, seq: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(colOrder(client)).toEqual([COL_B, COL_A]);
    socket.fire('board:event', {
      seq: 4,
      type: 'column.updated',
      boardId: BOARD,
      actorId: ME.id,
      ts: 'x',
      column: { id: COL_A, boardId: BOARD, name: 'To do', position },
    });
    expect(colOrder(client)).toEqual([COL_B, COL_A]);
    expect(client.getSnapshot().state?.seq).toBe(4);
  });

  it('puts the column back and says why when the server refuses', async () => {
    const { socket, client } = await setup();
    const notices: string[] = [];
    client.onNotice((n) => notices.push(n.message));
    client.moveColumn(COL_A, 1);
    await vi.advanceTimersByTimeAsync(0);
    socket.last('column:move').ack!(null, { ok: false, code: 'VALIDATION', message: 'Invalid position key' });
    await vi.advanceTimersByTimeAsync(0);
    expect(colOrder(client)).toEqual([COL_A, COL_B]);
    expect(notices).toContain('Invalid position key');
  });

  it('does nothing for a viewer, or when the column would not move', async () => {
    const viewer = await setup(3, 'viewer');
    viewer.client.moveColumn(COL_A, 1);
    expect(viewer.socket.count('column:move')).toBe(0);

    const { socket, client } = await setup();
    client.moveColumn(COL_A, 0); // already first
    expect(socket.count('column:move')).toBe(0);
  });
});

describe('board rename', () => {
  it('shows the new name at once, sends it trimmed, and keeps it through ack and event', async () => {
    const { socket, client } = await setup(3, 'owner');
    client.renameBoard('  Q4 launch  ');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().state?.board.name).toBe('Q4 launch');
    expect(socket.last('board:rename').payload).toEqual({ boardId: BOARD, name: 'Q4 launch' });

    socket.last('board:rename').ack!(null, { ok: true, seq: 4 });
    await vi.advanceTimersByTimeAsync(0);
    socket.fire('board:event', {
      seq: 4,
      type: 'board.renamed',
      boardId: BOARD,
      actorId: ME.id,
      ts: 'x',
      name: 'Q4 launch',
    });
    expect(client.getSnapshot().state?.board.name).toBe('Q4 launch');
    expect(client.getSnapshot().state?.seq).toBe(4);
  });

  it('follows a rename made by someone else', async () => {
    const { socket, client } = await setup(3, 'editor');
    socket.fire('board:event', {
      seq: 4,
      type: 'board.renamed',
      boardId: BOARD,
      actorId: uid(9),
      ts: 'x',
      name: 'Renamed elsewhere',
    });
    expect(client.getSnapshot().state?.board.name).toBe('Renamed elsewhere');
  });

  it('ignores a blank or unchanged name', async () => {
    const { socket, client } = await setup(3, 'owner');
    client.renameBoard('   ');
    client.renameBoard('Roadmap'); // the snapshot's current name
    expect(socket.count('board:rename')).toBe(0);
  });

  it('is for the owner: anyone else is told so and nothing is sent', async () => {
    for (const role of ['editor', 'viewer'] as const) {
      const { socket, client } = await setup(3, role);
      const notices: string[] = [];
      client.onNotice((n) => notices.push(n.message));
      client.renameBoard('Mine now');
      expect(socket.count('board:rename')).toBe(0);
      expect(client.getSnapshot().state?.board.name).toBe('Roadmap');
      expect(notices).toHaveLength(1);
    }
  });

  it('puts the old name back when the server refuses', async () => {
    const { socket, client } = await setup(3, 'owner');
    client.renameBoard('Nope');
    await vi.advanceTimersByTimeAsync(0);
    socket.last('board:rename').ack!(null, {
      ok: false,
      code: 'FORBIDDEN',
      message: 'Only the board owner can do that',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().state?.board.name).toBe('Roadmap');
  });
});

describe('comment edit and delete', () => {
  const comment = (n: number, authorId: string, body = `Comment ${n}`): Comment => ({
    id: uid(300 + n),
    boardId: BOARD,
    cardId: uid(101),
    authorId,
    authorName: authorId === ME.id ? 'Ada' : 'Someone',
    body,
    createdAt: `2026-01-01T00:00:0${n}.000Z`,
    editedAt: null,
  });
  const mine = comment(1, ME.id);
  const theirs = comment(2, uid(9));
  const bodies = (client: BoardClient) => selectComments(client.getSnapshot().state!, uid(101)).map((c) => c.body);

  it('edits my own comment at once and sends it trimmed', async () => {
    const { socket, client } = await setup(3, 'editor', [mine, theirs]);
    client.editComment(mine.id, '  better  ');
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies(client)).toEqual(['better', 'Comment 2']);
    expect(socket.last('comment:edit').payload).toEqual({ id: mine.id, boardId: BOARD, body: 'better' });
  });

  it('ignores a blank or unchanged edit', async () => {
    const { socket, client } = await setup(3, 'editor', [mine]);
    client.editComment(mine.id, '   ');
    client.editComment(mine.id, mine.body);
    expect(socket.count('comment:edit')).toBe(0);
  });

  it('will not edit someone else’s comment, even as the owner', async () => {
    const { socket, client } = await setup(3, 'owner', [mine, theirs]);
    const notices: string[] = [];
    client.onNotice((n) => notices.push(n.message));
    client.editComment(theirs.id, 'rewritten');
    expect(socket.count('comment:edit')).toBe(0);
    expect(bodies(client)).toEqual(['Comment 1', 'Comment 2']);
    expect(notices).toHaveLength(1);
  });

  it('restores the text and says why when the server refuses an edit', async () => {
    const { socket, client } = await setup(3, 'editor', [mine]);
    const notices: string[] = [];
    client.onNotice((n) => notices.push(n.message));
    client.editComment(mine.id, 'changed');
    await vi.advanceTimersByTimeAsync(0);
    socket.last('comment:edit').ack!(null, {
      ok: false,
      code: 'FORBIDDEN',
      message: 'You can only edit your own comments',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies(client)).toEqual(['Comment 1']);
    expect(notices).toContain('You can only edit your own comments');
  });

  it('deletes my own comment at once, and an owner can delete anyone’s', async () => {
    const editor = await setup(3, 'editor', [mine, theirs]);
    editor.client.deleteComment(mine.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies(editor.client)).toEqual(['Comment 2']);
    expect(editor.socket.last('comment:delete').payload).toEqual({ id: mine.id, boardId: BOARD });

    const owner = await setup(3, 'owner', [mine, theirs]);
    owner.client.deleteComment(theirs.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies(owner.client)).toEqual(['Comment 1']);
  });

  it('will not delete someone else’s comment unless owner, and puts a refused delete back', async () => {
    const editor = await setup(3, 'editor', [mine, theirs]);
    editor.client.deleteComment(theirs.id);
    expect(editor.socket.count('comment:delete')).toBe(0);
    expect(bodies(editor.client)).toEqual(['Comment 1', 'Comment 2']);

    editor.client.deleteComment(mine.id);
    await vi.advanceTimersByTimeAsync(0);
    editor.socket.last('comment:delete').ack!(null, { ok: false, code: 'VALIDATION', message: 'no' });
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies(editor.client)).toEqual(['Comment 1', 'Comment 2']);
  });

  it('follows edits and deletes made by others', async () => {
    const { socket, client } = await setup(3, 'editor', [mine, theirs]);
    socket.fire('board:event', {
      seq: 4,
      type: 'comment.updated',
      boardId: BOARD,
      actorId: uid(9),
      ts: 'x',
      comment: { ...theirs, body: 'edited by them', editedAt: '2026-01-02T00:00:00.000Z' },
    });
    expect(bodies(client)).toEqual(['Comment 1', 'edited by them']);
    socket.fire('board:event', {
      seq: 5,
      type: 'comment.deleted',
      boardId: BOARD,
      actorId: uid(9),
      ts: 'x',
      commentId: theirs.id,
    });
    expect(bodies(client)).toEqual(['Comment 1']);
  });

  it('does nothing for a viewer', async () => {
    const { socket, client } = await setup(3, 'viewer', [mine]);
    client.editComment(mine.id, 'nope');
    client.deleteComment(mine.id);
    expect(socket.count('comment:edit') + socket.count('comment:delete')).toBe(0);
    expect(bodies(client)).toEqual(['Comment 1']);
  });
});

describe('a join answered after access was revoked', () => {
  it('does not bring a removed board back to life', async () => {
    const { socket, client } = await setup(3, 'editor');
    await vi.advanceTimersByTimeAsync(40_000); // a periodic check goes out
    expect(socket.count('board:join')).toBe(2);
    socket.fire('board:access', { boardId: BOARD, role: null }); // revoked while it is in flight
    expect(client.getSnapshot().status).toBe('removed');

    socket.last('board:join').ack!(null, {
      ok: true,
      mode: 'replay',
      events: [],
      seq: 3,
      instance: 'server-1',
      presence: [],
      role: 'editor',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().status).toBe('removed');
    expect(client.getSnapshot().role).toBeNull();
  });
});

describe('older comments', () => {
  const comment = (n: number, body = `Comment ${n}`): Comment => ({
    id: uid(400 + n),
    boardId: BOARD,
    cardId: uid(101),
    authorId: uid(9),
    authorName: 'Someone',
    body,
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
    editedAt: null,
  });
  const bodies = (client: BoardClient) => selectComments(client.getSnapshot().state!, uid(101)).map((c) => c.body);
  const older = { [uid(101)]: { count: 2, cursor: 'cur-1' } };

  it('keeps the cursor from the snapshot, and merges a fetched page in order before the newest', async () => {
    const { client } = await setup(3, 'editor', [comment(5)], older);
    expect(client.getSnapshot().state!.olderComments).toEqual(older);

    client.addOlderComments(uid(101), [comment(1), comment(2)], null);
    expect(bodies(client)).toEqual(['Comment 1', 'Comment 2', 'Comment 5']);
    expect(client.getSnapshot().state!.olderComments).toEqual({});
  });

  it('keeps the new cursor while there are still older pages, and tells subscribers', async () => {
    const { client } = await setup(3, 'editor', [comment(5)], { [uid(101)]: { count: 3, cursor: 'cur-1' } });
    const seen = vi.fn();
    client.subscribe(seen);
    client.addOlderComments(uid(101), [comment(3), comment(4)], 'cur-2');
    expect(seen).toHaveBeenCalled();
    expect(client.getSnapshot().state!.olderComments).toEqual({ [uid(101)]: { count: 1, cursor: 'cur-2' } });
  });

  it('lets me edit a comment that was loaded later, like any other', async () => {
    const { socket, client } = await setup(3, 'editor', [comment(5)], older);
    const mine = { ...comment(1, 'mine'), authorId: ME.id, authorName: 'Ada' };
    client.addOlderComments(uid(101), [mine], null);
    client.editComment(mine.id, 'fixed');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.last('comment:edit').payload).toMatchObject({ id: mine.id, body: 'fixed' });
    expect(bodies(client)).toEqual(['fixed', 'Comment 5']);
  });
});
