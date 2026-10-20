import { z } from 'zod';
import {
  LIMITS,
  type boardSnapshotSchema,
  cardSchema,
  columnSchema,
  commentSchema,
  idSchema,
  orderKeySchema,
  publicUserSchema,
  type Role,
} from './models.js';

/* ------------------------------------------------------------------ */
/* Server -> client: the persisted, sequenced board event log          */
/* ------------------------------------------------------------------ */

const eventBase = { seq: z.number().int().positive(), boardId: idSchema, actorId: idSchema, ts: z.string() };

export const boardEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('board.renamed'), name: z.string() }),
  z.object({ ...eventBase, type: z.literal('column.created'), column: columnSchema }),
  z.object({ ...eventBase, type: z.literal('column.updated'), column: columnSchema }),
  z.object({ ...eventBase, type: z.literal('column.deleted'), columnId: idSchema }),
  z.object({ ...eventBase, type: z.literal('card.created'), card: cardSchema }),
  z.object({ ...eventBase, type: z.literal('card.updated'), card: cardSchema }),
  z.object({ ...eventBase, type: z.literal('card.moved'), card: cardSchema }),
  z.object({ ...eventBase, type: z.literal('card.deleted'), cardId: idSchema }),
  z.object({ ...eventBase, type: z.literal('comment.added'), comment: commentSchema }),
]);
export type BoardEvent = z.infer<typeof boardEventSchema>;
export type BoardEventType = BoardEvent['type'];

/** Event as stored in the log, before a sequence number is assigned. */
export type NewBoardEvent = BoardEvent extends infer E ? (E extends BoardEvent ? Omit<E, 'seq' | 'ts'> : never) : never;

/* ------------------------------------------------------------------ */
/* Client -> server: commands (each acknowledged)                      */
/* ------------------------------------------------------------------ */

export const joinPayload = z.object({
  boardId: idSchema,
  /** Last event seq the client has applied; omit for a first join. */
  lastSeq: z.number().int().nonnegative().optional(),
});

/** Owner only. */
export const boardRenamePayload = z.object({
  boardId: idSchema,
  name: z.string().trim().min(1).max(LIMITS.boardName),
});

export const columnCreatePayload = z.object({
  id: idSchema,
  boardId: idSchema,
  name: z.string().trim().min(1).max(LIMITS.columnName),
  position: orderKeySchema,
});
export const columnRenamePayload = z.object({
  id: idSchema,
  boardId: idSchema,
  name: z.string().trim().min(1).max(LIMITS.columnName),
});
export const columnDeletePayload = z.object({ id: idSchema, boardId: idSchema });
/** Reorder: the new fractional key. The server answers with a `column.updated` event. */
export const columnMovePayload = z.object({ id: idSchema, boardId: idSchema, position: orderKeySchema });

export const cardCreatePayload = z.object({
  id: idSchema,
  boardId: idSchema,
  columnId: idSchema,
  title: z.string().trim().min(1).max(LIMITS.cardTitle),
  position: orderKeySchema,
});
export const cardUpdatePayload = z
  .object({
    id: idSchema,
    boardId: idSchema,
    baseVersion: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(LIMITS.cardTitle).optional(),
    description: z.string().max(LIMITS.cardDescription).optional(),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined, {
    message: 'nothing to update',
  });
export const cardMovePayload = z.object({
  id: idSchema,
  boardId: idSchema,
  baseVersion: z.number().int().nonnegative(),
  columnId: idSchema,
  position: orderKeySchema,
});
export const cardDeletePayload = z.object({
  id: idSchema,
  boardId: idSchema,
  baseVersion: z.number().int().nonnegative(),
});
export const commentAddPayload = z.object({
  id: idSchema,
  boardId: idSchema,
  cardId: idSchema,
  body: z.string().trim().min(1).max(LIMITS.commentBody),
});

export const cursorPayload = z.object({
  boardId: idSchema,
  /** Normalised 0..1 coordinates inside the board canvas. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export const editingPayload = z.object({
  boardId: idSchema,
  cardId: idSchema.nullable(),
});

/** Every client -> server event with its payload schema. Single source of truth. */
export const clientEventSchemas = {
  'board:join': joinPayload,
  'board:leave': z.object({ boardId: idSchema }),
  'board:rename': boardRenamePayload,
  'column:create': columnCreatePayload,
  'column:rename': columnRenamePayload,
  'column:delete': columnDeletePayload,
  'column:move': columnMovePayload,
  'card:create': cardCreatePayload,
  'card:update': cardUpdatePayload,
  'card:move': cardMovePayload,
  'card:delete': cardDeletePayload,
  'comment:add': commentAddPayload,
  'presence:cursor': cursorPayload,
  'presence:editing': editingPayload,
} as const;
export type ClientEventName = keyof typeof clientEventSchemas;
export type ClientEventPayload<E extends ClientEventName> = z.infer<(typeof clientEventSchemas)[E]>;

/* ------------------------------------------------------------------ */
/* Acks                                                                */
/* ------------------------------------------------------------------ */

export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'FORBIDDEN',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'NOT_JOINED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type AckError = {
  ok: false;
  code: ErrorCode;
  message: string;
  /** For VERSION_CONFLICT: the server's current copy so the client can resync. */
  current?: z.infer<typeof cardSchema>;
};
export type AckOk<T = object> = { ok: true; seq?: number } & T;
export type Ack<T = object> = AckOk<T> | AckError;

export const presenceMemberSchema = z.object({
  socketId: z.string(),
  user: publicUserSchema,
  instance: z.string(),
  editingCardId: idSchema.nullable(),
  joinedAt: z.number(),
});
export type PresenceMember = z.infer<typeof presenceMemberSchema>;

export type JoinResult =
  | { mode: 'snapshot'; snapshot: z.infer<typeof boardSnapshotSchema> }
  | { mode: 'replay'; events: BoardEvent[]; seq: number };

export type JoinAck = Ack<JoinResult & { instance: string; presence: PresenceMember[]; role: Role }>;

/* ------------------------------------------------------------------ */
/* Server -> client broadcasts                                         */
/* ------------------------------------------------------------------ */

export type CursorBroadcast = {
  socketId: string;
  userId: string;
  boardId: string;
  x: number;
  y: number;
};

export interface ServerToClientEvents {
  'board:event': (event: BoardEvent) => void;
  'presence:update': (payload: { boardId: string; members: PresenceMember[] }) => void;
  'presence:cursor': (cursor: CursorBroadcast) => void;
  /** Your role on a board changed (`null`: you were removed from it). */
  'board:access': (payload: { boardId: string; role: Role | null }) => void;
}

export type AccessChange = { boardId: string; userId: string; role: Role | null };

/** Events instances send each other through the Redis adapter (`io.serverSideEmit`). */
export interface InterServerEvents {
  'access:changed': (change: AccessChange) => void;
}

type AckFn<T = object> = (ack: Ack<T>) => void;

export interface ClientToServerEvents {
  'board:join': (p: ClientEventPayload<'board:join'>, ack: (a: JoinAck) => void) => void;
  'board:leave': (p: ClientEventPayload<'board:leave'>, ack?: AckFn) => void;
  'board:rename': (p: ClientEventPayload<'board:rename'>, ack: AckFn) => void;
  'column:create': (p: ClientEventPayload<'column:create'>, ack: AckFn) => void;
  'column:rename': (p: ClientEventPayload<'column:rename'>, ack: AckFn) => void;
  'column:delete': (p: ClientEventPayload<'column:delete'>, ack: AckFn) => void;
  'column:move': (p: ClientEventPayload<'column:move'>, ack: AckFn) => void;
  'card:create': (p: ClientEventPayload<'card:create'>, ack: AckFn) => void;
  'card:update': (p: ClientEventPayload<'card:update'>, ack: AckFn) => void;
  'card:move': (p: ClientEventPayload<'card:move'>, ack: AckFn) => void;
  'card:delete': (p: ClientEventPayload<'card:delete'>, ack: AckFn) => void;
  'comment:add': (p: ClientEventPayload<'comment:add'>, ack: AckFn) => void;
  'presence:cursor': (p: ClientEventPayload<'presence:cursor'>) => void;
  'presence:editing': (p: ClientEventPayload<'presence:editing'>, ack?: AckFn) => void;
}
