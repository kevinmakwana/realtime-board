import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../playwright.config';
import { addCard, card, cardsIn, inviteViaApi, signInAs } from './helpers';

const titles = (page: Page, column: string) => cardsIn(page, column).locator('.card-title').allTextContents();
const columnNames = (page: Page) =>
  page
    .locator('section.lane[data-testid^="column-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));

test('cards and columns can be moved without dragging: Alt+arrows, header buttons and the card dialog', async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage();
  const grace = await ctxB.newPage();

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(`Keyboard ${Date.now()}`);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;
  await inviteViaApi(ada, E2E.webA, path, 'grace@example.test', 'editor');
  await signInAs(grace, E2E.webB, 'Grace Hopper');
  await grace.goto(`${E2E.webB}${path}`);
  await expect(grace.getByTestId('lanes')).toBeVisible();

  for (const title of ['One', 'Two', 'Three']) await addCard(ada, 'To do', title);
  await expect.poll(() => titles(grace, 'To do')).toEqual(['One', 'Two', 'Three']);

  await test.step('Alt+ArrowUp / Down reorder within a column and keep focus on the card', async () => {
    await card(ada, 'Three').focus();
    await ada.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => titles(ada, 'To do')).toEqual(['One', 'Three', 'Two']);
    await expect(card(ada, 'Three')).toBeFocused();
    await ada.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => titles(grace, 'To do')).toEqual(['Three', 'One', 'Two']);
    await expect(ada.getByTestId('move-announcement')).toHaveText('Moved “Three” to To do, position 1 of 3');
  });

  await test.step('Alt+ArrowRight moves it to the next column, for everyone, still focused', async () => {
    await ada.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => titles(grace, 'In progress')).toEqual(['Three']);
    await expect.poll(() => titles(grace, 'To do')).toEqual(['One', 'Two']);
    await expect(card(ada, 'Three')).toBeFocused();
    await expect(ada.getByTestId('move-announcement')).toHaveText('Moved “Three” to In progress, position 1 of 1');
  });

  await test.step('the card dialog has Column and Position selects for touch and screen readers', async () => {
    await card(ada, 'One').click();
    const dialog = ada.getByRole('dialog', { name: 'Card details' });
    await expect(dialog).toBeFocused();
    await dialog.getByLabel('Column').selectOption({ label: 'Done' });
    await expect.poll(() => titles(grace, 'Done')).toEqual(['One']);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(card(ada, 'One')).toBeFocused();
  });

  await test.step('column header buttons reorder lanes, and the name is a button for keyboard rename', async () => {
    await ada.getByRole('button', { name: 'Move column To do right' }).click();
    await expect.poll(() => columnNames(grace)).toEqual(['In progress', 'To do', 'Done']);
    await expect(ada.getByRole('button', { name: 'Move column To do right' })).toBeFocused();

    await ada.getByRole('button', { name: 'To do', exact: true }).focus();
    await ada.keyboard.press('Enter');
    await ada.getByLabel('Column name').fill('Backlog');
    await ada.keyboard.press('Enter');
    await expect.poll(() => columnNames(grace)).toEqual(['In progress', 'Backlog', 'Done']);
  });

  await ctxA.close();
  await ctxB.close();
});

test('Tab stays inside an open card dialog', async ({ page }) => {
  await signInAs(page, E2E.webA, 'Ada Lovelace');
  await page.getByLabel('New board name').fill(`Focus ${Date.now()}`);
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(page.getByTestId('lanes')).toBeVisible();
  await addCard(page, 'To do', 'Trap');
  await card(page, 'Trap').click();
  const dialog = page.getByRole('dialog', { name: 'Card details' });
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(card(page, 'Trap')).toBeFocused();
});
