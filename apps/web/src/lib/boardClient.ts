import type { Socket } from 'socket.io-client';
import {
  SeqBuffer,
  applyEvents,
  applyPending,
  keyForAppend,
  keyForIndex,
  selectCards,
  selectColumns,
  mergeOlderComments,
  stateFromSnapshot,
  type Ack,
  type BoardEvent,
  type BoardState,
  type ClientToServerEvents,
  type Comment,
  type JoinAck,
  type PendingOp,
  type PresenceMember,
  type PublicUser,
  type Role,
  type ServerToClientEvents,
} from '@board/shared';
import { uuid } from './uuid';

export type BoardSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'unauthorized' | 'removed';

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
  /** Your role on this board; null until the first join and after you are removed. */
  role: Role | null;
  /** Changes made while disconnected that are waiting to be sent. */
  queued: number;
}

export interface Notice {
  kind: 'error' | 'info';
  message: string;
}

/** A command made while disconnected: what to send later, and what it is about. */
interface Queued {
  send: () => Promise<Ack<Record<string, unknown>>>;
  cardId?: string;
}

interface PendingEntry {
  id: number;
  op: PendingOp;
  /** Set once the server acked; the entry is dropped when the event log reaches this seq. */
  ackSeq?: number;
  /** Set while the command waits for a connection; cleared the moment it is sent. */
  queued?: Queued;
}

type Listener = () => void;

const ACK_TIMEOUT_MS = 8000;
const GAP_RESYNC_MS = 400;
const CURSOR_SEND_INTERVAL_MS = 50;
const CURSOR_IDLE_MS = 8000;
/** How often a live client asks the server for anything it missed (plus up to HEAL_JITTER_MS so clients spread out). */
const HEAL_INTERVAL_MS = 30_000;
const HEAL_JITTER_MS = 5_000;
/** How many changes may wait for a connection. Past this, further changes are refused rather than silently piling up. */
const MAX_QUEUED = 100;

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
  private healTimer: ReturnType<typeof setTimeout> | undefined;
  /** Card versions that queued changes are based on: what we knew when going offline, then what our own sends produced. */
  private queueBase = new Map<string, number>();
  private flushing = false;
  private unloadGuard = false;

  private listeners = new Set<Listener>();
  private noticeListeners = new Set<(n: Notice) => void>();
  private model: BoardViewModel = {
    status: 'connecting',
    instance: null,
    state: null,
    presence: [],
    cursors: [],
    selfSocketId: null,
    role: null,
    queued: 0,
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
    socket.on('board:access', (p) => {
      if (p.boardId !== this.boardId) return;
      if (p.role === null) {
        this.pending = [];
        this.chains.clear();
        this.queueBase.clear();
        this.update({ status: 'removed', role: null });
        return;
      }
      this.update({ role: p.role });
    });
    this.pruneTimer = setInterval(() => this.pruneCursors(), 2000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibilityChange);
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
      state: this.auth
        ? applyPending(
            this.auth,
            this.pending.map((p) => p.op),
          )
        : null,
      cursors: [...this.cursors.values()],
      selfSocketId: this.socket.id ?? null,
      queued: this.pending.reduce((n, p) => n + (p.queued ? 1 : 0), 0),
    };
    this.guardUnload(this.model.queued > 0);
    for (const fn of this.listeners) fn();
  }

  /** While changes exist only in this tab, closing it would lose them: ask the browser to confirm. */
  private guardUnload(on: boolean): void {
    if (on === this.unloadGuard || typeof window === 'undefined') return;
    this.unloadGuard = on;
    if (on) window.addEventListener('beforeunload', this.confirmUnload);
    else window.removeEventListener('beforeunload', this.confirmUnload);
  }
  private confirmUnload = (e: BeforeUnloadEvent): void => {
    e.preventDefault();
  };

  /** Adds a page of a card's older comments that was fetched over REST (see `mergeOlderComments`). */
  addOlderComments(cardId: string, page: Comment[], nextCursor: string | null, requestCursor: string): void {
    if (!this.auth) return;
    this.auth = mergeOlderComments(this.auth, cardId, page, nextCursor, requestCursor);
    this.update({});
  }

  dispose(): void {
    clearTimeout(this.gapTimer);
    clearTimeout(this.cursorTimer);
    clearInterval(this.pruneTimer);
    clearTimeout(this.healTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.guardUnload(false);
    if (this.joined) this.socket.emit('board:leave', { boardId: this.boardId });
    this.socket.off();
    this.socket.disconnect();
    this.listeners.clear();
  }

  /* ---------------- join, replay, catch-up ---------------- */

  /**
   * Join the board, or re-join to catch up. A `quiet` join is the periodic check: the board stays
   * usable while it is in flight and a failed attempt is simply tried again later, because a real
   * outage is reported by the socket's own disconnect.
   */
  private async join(quiet = false): Promise<void> {
    if (!quiet) this.joined = false;
    const lastSeq = this.auth ? this.buffer.seq : undefined;
    let ack: JoinAck;
    try {
      ack = (await this.emitAck('board:join', {
        boardId: this.boardId,
        ...(lastSeq !== undefined && { lastSeq }),
      })) as JoinAck;
    } catch {
      if (quiet) this.scheduleHeal();
      else this.update({ status: 'reconnecting' });
      return;
    }
    if (!ack.ok) {
      // A board we cannot join is one we were removed from (or that never existed): say so, do not retry.
      if (ack.code === 'NOT_FOUND') {
        this.pending = [];
        this.queueBase.clear();
        this.update({ status: 'removed', role: null });
      } else {
        this.notice('error', ack.message);
        if (quiet) this.scheduleHeal();
      }
      return;
    }
    // Access can be revoked while a join is in flight; an answer that arrives afterwards must not undo it.
    if (this.model.status === 'removed') return;
    if (ack.mode === 'snapshot') {
      this.auth = stateFromSnapshot(ack.snapshot);
      this.buffer.reset(ack.snapshot.seq);
    } else {
      this.ingest(ack.events);
    }
    this.joined = true;
    if (!quiet) this.cursors.clear();
    this.update({ status: 'live', instance: ack.instance, presence: ack.presence, role: ack.role });
    this.scheduleHeal();
    void this.flushQueue();
  }

  /**
   * Broadcasts are at-most-once, and a hole is normally noticed only when a later event arrives. On a
   * quiet board that could be never, so ask the server where the log is: it answers with an empty
   * replay when we are current, or the events we missed.
   */
  private scheduleHeal(): void {
    clearTimeout(this.healTimer);
    this.healTimer = setTimeout(() => this.heal(), HEAL_INTERVAL_MS + Math.random() * HEAL_JITTER_MS);
  }

  private heal(): void {
    // A disconnected client re-joins from its 'connect' handler instead.
    if (this.joined) void this.join(true);
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') this.heal();
  };

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
    clearTimeout(this.healTimer);
    // In-flight commands have an unknown outcome; drop their optimistic layer and let catch-up show the truth.
    // Changes still waiting to be sent were never tried, so they stay.
    this.pending = this.pending.filter((p) => p.queued);
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
        .emit(event, payload, (err: Error | null, ack: Ack<Record<string, unknown>>) =>
          err ? reject(err) : resolve(ack),
        );
    });
  }

  /**
   * Optimistically apply `op`, then send. Commands that touch the same entity are chained so each one
   * is based on the version the previous one produced (otherwise a user editing then moving a card
   * quickly would conflict with themselves).
   *
   * While disconnected the command is queued instead: it shows at once, and is sent in order when the
   * connection is back (see `flushQueue`). The queue lives in this tab only.
   */
  private submit(
    op: PendingOp,
    chainKey: string,
    send: () => Promise<Ack<Record<string, unknown>>>,
    cardId?: string,
  ): boolean {
    if (!this.auth || this.model.status === 'removed' || this.model.status === 'unauthorized') {
      this.notice('error', 'You are offline, so that change was not saved. Try again once you are reconnected.');
      return false;
    }
    if (this.model.role === 'viewer') {
      this.notice('error', 'You have view-only access to this board.');
      return false;
    }
    const entry: PendingEntry = { id: this.nextId++, op };
    if (!this.joined || this.flushing) {
      const waiting = this.pending.filter((p) => p.queued).length;
      if (waiting >= MAX_QUEUED) {
        this.notice('error', 'Too many changes are waiting for a connection, so that one was not saved.');
        return false;
      }
      if (cardId && !this.queueBase.has(cardId)) this.queueBase.set(cardId, this.rawBaseVersion(cardId));
      entry.queued = { send, cardId };
      this.pending.push(entry);
      this.update({});
      if (waiting === 0 && !this.flushing) {
        this.notice('info', 'You are offline. Your changes are kept here and will be sent when you reconnect.');
      }
      return true;
    }
    this.pending.push(entry);
    this.update({});
    this.chains.set(
      chainKey,
      (this.chains.get(chainKey) ?? Promise.resolve()).then(async () => {
        await this.execute(entry, send, cardId, false);
      }),
    );
    return true;
  }

  /** Send one command and settle its optimistic entry. Returns true if the server accepted it. */
  private async execute(
    entry: PendingEntry,
    send: () => Promise<Ack<Record<string, unknown>>>,
    cardId: string | undefined,
    batch: boolean,
  ): Promise<boolean> {
    try {
      return this.settle(entry, await send(), cardId, batch);
    } catch {
      this.drop(entry);
      if (!batch) this.notice('error', 'The server did not respond. Your change was undone.');
      return false;
    }
  }

  /**
   * Send what was queued while disconnected, one command at a time and in the order it was made (a comment on a
   * card made offline must not overtake the card). Each command carries the card version it was made against, so
   * if someone else changed that card meanwhile the server refuses it and it is reported, never applied over theirs.
   */
  private async flushQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    let sent = 0;
    let failed = 0;
    try {
      while (this.joined) {
        const entry = this.pending.find((p) => p.queued);
        const queued = entry?.queued;
        if (!entry || !queued) break;
        entry.queued = undefined;
        this.update({});
        sent++;
        if (!(await this.execute(entry, queued.send, queued.cardId, true))) failed++;
      }
    } finally {
      this.flushing = false;
    }
    if (sent === 0) return;
    if (!this.pending.some((p) => p.queued)) this.queueBase.clear();
    if (failed === 0) {
      this.notice('info', sent === 1 ? '1 offline change was saved.' : `${sent} offline changes were saved.`);
    } else {
      this.notice(
        'error',
        `${failed} of ${sent} offline ${sent === 1 ? 'change was' : 'changes were'} not applied because the board changed meanwhile (or you can no longer edit it). Showing the current board.`,
      );
      void this.join();
    }
  }

  private settle(entry: PendingEntry, ack: Ack<Record<string, unknown>>, cardId?: string, batch = false): boolean {
    if (ack.ok) {
      entry.ackSeq = ack.seq ?? 0;
      const version = ack.version;
      if (cardId && typeof version === 'number') {
        this.known.set(cardId, version);
        if (this.queueBase.has(cardId)) this.queueBase.set(cardId, version);
      }
      this.prune();
      this.update({});
      return true;
    }
    // Rejected: rolling back is just removing the optimistic op.
    this.drop(entry);
    if (batch) return false; // the flush reports all refusals at once, and resyncs once
    this.notice(
      'error',
      ack.code === 'VERSION_CONFLICT' ? 'Someone else changed that card first. Showing their version.' : ack.message,
    );
    if (ack.code === 'VERSION_CONFLICT' || ack.code === 'NOT_FOUND') void this.join();
    return false;
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

  /** The newest card version we know of. A change made offline uses the version it was made against instead. */
  private rawBaseVersion(cardId: string): number {
    return Math.max(this.known.get(cardId) ?? 0, this.auth?.cards[cardId]?.version ?? 0);
  }

  private baseVersion(cardId: string): number {
    return this.queueBase.get(cardId) ?? this.rawBaseVersion(cardId);
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
      dueDate: null,
      assigneeIds: [],
      labels: [],
    };
    if (!card.title) return;
    this.submit(
      { kind: 'card.create', card },
      card.id,
      () =>
        this.emitAck('card:create', {
          id: card.id,
          boardId: this.boardId,
          columnId,
          title: card.title,
          position: card.position,
        }),
      card.id,
    );
  }

  updateCard(
    id: string,
    patch: {
      title?: string;
      description?: string;
      dueDate?: string | null;
      assigneeIds?: string[];
      labels?: string[];
    },
  ): void {
    if (patch.title !== undefined && !patch.title.trim()) return;
    this.submit(
      { kind: 'card.update', id, ...patch },
      id,
      () => this.emitAck('card:update', { id, boardId: this.boardId, baseVersion: this.baseVersion(id), ...patch }),
      id,
    );
  }

  /**
   * Move to `index` within `columnId` (index counts the column's cards without the moved one).
   * Returns false when the move was refused outright (offline, view-only), so callers do not announce it.
   */
  moveCard(id: string, columnId: string, index: number): boolean {
    const state = this.view();
    const siblings = selectCards(state, columnId).filter((c) => c.id !== id);
    const position = keyForIndex(siblings, index);
    return this.submit(
      { kind: 'card.move', id, columnId, position },
      id,
      () =>
        this.emitAck('card:move', { id, boardId: this.boardId, baseVersion: this.baseVersion(id), columnId, position }),
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
    this.submit({ kind: 'column.create', column }, 'board', () =>
      this.emitAck('column:create', {
        id: column.id,
        boardId: this.boardId,
        name: column.name,
        position: column.position,
      }),
    );
  }

  /** Owner only (the server enforces it; this just avoids sending a command that must fail). */
  renameBoard(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || trimmed === this.view().board.name) return;
    if (this.model.role !== 'owner') {
      this.notice('error', 'Only the board owner can rename it.');
      return;
    }
    this.submit({ kind: 'board.rename', name: trimmed }, 'board', () =>
      this.emitAck('board:rename', { boardId: this.boardId, name: trimmed }),
    );
  }

  /** Move to `index` among the other columns (the count does not include the moved one). False if nothing was sent. */
  moveColumn(id: string, index: number): boolean {
    const columns = selectColumns(this.view());
    const from = columns.findIndex((c) => c.id === id);
    if (from === -1) return false;
    const others = columns.filter((c) => c.id !== id);
    if (from === Math.max(0, Math.min(index, others.length))) return false; // dropped where it already is
    const position = keyForIndex(others, index);
    return this.submit({ kind: 'column.move', id, position }, 'board', () =>
      this.emitAck('column:move', { id, boardId: this.boardId, position }),
    );
  }

  renameColumn(id: string, name: string): void {
    if (!name.trim()) return;
    this.submit({ kind: 'column.rename', id, name: name.trim() }, 'board', () =>
      this.emitAck('column:rename', { id, boardId: this.boardId, name: name.trim() }),
    );
  }

  deleteColumn(id: string): void {
    this.submit({ kind: 'column.delete', id }, 'board', () =>
      this.emitAck('column:delete', { id, boardId: this.boardId }),
    );
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
      editedAt: null,
    };
    this.submit({ kind: 'comment.add', comment }, 'board', () =>
      this.emitAck('comment:add', { id: comment.id, boardId: this.boardId, cardId, body: comment.body }),
    );
  }

  /** Author only; the server enforces it, this avoids sending a command that must fail. */
  editComment(id: string, body: string): void {
    const trimmed = body.trim();
    const comment = this.view().comments[id];
    if (!comment || !trimmed || trimmed === comment.body) return;
    if (comment.authorId !== this.user.id) {
      this.notice('error', 'You can only edit your own comments.');
      return;
    }
    this.submit({ kind: 'comment.edit', id, body: trimmed }, 'board', () =>
      this.emitAck('comment:edit', { id, boardId: this.boardId, body: trimmed }),
    );
  }

  /** The author, or the board owner moderating. */
  deleteComment(id: string): void {
    const comment = this.view().comments[id];
    if (!comment) return;
    if (comment.authorId !== this.user.id && this.model.role !== 'owner') {
      this.notice('error', 'You can only delete your own comments.');
      return;
    }
    this.submit({ kind: 'comment.delete', id }, 'board', () =>
      this.emitAck('comment:delete', { id, boardId: this.boardId }),
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
    if (wait <= 0) {
      this.flushCursor();
      return;
    }
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
