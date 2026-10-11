import type { Socket } from 'socket.io-client';
import {
  SeqBuffer,
  applyEvents,
  applyPending,
  keyForAppend,
  keyForIndex,
  selectCards,
  selectColumns,
  stateFromSnapshot,
  type Ack,
  type BoardEvent,
  type BoardState,
  type ClientToServerEvents,
  type JoinAck,
  type PendingOp,
  type PresenceMember,
  type PublicUser,
  type ServerToClientEvents,
} from '@board/shared';
import { uuid } from './uuid';

export type BoardSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'unauthorized';

export interface RemoteCursor {
  socketId: string;
  userId: string;
  x: number;
  y: number;
  at: number;
}

/** Immutable view model handed to React. A new object is produced on every change. */
export interface BoardViewModel {
  status: ConnectionStatus;
  instance: string | null;
  /** Authoritative state with this client's unconfirmed ops layered on top. Null until first join. */
  state: BoardState | null;
  presence: PresenceMember[];
  cursors: RemoteCursor[];
  selfSocketId: string | null;
}

export interface Notice {
  kind: 'error' | 'info';
  message: string;
}

interface PendingEntry {
  id: number;
  op: PendingOp;
  /** Set once the server acked; the entry is dropped when the event log reaches this seq. */
  ackSeq?: number;
}

type Listener = () => void;

const ACK_TIMEOUT_MS = 8000;
const GAP_RESYNC_MS = 400;
const CURSOR_SEND_INTERVAL_MS = 50;
const CURSOR_IDLE_MS = 8000;

/**
 * Client-side sync engine for one board, independent of React.
 *
 *   authoritative state  = snapshot + events applied strictly in seq order (SeqBuffer)
 *   view state           = authoritative state + pending optimistic ops
 *
 * Rollback is therefore free: when the server rejects a command we just drop its pending op and the
 * view falls back to the authoritative state. Reconnects re-join with the last applied seq and the
 * server replies with the missed events (or a snapshot if we are too far behind).
 */
export class BoardClient {
  private auth: BoardState | null = null;
  private pending: PendingEntry[] = [];
  private buffer = new SeqBuffer(0);
  private known = new Map<string, number>(); // latest card version seen in an ack
  private chains = new Map<string, Promise<void>>(); // serialises commands that touch the same card
  private nextId = 1;
  private joined = false;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private lastCursorSent = 0;
  private queuedCursor: { x: number; y: number } | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  private listeners = new Set<Listener>();
  private noticeListeners = new Set<(n: Notice) => void>();
  private model: BoardViewModel = {
    status: 'connecting',
    instance: null,
    state: null,
    presence: [],
    cursors: [],
    selfSocketId: null,
  };
  private cursors = new Map<string, RemoteCursor>();

  constructor(
    private readonly socket: BoardSocket,
    private readonly boardId: string,
    private readonly user: PublicUser,
  ) {
    socket.on('connect', () => void this.join());
    socket.on('disconnect', () => this.onDisconnect());
    socket.on('connect_error', (err) => {
      if (err.message === 'UNAUTHORIZED') this.update({ status: 'unauthorized' });
      else this.update({ status: this.auth ? 'reconnecting' : 'connecting' });
    });
    socket.on('board:event', (e) => this.ingest([e]));
    socket.on('presence:update', (p) => {
      if (p.boardId !== this.boardId) return;
      const alive = new Set(p.members.map((m) => m.socketId));
      for (const id of this.cursors.keys()) if (!alive.has(id)) this.cursors.delete(id);
      this.update({ presence: p.members });
    });
    socket.on('presence:cursor', (c) => {
      if (c.boardId !== this.boardId) return;
      this.cursors.set(c.socketId, { socketId: c.socketId, userId: c.userId, x: c.x, y: c.y, at: Date.now() });
      this.update({});
    });
    this.pruneTimer = setInterval(() => this.pruneCursors(), 2000);
    if (socket.connected) void this.join();
  }

  /* ---------------- store plumbing (useSyncExternalStore) ---------------- */

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): BoardViewModel => this.model;
  onNotice(fn: (n: Notice) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }
  private notice(kind: Notice['kind'], message: string) {
    for (const fn of this.noticeListeners) fn({ kind, message });
  }

  private update(patch: Partial<BoardViewModel>) {
    this.model = {
      ...this.model,
      ...patch,
      state: this.auth ? applyPending(this.auth, this.pending.map((p) => p.op)) : null,
      cursors: [...this.cursors.values()],
      selfSocketId: this.socket.id ?? null,
    };
    for (const fn of this.listeners) fn();
  }

  dispose(): void {
    clearTimeout(this.gapTimer);
    clearTimeout(this.cursorTimer);
    clearInterval(this.pruneTimer);
    if (this.joined) this.socket.emit('board:leave', { boardId: this.boardId });
    this.socket.off();
    this.socket.disconnect();
    this.listeners.clear();
  }

  /* ---------------- join, replay, catch-up ---------------- */

  private async join(): Promise<void> {
    this.joined = false;
    const lastSeq = this.auth ? this.buffer.seq : undefined;
    let ack: JoinAck;
    try {
      ack = (await this.emitAck('board:join', { boardId: this.boardId, ...(lastSeq !== undefined && { lastSeq }) })) as JoinAck;
    } catch {
      this.update({ status: 'reconnecting' });
      return;
    }
    if (!ack.ok) {
      this.notice('error', ack.message);
      return;
    }
    if (ack.mode === 'snapshot') {
      this.auth = stateFromSnapshot(ack.snapshot);
      this.buffer.reset(ack.snapshot.seq);
    } else {
      this.ingest(ack.events);
    }
    this.joined = true;
    this.cursors.clear();
    this.update({ status: 'live', instance: ack.instance, presence: ack.presence });
  }

  /** Feed sequenced events through the reorder buffer, apply what is ready, resync if a hole persists. */
  private ingest(events: readonly BoardEvent[]): void {
    if (!this.auth) return; // events that raced ahead of the first snapshot are covered by it
    const result = this.buffer.offerMany(events);
    if (result.events.length) {
      this.auth = applyEvents(this.auth, result.events);
      this.prune();
    }
    clearTimeout(this.gapTimer);
    if (result.gap) {
      // Out-of-order delivery usually heals itself within a few ms; if not, ask the server for the gap.
      this.gapTimer = setTimeout(() => void this.join(), GAP_RESYNC_MS);
    }
    this.update({});
  }

  private onDisconnect(): void {
    this.joined = false;
    // In-flight commands have an unknown outcome; drop the optimistic layer and let catch-up show the truth.
    this.pending = [];
    this.chains.clear();
    this.update({ status: 'reconnecting' });
  }

  /* ---------------- commands ---------------- */

  private view(): BoardState {
    return this.model.state ?? this.auth!;
  }

  private emitAck(event: string, payload: unknown): Promise<Ack<Record<string, unknown>>> {
    return new Promise((resolve, reject) => {
      (this.socket as unknown as { timeout(ms: number): { emit: (...a: unknown[]) => void } })
        .timeout(ACK_TIMEOUT_MS)
        .emit(event, payload, (err: Error | null, ack: Ack<Record<string, unknown>>) => (err ? reject(err) : resolve(ack)));
    });
  }

  /**
   * Optimistically apply `op`, then send. Commands that touch the same entity are chained so each one
   * is based on the version the previous one produced (otherwise a user editing then moving a card
   * quickly would conflict with themselves).
   */
  private submit(op: PendingOp, chainKey: string, send: () => Promise<Ack<Record<string, unknown>>>, cardId?: string): void {
    if (!this.joined || !this.auth) {
      this.notice('info', 'You are offline. Changes resume when the connection returns.');
      return;
    }
    const entry: PendingEntry = { id: this.nextId++, op };
    this.pending.push(entry);
    this.update({});
    const run = async () => {
      try {
        this.settle(entry, await send(), cardId);
      } catch {
        this.drop(entry);
        this.notice('error', 'The server did not respond. Your change was undone.');
      }
    };
    this.chains.set(chainKey, (this.chains.get(chainKey) ?? Promise.resolve()).then(run));
  }

  private settle(entry: PendingEntry, ack: Ack<Record<string, unknown>>, cardId?: string): void {
    if (ack.ok) {
      entry.ackSeq = ack.seq ?? 0;
      const version = ack.version;
      if (cardId && typeof version === 'number') this.known.set(cardId, version);
      this.prune();
      this.update({});
      return;
    }
    // Rejected: rolling back is just removing the optimistic op.
    this.drop(entry);
    this.notice('error', ack.code === 'VERSION_CONFLICT' ? 'Someone else changed that card first. Showing their version.' : ack.message);
    if (ack.code === 'VERSION_CONFLICT' || ack.code === 'NOT_FOUND') void this.join();
  }

  private drop(entry: PendingEntry): void {
    this.pending = this.pending.filter((p) => p !== entry);
    this.update({});
  }

  /** Forget acked ops once the authoritative log has caught up with them. */
  private prune(): void {
    if (!this.auth) return;
    const seq = this.auth.seq;
    this.pending = this.pending.filter((p) => p.ackSeq === undefined || p.ackSeq > seq);
  }

  private baseVersion(cardId: string): number {
    return Math.max(this.known.get(cardId) ?? 0, this.auth?.cards[cardId]?.version ?? 0);
  }

  createCard(columnId: string, title: string): void {
    const state = this.view();
    const card = {
      id: uuid(),
      boardId: this.boardId,
      columnId,
      title: title.trim(),
      description: '',
      position: keyForAppend(selectCards(state, columnId)),
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    if (!card.title) return;
    this.submit(
      { kind: 'card.create', card },
      card.id,
      () => this.emitAck('card:create', { id: card.id, boardId: this.boardId, columnId, title: card.title, position: card.position }),
      card.id,
    );
  }

  updateCard(id: string, patch: { title?: string; description?: string }): void {
    if (patch.title !== undefined && !patch.title.trim()) return;
    this.submit(
      { kind: 'card.update', id, ...patch },
      id,
      () => this.emitAck('card:update', { id, boardId: this.boardId, baseVersion: this.baseVersion(id), ...patch }),
      id,
    );
  }

  /** Move to `index` within `columnId` (index counts the column's cards without the moved one). */
  moveCard(id: string, columnId: string, index: number): void {
    const state = this.view();
    const siblings = selectCards(state, columnId).filter((c) => c.id !== id);
    const position = keyForIndex(siblings, index);
    this.submit(
      { kind: 'card.move', id, columnId, position },
      id,
      () => this.emitAck('card:move', { id, boardId: this.boardId, baseVersion: this.baseVersion(id), columnId, position }),
      id,
    );
  }

  deleteCard(id: string): void {
    this.submit(
      { kind: 'card.delete', id },
      id,
      () => this.emitAck('card:delete', { id, boardId: this.boardId, baseVersion: this.baseVersion(id) }),
      id,
    );
  }

  createColumn(name: string): void {
    const state = this.view();
    const column = {
      id: uuid(),
      boardId: this.boardId,
      name: name.trim(),
      position: keyForAppend(selectColumns(state)),
    };
    if (!column.name) return;
    this.submit(
      { kind: 'column.create', column },
      'board',
      () => this.emitAck('column:create', { id: column.id, boardId: this.boardId, name: column.name, position: column.position }),
    );
  }

  renameColumn(id: string, name: string): void {
    if (!name.trim()) return;
    this.submit({ kind: 'column.rename', id, name: name.trim() }, 'board', () =>
      this.emitAck('column:rename', { id, boardId: this.boardId, name: name.trim() }),
    );
  }

  deleteColumn(id: string): void {
    this.submit({ kind: 'column.delete', id }, 'board', () => this.emitAck('column:delete', { id, boardId: this.boardId }));
  }

  addComment(cardId: string, body: string): void {
    if (!body.trim()) return;
    const comment = {
      id: uuid(),
      boardId: this.boardId,
      cardId,
      authorId: this.user.id,
      authorName: this.user.name,
      body: body.trim(),
      createdAt: new Date().toISOString(),
    };
    this.submit({ kind: 'comment.add', comment }, 'board', () =>
      this.emitAck('comment:add', { id: comment.id, boardId: this.boardId, cardId, body: comment.body }),
    );
  }

  /* ---------------- presence ---------------- */

  setEditing(cardId: string | null): void {
    if (!this.joined) return;
    this.socket.emit('presence:editing', { boardId: this.boardId, cardId });
  }

  /** Throttled: at most one cursor packet per CURSOR_SEND_INTERVAL_MS, always ending on the latest position. */
  sendCursor(x: number, y: number): void {
    if (!this.joined) return;
    this.queuedCursor = { x: clamp01(x), y: clamp01(y) };
    const wait = this.lastCursorSent + CURSOR_SEND_INTERVAL_MS - Date.now();
    if (wait <= 0) return this.flushCursor();
    this.cursorTimer ??= setTimeout(() => this.flushCursor(), wait);
  }

  private flushCursor(): void {
    this.cursorTimer = undefined;
    if (!this.queuedCursor || !this.joined) return;
    this.lastCursorSent = Date.now();
    this.socket.emit('presence:cursor', { boardId: this.boardId, ...this.queuedCursor });
    this.queuedCursor = null;
  }

  private pruneCursors(): void {
    const cutoff = Date.now() - CURSOR_IDLE_MS;
    let changed = false;
    for (const [id, c] of this.cursors) {
      if (c.at < cutoff) {
        this.cursors.delete(id);
        changed = true;
      }
    }
    if (changed) this.update({});
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
