import type { PresenceMember } from '@board/shared';
import type { Redis } from 'ioredis';

/**
 * Presence lives in Redis so every instance sees the same roster.
 *
 *   presence:{board}:{socketId}   JSON member, TTL = ttlSeconds   (the source of truth)
 *   presence:idx:{board}          ZSET of socketIds               (so we can list without SCAN)
 *
 * Instances refresh the TTL of their own sockets on a heartbeat. If a client or a whole instance
 * dies, nothing refreshes its keys, they expire, and `list()` prunes the dangling index entries.
 */
export class Presence {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  private key = (boardId: string, socketId: string) => `presence:${boardId}:${socketId}`;
  private idx = (boardId: string) => `presence:idx:${boardId}`;

  async join(boardId: string, member: PresenceMember): Promise<void> {
    await this.redis
      .multi()
      .set(this.key(boardId, member.socketId), JSON.stringify(member), 'EX', this.ttlSeconds)
      .zadd(this.idx(boardId), member.joinedAt, member.socketId)
      .expire(this.idx(boardId), this.ttlSeconds * 10)
      .exec();
  }

  async setEditing(boardId: string, socketId: string, cardId: string | null): Promise<void> {
    const raw = await this.redis.get(this.key(boardId, socketId));
    if (!raw) return;
    const member = { ...(JSON.parse(raw) as PresenceMember), editingCardId: cardId };
    await this.redis.set(this.key(boardId, socketId), JSON.stringify(member), 'EX', this.ttlSeconds);
  }

  async leave(boardId: string, socketId: string): Promise<void> {
    await this.redis.multi().del(this.key(boardId, socketId)).zrem(this.idx(boardId), socketId).exec();
  }

  /** Heartbeat: keep the given sockets alive. */
  async touch(boardId: string, socketIds: string[]): Promise<void> {
    if (socketIds.length === 0) return;
    const pipe = this.redis.pipeline();
    for (const id of socketIds) pipe.expire(this.key(boardId, id), this.ttlSeconds);
    pipe.expire(this.idx(boardId), this.ttlSeconds * 10);
    await pipe.exec();
  }

  async list(boardId: string): Promise<PresenceMember[]> {
    const ids = await this.redis.zrange(this.idx(boardId), '0', '-1');
    if (ids.length === 0) return [];
    const values = await this.redis.mget(ids.map((id) => this.key(boardId, id)));
    const members: PresenceMember[] = [];
    const stale: string[] = [];
    values.forEach((raw, i) => {
      if (raw) members.push(JSON.parse(raw) as PresenceMember);
      else stale.push(ids[i]!);
    });
    if (stale.length) await this.redis.zrem(this.idx(boardId), ...stale);
    return members;
  }
}
