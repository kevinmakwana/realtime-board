import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import type { AccessChange, ClientToServerEvents, InterServerEvents, ServerToClientEvents } from '@board/shared';
import { createApp } from './app.js';
import { verifyToken } from './auth.js';
import { BoardService } from './boardService.js';
import type { Config } from './config.js';
import { createPool, migrate } from './db.js';
import { attachGateway, type BoardServer, type SocketData } from './gateway.js';
import { noopLogger, type Logger } from './logger.js';
import { type Mailer, createInviteNotifier, createMailer } from './mailer.js';
import { createMetrics } from './metrics.js';
import { MembershipService } from './membership.js';
import { Presence } from './presence.js';

export interface ServerInstance {
  port: number;
  instanceId: string;
  io: BoardServer;
  close: () => Promise<void>;
}

/**
 * One complete server instance: HTTP API + Socket.IO + Redis adapter. Everything shared between
 * instances (Postgres, Redis) is reached through the config, so tests can run several of these in
 * a single process and the docker `scale` profile runs them as separate containers.
 */
export async function createServerInstance(
  config: Config,
  log: Logger = noopLogger,
  deps: { mailer?: Mailer } = {},
): Promise<ServerInstance> {
  const pool = createPool(config.DATABASE_URL);
  await migrate(pool);

  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const pub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const sub = pub.duplicate();

  const service = new BoardService(pool);
  // The gateway is attached after the app exists, so the callback is bound late.
  let notifyAccess: (change: AccessChange) => void = () => {};
  const metrics = createMetrics(config.INSTANCE_ID);
  const mailer = deps.mailer ?? createMailer(config, log);
  const membership = new MembershipService(
    pool,
    (change) => notifyAccess(change),
    createInviteNotifier(mailer, config.WEB_ORIGIN, log),
  );
  const presence = new Presence(redis, config.PRESENCE_TTL_SECONDS);
  const app = createApp({ config, pool, redis, service, membership, mailer, metrics, log });
  const httpServer = createServer(app);

  const io: BoardServer = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      adapter: createAdapter(pub, sub),
      cors: { origin: config.WEB_ORIGIN },
      // Keep payloads small: this is a command protocol, not a file transport.
      maxHttpBufferSize: 64 * 1024,
    },
  );

  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    const user = verifyToken(token, config.JWT_SECRET);
    if (!user) return next(new Error('UNAUTHORIZED'));
    socket.data.user = user;
    next();
  });

  metrics.trackSockets(() => io.engine.clientsCount);
  const gateway = attachGateway({ io, service, presence, config, metrics, log });
  notifyAccess = gateway.applyAccessChange;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.PORT, resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;
  log('listening', { port });

  return {
    port,
    instanceId: config.INSTANCE_ID,
    io,
    async close() {
      gateway.stop();
      await io.close(); // disconnects every socket and closes the http server
      // Let the per-socket 'disconnect' handlers finish their Redis/Postgres work first.
      await new Promise((r) => setTimeout(r, 50));
      await Promise.allSettled([pub.quit(), sub.quit(), redis.quit()]);
      await pool.end();
    },
  };
}
