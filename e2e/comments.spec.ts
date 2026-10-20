import { expect, test } from '@playwright/test';
import { E2E } from '../playwright.config';
import { addCard, card, inviteViaApi, signInAs } from './helpers';

test('authors edit and delete their comments, and the owner can moderate', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage(); // owner
  const grace = await ctxB.newPage(); // editor

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(`Comments ${Date.now()}`);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;
  await inviteViaApi(ada, E2E.webA, path, 'grace@example.test', 'editor');
  await addCard(ada, 'To do', 'Write release notes');
  await signInAs(grace, E2E.webB, 'Grace Hopper');
  await grace.goto(`${E2E.webB}${path}`);
  await card(ada, 'Write release notes').click();
  await card(grace, 'Write release notes').click();

  const commentsOf = (page: typeof ada) => page.getByTestId('comment');
  const writeComment = async (page: typeof ada, text: string) => {
    await page.getByLabel('Write a comment').fill(text);
    await page.getByLabel('Write a comment').press('Enter');
  };

  await test.step('Grace comments and Ada sees it, with controls only where she may use them', async () => {
    await writeComment(grace, 'first draft');
    await expect(commentsOf(ada)).toHaveText([/first draft/]);
    await expect(commentsOf(grace).getByRole('button', { name: 'Edit comment' })).toHaveCount(1);
    await expect(commentsOf(grace).getByRole('button', { name: 'Delete comment' })).toHaveCount(1);
    // Ada owns the board: she may moderate (delete) but not edit Grace's words.
    await expect(commentsOf(ada).getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
    await expect(commentsOf(ada).getByRole('button', { name: 'Delete comment' })).toHaveCount(1);
  });

  await test.step('Grace edits her comment; Ada sees the new text marked as edited', async () => {
    await commentsOf(grace).getByRole('button', { name: 'Edit comment' }).click();
    const box = grace.getByLabel('Edit comment text');
    await expect(box).toHaveValue('first draft');
    await box.fill('final version');
    await grace.getByRole('button', { name: 'Save comment' }).click();
    await expect(commentsOf(ada)).toHaveText([/final version/]);
    await expect(commentsOf(ada).getByText('edited')).toBeVisible();
    await expect(commentsOf(grace).getByText('edited')).toBeVisible();
  });

  await test.step('cancelling an edit changes nothing', async () => {
    await commentsOf(grace).getByRole('button', { name: 'Edit comment' }).click();
    await grace.getByLabel('Edit comment text').fill('scrapped');
    await grace.getByRole('button', { name: 'Cancel edit' }).click();
    await expect(commentsOf(grace)).toHaveText([/final version/]);
  });

  await test.step('Grace cannot delete Ada’s comment, but can delete her own', async () => {
    await writeComment(ada, 'from the owner');
    await expect(commentsOf(grace)).toHaveCount(2);
    const adas = commentsOf(grace).filter({ hasText: 'from the owner' });
    await expect(adas.getByRole('button', { name: 'Delete comment' })).toHaveCount(0);
    await expect(adas.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);

    await commentsOf(grace)
      .filter({ hasText: 'final version' })
      .getByRole('button', { name: 'Delete comment' })
      .click();
    await expect(commentsOf(grace)).toHaveText([/from the owner/]);
    await expect(commentsOf(ada)).toHaveText([/from the owner/]);
  });

  await test.step('the owner deletes someone else’s comment', async () => {
    await writeComment(grace, 'off-topic');
    await expect(commentsOf(ada)).toHaveCount(2);
    await commentsOf(ada).filter({ hasText: 'off-topic' }).getByRole('button', { name: 'Delete comment' }).click();
    await expect(commentsOf(grace)).toHaveText([/from the owner/]);
  });

  await ctxA.close();
  await ctxB.close();
});
