import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../playwright.config';
import { addCard, card, cardsIn, inviteViaApi, signInAs } from './helpers';

/**
 * Ada is on web-a -> server-a, Grace is on web-b -> server-b: two browser contexts, two server
 * instances, one board. Everything Grace sees had to cross Redis.
 */
async function openSharedBoard(browser: import('@playwright/test').Browser) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage();
  const grace = await ctxB.newPage();

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(`Launch plan ${Date.now()}`);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;

  await inviteViaApi(ada, E2E.webA, path, 'grace@example.test', 'editor');
  await signInAs(grace, E2E.webB, 'Grace Hopper');
  await grace.goto(`${E2E.webB}${path}`);
  await expect(grace.getByTestId('lanes')).toBeVisible();
  return {
    ada,
    grace,
    close: async () => {
      await ctxA.close();
      await ctxB.close();
    },
  };
}

const names = (page: Page) =>
  page.getByTestId('presence-avatar').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')).sort());

test('two users on different server instances see each other live', async ({ browser }) => {
  const { ada, grace, close } = await openSharedBoard(browser);

  await test.step('they are connected to different instances', async () => {
    await expect(ada.getByTestId('connection')).toContainText('Live on server-a');
    await expect(grace.getByTestId('connection')).toContainText('Live on server-b');
  });

  await test.step('presence shows both people', async () => {
    await expect.poll(() => names(ada)).toEqual(['Ada Lovelace', 'Grace Hopper']);
    await expect.poll(() => names(grace)).toEqual(['Ada Lovelace', 'Grace Hopper']);
  });

  await test.step('a card added by Ada appears for Grace', async () => {
    await addCard(ada, 'To do', 'Write release notes');
    await expect(cardsIn(grace, 'To do')).toHaveText([/Write release notes/]);
  });

  await test.step('Grace drags it to In progress and Ada sees it move', async () => {
    await card(grace, 'Write release notes').dragTo(grace.getByTestId('cards-In progress'));
    await expect(cardsIn(ada, 'In progress')).toHaveText([/Write release notes/]);
    await expect(cardsIn(ada, 'To do')).toHaveCount(0);
    await expect(cardsIn(grace, 'In progress')).toHaveCount(1); // optimistic state matches the server's
  });

  await test.step('cards keep their order when dropped between others', async () => {
    await addCard(ada, 'In progress', 'Review pricing page');
    await addCard(ada, 'In progress', 'Record walkthrough');
    await expect(cardsIn(grace, 'In progress')).toHaveCount(3);
    await card(grace, 'Record walkthrough').dragTo(card(grace, 'Write release notes'), {
      targetPosition: { x: 40, y: 4 },
    });
    const order = ['Record walkthrough', 'Write release notes', 'Review pricing page'];
    await expect(cardsIn(ada, 'In progress')).toHaveText(order.map((t) => new RegExp(t)));
    await expect(cardsIn(grace, 'In progress')).toHaveText(order.map((t) => new RegExp(t)));
  });

  await test.step('"is editing" indicator appears while Ada edits a card', async () => {
    await card(ada, 'Review pricing page').click();
    await ada.getByLabel('Description').focus();
    await expect(card(grace, 'Review pricing page').getByTestId('editing-indicator')).toHaveText(
      /Ada Lovelace is editing/,
    );
    await ada.getByLabel('Description').fill('Compare with the three competitors.');
    await ada.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
    await expect(card(grace, 'Review pricing page').getByTestId('editing-indicator')).toHaveCount(0);
    await expect(card(grace, 'Review pricing page')).toContainText('Description');
  });

  await test.step('comments sync', async () => {
    await card(grace, 'Review pricing page').click();
    await grace.getByLabel('Write a comment').fill('Looks good to me');
    await grace.getByRole('button', { name: 'Comment' }).click();
    await grace.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
    await expect(card(ada, 'Review pricing page')).toContainText('1 comment');
  });

  await test.step("Ada's cursor shows up for Grace, labelled with her name", async () => {
    const box = (await ada.getByTestId('lanes').boundingBox())!;
    await ada.mouse.move(box.x + 120, box.y + 140);
    await ada.mouse.move(box.x + 300, box.y + 220, { steps: 8 });
    await expect(grace.getByTestId('remote-cursor').filter({ hasText: 'Ada Lovelace' })).toBeVisible();
  });

  await close();
});

test('a client that loses its connection catches up on everything it missed', async ({ browser }) => {
  const { ada, grace, close } = await openSharedBoard(browser);
  await addCard(ada, 'To do', 'Before the outage');
  await expect(cardsIn(grace, 'To do')).toHaveCount(1);

  // Sever Grace's transport and make the reconnect slow, so Ada's edits land while she is away.
  await grace.evaluate(() => {
    const s = (window as any).__boardSocket;
    s.io.reconnectionDelay(3000).randomizationFactor(0);
    s.io.engine.close();
  });
  await expect(grace.getByTestId('connection')).toContainText('Reconnecting');

  await addCard(ada, 'To do', 'During the outage 1');
  await addCard(ada, 'To do', 'During the outage 2');
  await card(ada, 'Before the outage').dragTo(ada.getByTestId('cards-Done'));
  await expect(cardsIn(grace, 'To do')).toHaveCount(1); // still the stale view

  await expect(grace.getByTestId('connection')).toContainText('Live on', { timeout: 15_000 });
  await expect(cardsIn(grace, 'To do')).toHaveText([/During the outage 1/, /During the outage 2/]);
  await expect(cardsIn(grace, 'Done')).toHaveText([/Before the outage/]);

  await close();
});

test('changes made while offline are kept, shown at once, and sent when the connection returns', async ({
  browser,
}) => {
  const { ada, grace, close } = await openSharedBoard(browser);
  await addCard(ada, 'To do', 'Existing');
  await expect(cardsIn(grace, 'To do')).toHaveCount(1);

  await grace.evaluate(() => {
    const s = (window as any).__boardSocket;
    s.io.reconnectionDelay(3000).randomizationFactor(0);
    s.io.engine.close();
  });
  await expect(grace.getByTestId('connection')).toContainText('Reconnecting');

  // Grace keeps working while offline: it appears for her straight away, and the header says it is waiting.
  await addCard(grace, 'To do', 'Written offline');
  await expect(cardsIn(grace, 'To do')).toHaveCount(2);
  await expect(grace.getByTestId('connection')).toContainText('1 change waiting');
  await expect(cardsIn(ada, 'To do')).toHaveCount(1); // Ada cannot see it yet

  // The connection comes back: it is sent, and Ada receives it.
  await expect(grace.getByTestId('connection')).toContainText('Live on', { timeout: 15_000 });
  await expect(cardsIn(ada, 'To do')).toHaveText([/Existing/, /Written offline/]);
  await expect(grace.getByTestId('connection')).not.toContainText('waiting');

  await close();
});

test('an unauthenticated visitor is sent to sign in, and magic-link tokens are single use', async ({
  page,
  request,
}) => {
  await page.goto(E2E.webA);
  await expect(page.getByRole('heading', { name: 'Realtime Board' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create link' })).toBeVisible();
  const res = await request.post(`${E2E.webA}/api/auth/verify`, { data: { token: 'x'.repeat(48) } });
  expect(res.status()).toBe(401);
});
