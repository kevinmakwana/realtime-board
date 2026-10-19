import type {
  AccessChange,
  AddMemberResult,
  GrantableRole,
  Invite,
  Member,
  MembersResponse,
  Role,
} from '@board/shared';
import type { PoolClient } from 'pg';
import type { Pool } from './db.js';
import { ServiceError } from './errors.js';
import { type Db, roleOf } from './roles.js';

const ROLE_ORDER = `CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END`;

/** Who is on a board and what they may do. Role checks for commands live in BoardService.commit(). */
export class MembershipService {
  constructor(
    private readonly pool: Pool,
    private readonly onAccessChanged: (change: AccessChange) => void,
  ) {}

  /** The actor's role; a non-member sees the same "not found" as for a board that does not exist. */
  private async requireRole(db: Db, boardId: string, actorId: string): Promise<Role> {
    const role = await roleOf(db, boardId, actorId);
    if (!role) throw new ServiceError('NOT_FOUND', 'Board not found');
    return role;
  }

  private async requireOwner(db: Db, boardId: string, actorId: string): Promise<void> {
    if ((await this.requireRole(db, boardId, actorId)) !== 'owner') {
      throw new ServiceError('FORBIDDEN', 'Only the board owner can do that');
    }
  }

  /**
   * Runs `fn` in a transaction holding the board row lock, the same lock every command takes. A role
   * change therefore waits for commands already past their role check and commits before any later
   * one: no write can land after the change that revoked it.
   */
  private async inBoardLock<T>(boardId: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT 1 FROM boards WHERE id = $1 FOR UPDATE', [boardId]);
      if (!lock.rowCount) throw new ServiceError('NOT_FOUND', 'Board not found');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async listMembers(boardId: string, actorId: string): Promise<MembersResponse> {
    const actor = await this.requireRole(this.pool, boardId, actorId);
    const { rows } = await this.pool.query(
      `SELECT m.user_id, m.role, u.name, u.color, u.email
         FROM board_members m JOIN users u ON u.id = m.user_id
        WHERE m.board_id = $1 ORDER BY ${ROLE_ORDER}, u.name`,
      [boardId],
    );
    const members: Member[] = rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      color: r.color,
      role: r.role,
      ...(actor === 'owner' && { email: r.email }),
    }));
    if (actor !== 'owner') return { members };
    const invites = await this.pool.query(
      'SELECT email, role FROM board_invites WHERE board_id = $1 ORDER BY created_at, email',
      [boardId],
    );
    return { members, invites: invites.rows.map((r): Invite => ({ email: r.email, role: r.role })) };
  }

  async addMember(boardId: string, actorId: string, email: string, role: GrantableRole): Promise<AddMemberResult> {
    await this.requireOwner(this.pool, boardId, actorId);
    const normalized = email.trim().toLowerCase();

    const found = await this.pool.query('SELECT id, name, color, email FROM users WHERE email = $1', [normalized]);
    const user = found.rows[0];
    if (user) {
      await this.pool.query(
        `INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (board_id, user_id) DO NOTHING`,
        [boardId, user.id, role],
      );
      await this.pool.query('DELETE FROM board_invites WHERE board_id = $1 AND email = $2', [boardId, normalized]);
      const current = (await roleOf(this.pool, boardId, user.id)) as Role;
      return { member: { userId: user.id, name: user.name, color: user.color, role: current, email: user.email } };
    }

    await this.pool.query(
      `INSERT INTO board_invites (board_id, email, role, invited_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, email) DO UPDATE SET role = EXCLUDED.role`,
      [boardId, normalized, role, actorId],
    );
    return { invite: { email: normalized, role } };
  }

  async setRole(boardId: string, actorId: string, userId: string, role: GrantableRole): Promise<void> {
    const changed = await this.inBoardLock(boardId, async (tx) => {
      await this.requireOwner(tx, boardId, actorId);
      const current = await roleOf(tx, boardId, userId);
      if (!current) throw new ServiceError('NOT_FOUND', 'That person is not on this board');
      if (current === 'owner') throw new ServiceError('FORBIDDEN', 'The owner role cannot be changed');
      await tx.query('UPDATE board_members SET role = $3 WHERE board_id = $1 AND user_id = $2', [
        boardId,
        userId,
        role,
      ]);
      return current !== role;
    });
    if (changed) this.onAccessChanged({ boardId, userId, role });
  }

  /** The owner can remove anyone but themselves; every other member can remove only themselves (leave). */
  async removeMember(boardId: string, actorId: string, userId: string): Promise<void> {
    await this.inBoardLock(boardId, async (tx) => {
      const actor = await this.requireRole(tx, boardId, actorId);
      if (actorId !== userId && actor !== 'owner') {
        throw new ServiceError('FORBIDDEN', 'Only the board owner can remove other people');
      }
      const target = await roleOf(tx, boardId, userId);
      if (!target) throw new ServiceError('NOT_FOUND', 'That person is not on this board');
      if (target === 'owner') throw new ServiceError('FORBIDDEN', 'The owner cannot be removed from their board');
      await tx.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [boardId, userId]);
    });
    // Only after COMMIT: sockets must never be told about a change that could still roll back.
    this.onAccessChanged({ boardId, userId, role: null });
  }

  async removeInvite(boardId: string, actorId: string, email: string): Promise<void> {
    await this.requireOwner(this.pool, boardId, actorId);
    await this.pool.query('DELETE FROM board_invites WHERE board_id = $1 AND email = $2', [
      boardId,
      email.trim().toLowerCase(),
    ]);
  }
}
