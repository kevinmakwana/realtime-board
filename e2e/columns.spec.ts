import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../playwright.config';
import { inviteViaApi, signInAs } from './helpers';

const columnNames = (page: Page) =>
  page
    .locator('section.lane[data-testid^="column-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));

test('dragging a column header reorders the lanes for everyone, live and after a reload', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage();
  const grace = await ctxB.newPage();

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(`Columns ${Date.now()}`);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;
  await inviteViaApi(ada, E2E.webA, path, 'grace@example.test', 'editor');
  await signInAs(grace, E2E.webB, 'Grace Hopper');
  await grace.goto(`${E2E.webB}${path}`);
  await expect(grace.getByTestId('lanes')).toBeVisible();

  expect(await columnNames(ada)).toEqual(['To do', 'In progress', 'Done']);

  await test.step('Ada drags "To do" to the end', async () => {
    const done = await ada.getByTestId('column-Done').boundingBox();
    await ada
      .getByTestId('column-To do')
      .locator('.lane-head')
      .dragTo(ada.getByTestId('column-Done'), {
        targetPosition: { x: done!.width * 0.8, y: 30 },
      });
    await expect.poll(() => columnNames(ada)).toEqual(['In progress', 'Done', 'To do']);
  });

  await test.step('Grace, on another server instance, sees it without reloading', async () => {
    await expect.poll(() => columnNames(grace)).toEqual(['In progress', 'Done', 'To do']);
  });

  await test.step('the order survives a reload', async () => {
    await grace.reload();
    await expect(grace.getByTestId('lanes')).toBeVisible();
    expect(await columnNames(grace)).toEqual(['In progress', 'Done', 'To do']);
  });

  await ctxA.close();
  await ctxB.close();
});
