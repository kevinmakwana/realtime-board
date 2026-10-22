import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import {
  clientEventSchemas,
  type AccessChange,
  type Ack,
  type BoardEvent,
  type ClientEventName,
  type ClientEventPayload,
  type ClientToServerEvents,
  type InterServerEvents,
  type JoinAck,
  type PresenceMember,
  type PublicUser,
  type ServerToClientEvents,
} from '@board/shared';
import type { BoardService, CommitResult } from './boardService.js';
import type { Config } from './config.js';
import { ServiceError } from './errors.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import type { Presence } from './presence.js';
import { TokenBucket } from './rateLimit.js';

export interface SocketData {
  user: PublicUser;
  boards: Set<string>;
}
export type BoardServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type BoardSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export const roomOf = (boardId: string) => `board:${boardId}`;

interface Deps {
  io: BoardServer;
  service: BoardService;
  presence: Presence;
  config: Config;
  metrics: Metrics;
  log: Logger;
}

/**
 * Wires every Socket.IO event. Conventions:
 *  - every payload is validated with the shared zod schema before it touches the service
 *  - every command is acknowledged with `{ ok: true, seq }` or `{ ok: false, code, message }`
 *  - mutations are broadcast to the board room only AFTER the transaction commits; the
 *    Redis adapter fans the broadcast out to sockets on every other instance
 */
export function attachGateway(deps: Deps): { stop: () => void; applyAccessChange: (change: AccessChange) => void } {
  const { io, service, presence, config, metrics, log } = deps;
  const instance = config.INSTANCE_ID;

  const lastBroadcast = new Map<string, string>();

  async function broadcastPresence(boardId: string): Promise<PresenceMember[]> {
    const members = await presence.list(boardId);
    lastBroadcast.set(boardId, JSON.stringify(members));
    io.to(roomOf(boardId)).emit('presence:update', { boardId, members });
    return members;
  }

  // Coalesces roster broadcasts caused by "is editing" changes: the first goes out at once (leading edge), changes
  // inside the window set a flag, and one more broadcast closes the window, so the last state always arrives.
  const editingWindows = new Map<string, { dirty: boolean; timer: NodeJS.Timeout }>();
  const logBroadcastFailure = (err: unknown) =>
    log('presence broadcast failed', { level: 'error', error: String(err) });

  function broadcastEditingChange(boardId: string): void {
    const windowMs = config.PRESENCE_BROADCAST_MIN_MS;
    if (windowMs === 0) {
      broadcastPresence(boardId).catch(logBroadcastFailure);
      return;
    }
    const open = editingWindows.get(boardId);
    if (open) {
      open.dirty = true;
      return;
    }
    const entry = { dirty: false, timer: undefined as unknown as NodeJS.Timeout };
    const close = () => {
      if (!entry.dirty) {
        editingWindows.delete(boardId);
        return;
      }
      entry.dirty = false;
      broadcastPresence(boardId).catch(logBroadcastFailure);
      entry.timer = setTimeout(close, windowMs);
      entry.timer.unref();
    };
    entry.timer = setTimeout(close, windowMs);
    entry.timer.unref();
    editingWindows.set(boardId, entry);
    broadcastPresence(boardId).catch(logBroadcastFailure);
  }

  async function leaveBoard(socket: BoardSocket, boardId: string): Promise<void> {
    if (!socket.data.boards.delete(boardId)) return;
    await socket.leave(roomOf(boardId));
    await presence.leave(boardId, socket.id);
    await broadcastPresence(boardId);
  }

  /** Applies a role change to this instance's sockets: removed users leave the room, everyone is told. */
  async function applyAccessLocal({ boardId, userId, role }: AccessChange): Promise<void> {
    for (const s of io.sockets.sockets.values()) {
      const socket = s as BoardSocket;
      if (socket.data.user?.id !== userId || !socket.data.boards?.has(boardId)) continue;
      if (role === null) await leaveBoard(socket, boardId);
      socket.emit('board:access', { boardId, role });
    }
  }
  const applyLocally = (change: AccessChange) =>
    void applyAccessLocal(change).catch((err) => log('access change failed', { level: 'error', error: String(err) }));

  // Other instances announce the changes made through their REST routes.
  io.on('access:changed', applyLocally);
  const applyAccessChange = (change: AccessChange) => {
    applyLocally(change);
    io.serverSideEmit('access:changed', change);
  };

  io.on('connection', (socket: BoardSocket) => {
    socket.data.boards = new Set();
    const bucket = new TokenBucket(config.RATE_LIMIT_BURST, config.RATE_LIMIT_PER_SEC);
    const cursorBucket = new TokenBucket(config.CURSOR_RATE_PER_SEC, config.CURSOR_RATE_PER_SEC);
    const user = socket.data.user;
    // The socket.io type for `on` is per-event; the dispatcher below is generic over event names.
    const on = socket.on.bind(socket) as unknown as (ev: string, fn: (...args: unknown[]) => void) => void;

    /** Registers a validated, rate-limited, acknowledged command handler. */
    function command<E extends ClientEventName>(
      name: E,
      handler: (payload: ClientEventPayload<E>) => Promise<Record<string, unknown>>,
      opts: { requireJoined?: boolean } = { requireJoined: true },
    ): void {
      on(name, async (raw, ackFn) => {
        const started = process.hrtime.bigint();
        const send = (typeof ackFn === 'function' ? ackFn : () => {}) as (a: Ack<Record<string, unknown>>) => void;
        /** Acknowledges the command and records how it went (ok, or the error code) and how long it took. */
        const ack = (a: Ack<Record<string, unknown>>) => {
          metrics.observeCommand(name, a.ok ? 'ok' : a.code, Number(process.hrtime.bigint() - started) / 1e9);
          send(a);
        };
        if (!bucket.take()) {
          return ack({ ok: false, code: 'RATE_LIMITED', message: 'Too many requests, slow down' });
        }
        const parsed = clientEventSchemas[name].safeParse(raw);
        if (!parsed.success) {
          return ack({ ok: false, code: 'VALIDATION', message: z.prettifyError(parsed.error) });
        }
        const payload = parsed.data as ClientEventPayload<E>;
        const boardId = (payload as { boardId: string }).boardId;
        if (opts.requireJoined && !socket.data.boards.has(boardId)) {
          return ack({ ok: false, code: 'NOT_JOINED', message: 'Join the board first' });
        }
        try {
          ack({ ok: true, ...(await handler(payload)) });
        } catch (err) {
          if (err instanceof ServiceError) {
            ack({ ok: false, code: err.code, message: err.message, ...(err.current && { current: err.current }) });
          } else {
            log('command failed', {
              level: 'error',
              command: name,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
            });
            ack({ ok: false, code: 'INTERNAL', message: 'Something went wrong' });
          }
        }
      });
    }

    /** Publishes a committed event to the board room (all instances) and shapes the ack. */
    const publish = (r: CommitResult): Record<string, unknown> => {
      if (r.event) io.to(roomOf(r.event.boardId)).emit('board:event', r.event satisfies BoardEvent);
      return { seq: r.seq, ...(r.version !== undefined && { version: r.version }) };
    };

    command(
      'board:join',
      async ({ boardId, lastSeq }) => {
        // Cheap early refusal; re-checked below once this socket can receive access changes.
        if (!(await service.role(boardId, user.id))) throw new ServiceError('NOT_FOUND', 'Board not found');
        const head = await service.latestSeq(boardId);
        if (head === null) throw new ServiceError('NOT_FOUND', 'Board not found');

        // A second join from a socket that is already on the board is a resync (reconnect catch-up and
        // the client's periodic check): it must not reset presence or re-announce the roster.
        const alreadyOnBoard = socket.data.boards.has(boardId);

        // Join the room BEFORE reading state: anything committed meanwhile is also broadcast to us,
        // and the client de-duplicates by seq, so we can neither miss nor double-apply an event.
        await socket.join(roomOf(boardId));
        socket.data.boards.add(boardId);
        // Keep our existing roster entry (and its "is editing" state) unless it has vanished.
        let members = alreadyOnBoard ? await presence.list(boardId) : [];
        const needsAnnouncing = !alreadyOnBoard || !members.some((m) => m.socketId === socket.id);
        if (needsAnnouncing) {
          const member: PresenceMember = {
            socketId: socket.id,
            user,
            instance,
            editingCardId: null,
            joinedAt: Date.now(),
          };
          await presence.join(boardId, member);
        }

        /** The board can be deleted while we are joining: refuse, and take the socket back off the roster. */
        const readSnapshot = async () => {
          const snapshot = await service.getSnapshot(boardId);
          if (snapshot) return snapshot;
          await leaveBoard(socket, boardId);
          throw new ServiceError('NOT_FOUND', 'Board not found');
        };

        let result: Pick<JoinAck & { ok: true }, 'mode'> & Record<string, unknown>;
        const behind = lastSeq !== undefined ? head - lastSeq : null;
        if (lastSeq !== undefined && behind !== null && behind >= 0 && behind <= config.REPLAY_MAX_EVENTS) {
          const events = await service.eventsSince(boardId, lastSeq, config.REPLAY_MAX_EVENTS);
          // Replay only if the log is contiguous; otherwise fall back to a full snapshot. A matching count is not
          // enough: events pruned from the start and others appended since `head` was read can cancel out.
          if (events.length === behind && (behind === 0 || events[0]?.seq === lastSeq + 1)) {
            result = { mode: 'replay', events, seq: events.at(-1)?.seq ?? lastSeq };
          } else {
            result = { mode: 'snapshot', snapshot: await readSnapshot() };
          }
        } else {
          result = { mode: 'snapshot', snapshot: await readSnapshot() };
        }

        // Everything above can race with a removal or a board delete. applyAccessLocal skips sockets that
        // are not on the board yet, but this one is registered now, so any change after this check reaches
        // it as a board:access event. Read the role once more to catch what happened before, and put it
        // (not a stale one) in the ack.
        const role = await service.role(boardId, user.id);
        if (!role) {
          await leaveBoard(socket, boardId);
          throw new ServiceError('NOT_FOUND', 'Board not found');
        }

        if (needsAnnouncing) members = await broadcastPresence(boardId);
        return { ...result, instance, presence: members, role };
      },
      { requireJoined: false },
    );

    command(
      'board:leave',
      async ({ boardId }) => {
        await leaveBoard(socket, boardId);
        return {};
      },
      { requireJoined: false },
    );

    command('board:rename', async (p) => publish(await service.renameBoard(user.id, p)));
    command('column:create', async (p) => publish(await service.createColumn(user.id, p)));
    command('column:rename', async (p) => publish(await service.renameColumn(user.id, p)));
    command('column:move', async (p) => publish(await service.moveColumn(user.id, p)));
    command('column:delete', async (p) => publish(await service.deleteColumn(user.id, p)));
    command('card:create', async (p) => publish(await service.createCard(user.id, p)));
    command('card:update', async (p) => publish(await service.updateCard(user.id, p)));
    command('card:move', async (p) => publish(await service.moveCard(user.id, p)));
    command('card:delete', async (p) => publish(await service.deleteCard(user.id, p)));
    command('comment:add', async (p) => publish(await service.addComment(user.id, p)));
    command('comment:edit', async (p) => publish(await service.editComment(user.id, p)));
    command('comment:delete', async (p) => publish(await service.deleteComment(user.id, p)));

    command('presence:editing', async ({ boardId, cardId }) => {
      await presence.setEditing(boardId, socket.id, cardId);
      broadcastEditingChange(boardId);
      return {};
    });

    // Cursors are fire-and-forget: no ack, volatile (dropped under backpressure), dropped when rate limited.
    on('presence:cursor', (raw) => {
      if (!cursorBucket.take()) return;
      const parsed = clientEventSchemas['presence:cursor'].safeParse(raw);
      if (!parsed.success || !socket.data.boards.has(parsed.data.boardId)) return;
      const { boardId, x, y } = parsed.data;
      socket.to(roomOf(boardId)).volatile.emit('presence:cursor', {
        socketId: socket.id,
        userId: user.id,
        boardId,
        x,
        y,
      });
    });

    socket.on('disconnect', async () => {
      await Promise.all([...socket.data.boards].map((b) => leaveBoard(socket, b))).catch(() => {});
    });
  });

  // Heartbeat: keep our sockets' presence keys alive, and re-broadcast rosters that changed because
  // some *other* client/instance died and its keys expired.
  const timer = setInterval(
    async () => {
      try {
        const byBoard = new Map<string, string[]>();
        for (const s of io.sockets.sockets.values()) {
          for (const b of (s as BoardSocket).data.boards ?? []) {
            byBoard.set(b, [...(byBoard.get(b) ?? []), s.id]);
          }
        }
        for (const [boardId, ids] of byBoard) {
          await presence.touch(boardId, ids);
          const members = await presence.list(boardId);
          if (lastBroadcast.get(boardId) !== JSON.stringify(members)) await broadcastPresence(boardId);
        }
      } catch (err) {
        log('presence heartbeat failed', { level: 'error', error: String(err) });
      }
    },
    Math.max(1000, (config.PRESENCE_TTL_SECONDS * 1000) / 3),
  );
  timer.unref();

  const stop = () => {
    clearInterval(timer);
    for (const { timer: t } of editingWindows.values()) clearTimeout(t);
    editingWindows.clear();
  };
  return { stop, applyAccessChange };
}
