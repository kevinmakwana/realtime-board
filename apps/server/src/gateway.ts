import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import {
  clientEventSchemas,
  type Ack,
  type BoardEvent,
  type ClientEventName,
  type ClientEventPayload,
  type ClientToServerEvents,
  type JoinAck,
  type PresenceMember,
  type PublicUser,
  type ServerToClientEvents,
} from '@board/shared';
import type { BoardService, CommitResult } from './boardService.js';
import type { Config } from './config.js';
import { ServiceError } from './errors.js';
import type { Logger } from './logger.js';
import type { Presence } from './presence.js';
import { TokenBucket } from './rateLimit.js';

export interface SocketData {
  user: PublicUser;
  boards: Set<string>;
}
export type BoardServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type BoardSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export const roomOf = (boardId: string) => `board:${boardId}`;

interface Deps {
  io: BoardServer;
  service: BoardService;
  presence: Presence;
  config: Config;
  log: Logger;
}

/**
 * Wires every Socket.IO event. Conventions:
 *  - every payload is validated with the shared zod schema before it touches the service
 *  - every command is acknowledged with `{ ok: true, seq }` or `{ ok: false, code, message }`
 *  - mutations are broadcast to the board room only AFTER the transaction commits; the
 *    Redis adapter fans the broadcast out to sockets on every other instance
 */
export function attachGateway(deps: Deps): { stop: () => void } {
  const { io, service, presence, config, log } = deps;
  const instance = config.INSTANCE_ID;

  const lastBroadcast = new Map<string, string>();

  async function broadcastPresence(boardId: string): Promise<PresenceMember[]> {
    const members = await presence.list(boardId);
    lastBroadcast.set(boardId, JSON.stringify(members));
    io.to(roomOf(boardId)).emit('presence:update', { boardId, members });
    return members;
  }

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
        const ack = (typeof ackFn === 'function' ? ackFn : () => {}) as (a: Ack<Record<string, unknown>>) => void;
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
            log(`[${instance}] ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
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
        const head = await service.latestSeq(boardId);
        if (head === null) throw new ServiceError('NOT_FOUND', 'Board not found');

        // Join the room BEFORE reading state: anything committed meanwhile is also broadcast to us,
        // and the client de-duplicates by seq, so we can neither miss nor double-apply an event.
        await socket.join(roomOf(boardId));
        socket.data.boards.add(boardId);
        const member: PresenceMember = {
          socketId: socket.id,
          user,
          instance,
          editingCardId: null,
          joinedAt: Date.now(),
        };
        await presence.join(boardId, member);

        let result: Pick<JoinAck & { ok: true }, 'mode'> & Record<string, unknown>;
        const behind = lastSeq !== undefined ? head - lastSeq : null;
        if (lastSeq !== undefined && behind !== null && behind >= 0 && behind <= config.REPLAY_MAX_EVENTS) {
          const events = await service.eventsSince(boardId, lastSeq, config.REPLAY_MAX_EVENTS);
          // Replay only if the log is contiguous; otherwise fall back to a full snapshot.
          if (events.length === behind) {
            result = { mode: 'replay', events, seq: events.at(-1)?.seq ?? lastSeq };
          } else {
            result = { mode: 'snapshot', snapshot: (await service.getSnapshot(boardId))! };
          }
        } else {
          result = { mode: 'snapshot', snapshot: (await service.getSnapshot(boardId))! };
        }

        const members = await broadcastPresence(boardId);
        return { ...result, instance, presence: members };
      },
      { requireJoined: false },
    );

    command(
      'board:leave',
      async ({ boardId }) => {
        await leave(boardId);
        return {};
      },
      { requireJoined: false },
    );

    async function leave(boardId: string): Promise<void> {
      if (!socket.data.boards.delete(boardId)) return;
      await socket.leave(roomOf(boardId));
      await presence.leave(boardId, socket.id);
      await broadcastPresence(boardId);
    }

    command('column:create', async (p) => publish(await service.createColumn(user.id, p)));
    command('column:rename', async (p) => publish(await service.renameColumn(user.id, p)));
    command('column:delete', async (p) => publish(await service.deleteColumn(user.id, p)));
    command('card:create', async (p) => publish(await service.createCard(user.id, p)));
    command('card:update', async (p) => publish(await service.updateCard(user.id, p)));
    command('card:move', async (p) => publish(await service.moveCard(user.id, p)));
    command('card:delete', async (p) => publish(await service.deleteCard(user.id, p)));
    command('comment:add', async (p) => publish(await service.addComment(user.id, p)));

    command('presence:editing', async ({ boardId, cardId }) => {
      await presence.setEditing(boardId, socket.id, cardId);
      await broadcastPresence(boardId);
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
      await Promise.all([...socket.data.boards].map((b) => leave(b))).catch(() => {});
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
        log(`[${instance}] presence heartbeat failed: ${String(err)}`);
      }
    },
    Math.max(1000, (config.PRESENCE_TTL_SECONDS * 1000) / 3),
  );
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
