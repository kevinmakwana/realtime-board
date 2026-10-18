import { randomUUID } from 'node:crypto';
import { io as connectClient, type Socket } from 'socket.io-client';
import { Redis } from 'ioredis';
import {
  keyBetween,
  type BoardEvent,
  type BoardSnapshot,
  type ClientToServerEvents,
  type JoinAck,
  type ServerToClientEvents,
} from '@board/shared';
import { signToken, upsertUser } from '../src/auth.js';
import { BoardService } from '../src/boardService.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Pool } from '../src/db.js';
import { createServerInstance, type ServerInstance } from '../src/server.js';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const baseConfig = (over: Partial<Config> = {}): Config => loadConfig(process.env, { PORT: 0, ...over });

export const startInstance = (id: string, over: Partial<Config> = {}): Promise<ServerInstance> =>
  createServerInstance(baseConfig({ INSTANCE_ID: id, ...over }));

export async function startPair(
  a: string,
  b: string,
  over: Partial<Config> = {},
): Promise<[ServerInstance, ServerInstance]> {
  return Promise.all([startInstance(a, over), startInstance(b, over)]);
}

export interface TestWorld {
  pool: Pool;
  redis: Redis;
  service: BoardService;
  config: Config;
  sockets: ClientSocket[];
  close: () => Promise<void>;
  newUser: (name?: string) => Promise<{ id: string; name: string; token: string }>;
  newBoard: (ownerId: string, editors?: string[]) => Promise<BoardSnapshot>;
  connect: (port: number, token: string) => Promise<ClientSocket>;
}

export function createWorld(): TestWorld {
  const config = baseConfig();
  const pool = createPool(config.DATABASE_URL, 4);
  const redis = new Redis(config.REDIS_URL);
  const service = new BoardService(pool);
  const sockets: ClientSocket[] = [];
  return {
    pool,
    redis,
    service,
    config,
    sockets,
    async newUser(name = 'Test User') {
      const user = await upsertUser(pool, `${randomUUID()}@example.test`, name);
      return { id: user.id, name: user.name, token: signToken(user, config.JWT_SECRET) };
    },
    async newBoard(ownerId, editors = []) {
      const snap = await service.createBoard(ownerId, `Board ${randomUUID().slice(0, 6)}`);
      for (const userId of editors) {
        await pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'editor')", [
          snap.board.id,
          userId,
        ]);
      }
      return snap;
    },
    async connect(port, token) {
      const socket: ClientSocket = connectClient(`http://localhost:${port}`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      return socket;
    },
    async close() {
      for (const s of sockets) s.disconnect();
      redis.disconnect();
      await pool.end();
    },
  };
}

/** Promisified emit-with-ack. */
export function emit<E extends keyof ClientToServerEvents>(
  socket: ClientSocket,
  event: E,
  payload: Parameters<ClientToServerEvents[E]>[0],
): Promise<any> {
  return new Promise((resolve) => {
    (socket as any).emit(event, payload, resolve);
  });
}

export const join = (socket: ClientSocket, boardId: string, lastSeq?: number): Promise<JoinAck> =>
  emit(socket, 'board:join', { boardId, ...(lastSeq !== undefined && { lastSeq }) });

/** Collects board events delivered to a socket. */
export function collectEvents(socket: ClientSocket): BoardEvent[] {
  const events: BoardEvent[] = [];
  socket.on('board:event', (e) => events.push(e));
  return events;
}

export async function addCard(
  socket: ClientSocket,
  snap: BoardSnapshot,
  title: string,
  position = keyBetween(null, null),
) {
  const id = randomUUID();
  const ack = await emit(socket, 'card:create', {
    id,
    boardId: snap.board.id,
    columnId: snap.columns[0]!.id,
    title,
    position,
  });
  return { id, ack };
}

/** Resolves with the first payload of `event` that satisfies `predicate`, or rejects after `ms`. */
export function waitFor<E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  predicate: (payload: Parameters<ServerToClientEvents[E]>[0]) => boolean = () => true,
  ms = 5000,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${String(event)}`)), ms);
    const handler = (payload: any) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      (socket as any).off(event, handler);
      resolve(payload);
    };
    (socket as any).on(event, handler);
  });
}
