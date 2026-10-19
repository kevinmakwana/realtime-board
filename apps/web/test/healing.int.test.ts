import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { keyBetween, selectCards } from '@board/shared';
import type { ServerInstance } from '../../server/src/server.js';
import { createWorld, startInstance } from '../../server/test/helpers.js';
import { BoardClient, type BoardSocket } from '../src/lib/boardClient';

/** The real client engine against a real server: a committed change whose broadcast never arrives. */
describe('healing a lost broadcast', () => {
  const world = createWorld();
  let server: ServerInstance;
  beforeAll(async () => {
    server = await startInstance('healing');
  });
  afterAll(async () => {
    await server.close();
    await world.close();
  });

  it('shows the missed change once the tab is visible again, without any later event', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);

    const ada = await world.newUser('Ada');
    const snap = await world.newBoard(ada.id);
    const socket: BoardSocket = io(`http://localhost:${server.port}`, {
      auth: { token: ada.token },
      transports: ['websocket'],
      forceNew: true,
    });
    const client = new BoardClient(socket, snap.board.id, { id: ada.id, name: 'Ada', color: '#0091ff' });
    try {
      await expect.poll(() => client.getSnapshot().status, { timeout: 5000 }).toBe('live');

      // Committed through the service only: nothing is emitted, exactly like a broadcast lost in transit.
      const columnId = snap.columns[0]!.id;
      await world.service.createCard(ada.id, {
        id: randomUUID(),
        boardId: snap.board.id,
        columnId,
        title: 'Missed broadcast',
        position: keyBetween(null, null),
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(selectCards(client.getSnapshot().state!, columnId)).toHaveLength(0); // still stale

      doc.dispatchEvent(new Event('visibilitychange'));
      await expect
        .poll(() => selectCards(client.getSnapshot().state!, columnId).map((c) => c.title), { timeout: 5000 })
        .toEqual(['Missed broadcast']);
      expect(client.getSnapshot().state?.seq).toBe(1);
      expect(client.getSnapshot().status).toBe('live');
    } finally {
      client.dispose();
      vi.unstubAllGlobals();
    }
  });
});
