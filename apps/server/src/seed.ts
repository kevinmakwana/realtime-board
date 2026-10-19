import { keysBetween, type ClientEventPayload } from '@board/shared';
import { randomUUID } from 'node:crypto';
import { upsertUser } from './auth.js';
import { BoardService } from './boardService.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

for (const file of ['.env', '../../.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* ignore */
  }
}

// Entirely fictional people and tasks.
const people = [
  ['ada@example.test', 'Ada Lovelace'],
  ['grace@example.test', 'Grace Hopper'],
  ['linus@example.test', 'Linus Demo'],
] as const;

const cards: Record<string, [string, string][]> = {
  'To do': [
    ['Draft launch announcement', 'Short, friendly, no jargon.'],
    ['Collect customer quotes', ''],
    ['Pick a launch date', 'Avoid the end-of-quarter crunch.'],
  ],
  'In progress': [
    ['Build onboarding checklist', 'Three steps maximum.'],
    ['Record product walkthrough', ''],
  ],
  Done: [
    ['Finalize pricing page', ''],
    ['Set up status page', ''],
  ],
};

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await migrate(pool);
const service = new BoardService(pool);

const users = [];
for (const [email, name] of people) users.push(await upsertUser(pool, email, name));
const owner = users[0]!;

const snap = await service.createBoard(owner.id, 'Product Launch (demo)');
for (const person of users.slice(1)) {
  await pool.query(
    "INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING",
    [snap.board.id, person.id],
  );
}
for (const col of snap.columns) {
  const items = cards[col.name] ?? [];
  const positions = keysBetween(null, null, items.length);
  for (const [i, [title, description]] of items.entries()) {
    const id = randomUUID();
    const p: ClientEventPayload<'card:create'> = {
      id,
      boardId: snap.board.id,
      columnId: col.id,
      title,
      position: positions[i]!,
    };
    await service.createCard(owner.id, p);
    if (description) {
      await service.updateCard(owner.id, { id, boardId: snap.board.id, baseVersion: 1, description });
    }
  }
}

console.log(`Seeded board "${snap.board.name}" (${snap.board.id}) and users: ${people.map((p) => p[0]).join(', ')}`);
await pool.end();
