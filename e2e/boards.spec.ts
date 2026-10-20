import { expect, test } from '@playwright/test';
import { E2E } from '../playwright.config';
import { inviteViaApi, signInAs } from './helpers';

test('the owner renames a board live for everyone, and deleting it cuts everyone off', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage();
  const grace = await ctxB.newPage();
  const original = `Plan ${Date.now()}`;
  const renamed = `${original} (final)`;

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(original);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;
  await inviteViaApi(ada, E2E.webA, path, 'grace@example.test', 'editor');
  await signInAs(grace, E2E.webB, 'Grace Hopper');
  await grace.goto(`${E2E.webB}${path}`);
  await expect(grace.getByTestId('board-title')).toHaveText(original);

  await test.step('only the owner gets a rename control', async () => {
    await expect(grace.getByTestId('board-title').getByRole('button')).toHaveCount(0);
    await expect(ada.getByTestId('board-title').getByRole('button')).toHaveCount(1);
  });

  await test.step('Ada renames it and Grace sees the new title without reloading', async () => {
    await ada.getByTestId('board-title').getByRole('button').click();
    const input = ada.getByLabel('Board name');
    await input.fill(renamed);
    await input.press('Enter');
    await expect(ada.getByTestId('board-title')).toHaveText(renamed);
    await expect(grace.getByTestId('board-title')).toHaveText(renamed);
  });

  await test.step('Escape abandons an edit', async () => {
    await ada.getByTestId('board-title').getByRole('button').click();
    await ada.getByLabel('Board name').fill('Never saved');
    await ada.getByLabel('Board name').press('Escape');
    await expect(ada.getByTestId('board-title')).toHaveText(renamed);
  });

  await test.step('the boards list shows the new name', async () => {
    await ada.getByRole('button', { name: 'Back to boards' }).click();
    await expect(ada.getByRole('link', { name: renamed })).toBeVisible();
    await ada.getByRole('link', { name: renamed }).click();
    await expect(ada.getByTestId('lanes')).toBeVisible();
  });

  await test.step('only the owner is offered Delete', async () => {
    await grace.getByTestId('share').click();
    await expect(grace.getByRole('button', { name: 'Delete board' })).toHaveCount(0);
    await grace.keyboard.press('Escape');
  });

  await test.step('Ada deletes the board: she is sent to the list and Grace is cut off', async () => {
    ada.once('dialog', (d) => void d.accept());
    await ada.getByTestId('share').click();
    await ada.getByRole('button', { name: 'Delete board' }).click();
    await expect(ada.getByRole('heading', { name: 'Boards' })).toBeVisible();
    await expect(ada.getByRole('link', { name: renamed })).toHaveCount(0);
    await expect(grace.getByTestId('no-access')).toBeVisible();
  });

  await ctxA.close();
  await ctxB.close();
});
