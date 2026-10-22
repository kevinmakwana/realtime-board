import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';
import { E2E } from '../playwright.config';
import { addCard, card, signInAs } from './helpers';

test('a card with many comments loads the newest first and fetches earlier ones on request', async ({ page }) => {
  await signInAs(page, E2E.webA, 'Ada Lovelace');
  await page.getByLabel('New board name').fill(`Many comments ${Date.now()}`);
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(page.getByTestId('lanes')).toBeVisible();
  await addCard(page, 'To do', 'Busy card');
  const boardId = new URL(page.url()).pathname.split('/').at(-1)!;
  const cardId = (await card(page, 'Busy card').getAttribute('data-card-id'))!;
  const session = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('realtime-board.session') ?? 'null') as {
        token: string;
        user: { id: string; name: string };
      },
  );

  await test.step('55 comments are added, paced to stay inside the per-socket rate limit', async () => {
    const socket = io(E2E.webA, { auth: { token: session.token }, transports: ['websocket'], forceNew: true });
    const ack = <T>(event: string, payload: unknown) =>
      new Promise<T>((resolve) => socket.emit(event, payload, resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      await ack('board:join', { boardId });
      for (let i = 1; i <= 55; i++) {
        const res = await ack<{ ok: boolean }>('comment:add', {
          id: crypto.randomUUID(),
          boardId,
          cardId,
          body: `note ${i}`,
        });
        expect(res.ok).toBe(true);
        await new Promise((r) => setTimeout(r, 30));
      }
    } finally {
      socket.close();
    }
  });

  await page.reload();
  await expect(page.getByTestId('lanes')).toBeVisible();

  await test.step('the tile counts all of them, the dialog shows the newest 50', async () => {
    await expect(card(page, 'Busy card')).toContainText('55 comments');
    await card(page, 'Busy card').click();
    const comments = page.getByTestId('comment');
    await expect(comments).toHaveCount(50);
    await expect(comments.first()).toContainText('note 6');
    await expect(comments.last()).toContainText('note 55');
  });

  await test.step('"Show earlier comments" adds the other five, in order, and goes away', async () => {
    await page.getByRole('button', { name: 'Show earlier comments (5)' }).click();
    const comments = page.getByTestId('comment');
    await expect(comments).toHaveCount(55);
    await expect(comments.first()).toContainText('note 1');
    await expect(comments.nth(5)).toContainText('note 6');
    await expect(page.getByRole('button', { name: /Show earlier comments/ })).toHaveCount(0);
  });
});
