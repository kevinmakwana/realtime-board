import { expect, test } from '@playwright/test';
import { E2E } from '../playwright.config';
import { addCard, card, inviteViaApi, signInAs } from './helpers';

test('search filters cards by text and comments, and the activity feed follows the board live', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage();
  const grace = await ctxB.newPage();

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(`Search ${Date.now()}`);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;
  await inviteViaApi(ada, E2E.webA, path, 'grace@example.test', 'editor');
  await signInAs(grace, E2E.webB, 'Grace Hopper');
  await grace.goto(`${E2E.webB}${path}`);
  await expect(grace.getByTestId('lanes')).toBeVisible();

  await addCard(ada, 'To do', 'Fix login redirect');
  await addCard(ada, 'To do', 'Write release notes');
  await addCard(ada, 'In progress', 'Design onboarding');
  await expect(grace.getByTestId('card')).toHaveCount(3);

  await test.step('typing narrows the board to matching cards, with a count', async () => {
    const search = ada.getByLabel('Search cards');
    await search.fill('login');
    await expect(ada.getByTestId('card')).toHaveCount(1);
    await expect(card(ada, 'Fix login redirect')).toBeVisible();
    await expect(ada.getByTestId('search-count')).toHaveText('1 match');
    // Other people's boards are not affected.
    await expect(grace.getByTestId('card')).toHaveCount(3);
    await search.fill('');
    await expect(ada.getByTestId('card')).toHaveCount(3);
  });

  await test.step('it also finds words inside comments, and cards that appear while searching', async () => {
    await card(grace, 'Design onboarding').click();
    await grace.getByLabel('Write a comment').fill('check the Safari layout');
    await grace.getByLabel('Write a comment').press('Enter');
    await grace
      .getByRole('dialog', { name: 'Card details' })
      .getByRole('button', { name: 'Done', exact: true })
      .click();

    await ada.getByLabel('Search cards').fill('safari');
    await expect(ada.getByTestId('card')).toHaveCount(1);
    await expect(card(ada, 'Design onboarding')).toBeVisible();

    await addCard(grace, 'To do', 'Safari crash on iOS'); // arrives live and matches
    await expect(ada.getByTestId('card')).toHaveCount(2);
    await ada.getByLabel('Search cards').fill('zzz');
    await expect(ada.getByTestId('card')).toHaveCount(0);
    await expect(ada.getByTestId('search-count')).toHaveText('0 matches');
    await ada.getByLabel('Search cards').fill('');
  });

  await test.step('the activity panel tells the story in order, and updates live', async () => {
    await ada.getByTestId('activity-toggle').click();
    const items = ada.getByTestId('activity-item');
    await expect(items.first()).toContainText('Grace Hopper');
    await expect(items.first()).toContainText('added card “Safari crash on iOS”');
    await expect(ada.getByTestId('activity')).toContainText('Ada Lovelace added card “Fix login redirect”');
    await expect(ada.getByTestId('activity')).toContainText('Grace Hopper commented on “Design onboarding”');

    await card(grace, 'Safari crash on iOS').click();
    await grace.getByRole('button', { name: 'Delete card' }).click();
    await expect(items.first()).toContainText('Grace Hopper deleted card “Safari crash on iOS”');

    await ada.getByRole('button', { name: 'Close activity' }).click();
    await expect(ada.getByTestId('activity')).toHaveCount(0);
  });

  await ctxA.close();
  await ctxB.close();
});
