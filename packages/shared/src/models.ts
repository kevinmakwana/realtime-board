import { z } from 'zod';

export const idSchema = z.uuid();
/** Fractional-indexing key, see ordering.ts */
export const orderKeySchema = z.string().min(1).max(64);

export const userSchema = z.object({
  id: idSchema,
  email: z.string(),
  name: z.string(),
  color: z.string(),
});
export type User = z.infer<typeof userSchema>;

/** The subset of a user that is safe to show to other collaborators. */
export const publicUserSchema = userSchema.omit({ email: true });
export type PublicUser = z.infer<typeof publicUserSchema>;

export const boardSchema = z.object({
  id: idSchema,
  name: z.string(),
  createdAt: z.string(),
});
export type Board = z.infer<typeof boardSchema>;

export const roleSchema = z.enum(['owner', 'editor', 'viewer']);
export type Role = z.infer<typeof roleSchema>;
/** Roles an owner can hand out. There is exactly one owner per board. */
export const grantableRoleSchema = z.enum(['editor', 'viewer']);
export type GrantableRole = z.infer<typeof grantableRoleSchema>;
export const canWrite = (role: Role | null): boolean => role === 'owner' || role === 'editor';

export const boardWithRoleSchema = boardSchema.extend({ role: roleSchema });
export type BoardWithRole = z.infer<typeof boardWithRoleSchema>;

export const memberSchema = z.object({
  userId: idSchema,
  name: z.string(),
  color: z.string(),
  role: roleSchema,
  /** Only sent to the board owner. */
  email: z.string().optional(),
});
export type Member = z.infer<typeof memberSchema>;

export const inviteSchema = z.object({ email: z.string(), role: grantableRoleSchema });
export type Invite = z.infer<typeof inviteSchema>;

export type MembersResponse = { members: Member[]; invites?: Invite[] };
export type AddMemberResult = { member: Member } | { invite: Invite };

export const addMemberBody = z.object({ email: z.email().max(200), role: grantableRoleSchema });
export const setRoleBody = z.object({ role: grantableRoleSchema });

export const columnSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  name: z.string(),
  position: orderKeySchema,
});
export type Column = z.infer<typeof columnSchema>;

export const cardSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  columnId: idSchema,
  title: z.string(),
  description: z.string(),
  position: orderKeySchema,
  /** Incremented on every accepted change; clients send the version they based an edit on. */
  version: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type Card = z.infer<typeof cardSchema>;

export const commentSchema = z.object({
  id: idSchema,
  cardId: idSchema,
  boardId: idSchema,
  authorId: idSchema,
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof commentSchema>;

export const boardSnapshotSchema = z.object({
  board: boardSchema,
  columns: z.array(columnSchema),
  cards: z.array(cardSchema),
  comments: z.array(commentSchema),
  /** Last event sequence number included in this snapshot. */
  seq: z.number().int().nonnegative(),
});
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;

export const LIMITS = {
  boardName: 80,
  columnName: 60,
  cardTitle: 200,
  cardDescription: 5000,
  commentBody: 2000,
} as const;
