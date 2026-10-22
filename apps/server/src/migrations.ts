/** Gives every board that has an owner_id a matching owner member. Idempotent. */
export const BACKFILL_OWNERS_SQL = `
  INSERT INTO board_members (board_id, user_id, role)
  SELECT id, owner_id, 'owner' FROM boards WHERE owner_id IS NOT NULL
  ON CONFLICT (board_id, user_id) DO NOTHING;
`;

/** Ordered, append-only schema migrations. Bundled as strings so the server ships as one file. */
export const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE users (
        id          uuid PRIMARY KEY,
        email       text NOT NULL UNIQUE,
        name        text NOT NULL,
        color       text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE boards (
        id          uuid PRIMARY KEY,
        name        text NOT NULL,
        owner_id    uuid REFERENCES users(id) ON DELETE SET NULL,
        -- Per-board event sequence. Bumped inside the same transaction as every mutation.
        last_seq    integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE columns (
        id          uuid PRIMARY KEY,
        board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        name        text NOT NULL,
        position    text COLLATE "C" NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX columns_board_idx ON columns (board_id, position);

      CREATE TABLE cards (
        id          uuid PRIMARY KEY,
        board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        column_id   uuid NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
        title       text NOT NULL,
        description text NOT NULL DEFAULT '',
        position    text COLLATE "C" NOT NULL,
        version     integer NOT NULL DEFAULT 1,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX cards_board_idx ON cards (board_id);
      CREATE INDEX cards_column_idx ON cards (column_id, position);

      CREATE TABLE comments (
        id          uuid PRIMARY KEY,
        board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        card_id     uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        author_id   uuid NOT NULL REFERENCES users(id),
        body        text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX comments_card_idx ON comments (card_id, created_at);

      -- Append-only log that powers reconnect catch-up.
      CREATE TABLE board_events (
        board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        seq         integer NOT NULL,
        type        text NOT NULL,
        payload     jsonb NOT NULL,
        actor_id    uuid NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (board_id, seq)
      );
    `,
  },
  {
    id: 2,
    name: 'board membership',
    sql: `
      CREATE TABLE board_members (
        board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role       text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (board_id, user_id)
      );
      CREATE INDEX board_members_user_idx ON board_members (user_id);
      CREATE UNIQUE INDEX board_members_one_owner ON board_members (board_id) WHERE role = 'owner';

      CREATE TABLE board_invites (
        board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        email      text NOT NULL,
        role       text NOT NULL CHECK (role IN ('editor', 'viewer')),
        invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (board_id, email)
      );

      ${BACKFILL_OWNERS_SQL}
    `,
  },
  {
    id: 3,
    name: 'comment edit timestamp',
    sql: `
      ALTER TABLE comments ADD COLUMN edited_at timestamptz;
    `,
  },
  {
    id: 4,
    name: 'card due date, assignees and labels',
    sql: `
      ALTER TABLE cards
        ADD COLUMN due_date     date,
        ADD COLUMN assignee_ids uuid[] NOT NULL DEFAULT '{}',
        ADD COLUMN labels       text[] NOT NULL DEFAULT '{}';
    `,
  },
  {
    id: 5,
    name: 'event log retention index',
    sql: `
      CREATE INDEX board_events_created_idx ON board_events (created_at);
    `,
  },
];
