import { expect, test } from '@playwright/test';
import { E2E } from '../playwright.config';
import { addCard, card, inviteViaApi, signInAs } from './helpers';

const isoDay = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('due dates, assignees and labels are set in the card and show on the tile for everyone', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage(); // owner
  const grace = await ctxB.newPage(); // editor

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(`Fields ${Date.now()}`);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;
  await inviteViaApi(ada, E2E.webA, path, 'grace@example.test', 'editor');
  await addCard(ada, 'To do', 'Ship the beta');
  await signInAs(grace, E2E.webB, 'Grace Hopper');
  await grace.goto(`${E2E.webB}${path}`);
  await expect(card(grace, 'Ship the beta')).toBeVisible();

  await card(ada, 'Ship the beta').click();
  const modal = ada.getByRole('dialog', { name: 'Card details' });

  await test.step('Ada sets a due date in the past: the tile shows it as overdue on both screens', async () => {
    await modal.getByLabel('Due date').fill(isoDay(-3));
    await expect(card(ada, 'Ship the beta').getByTestId('due')).toHaveClass(/overdue/);
    await expect(card(grace, 'Ship the beta').getByTestId('due')).toHaveClass(/overdue/);
  });

  await test.step('today is flagged as due today, and clearing removes the badge', async () => {
    await modal.getByLabel('Due date').fill(isoDay(0));
    await expect(card(grace, 'Ship the beta').getByTestId('due')).toHaveClass(/today/);
    await modal.getByRole('button', { name: 'Clear due date' }).click();
    await expect(card(grace, 'Ship the beta').getByTestId('due')).toHaveCount(0);
    await expect(card(ada, 'Ship the beta').getByTestId('due')).toHaveCount(0);
  });

  await test.step('labels are added with Enter, deduplicated, and removable', async () => {
    const input = modal.getByLabel('Add label');
    await input.fill('bug');
    await input.press('Enter');
    await input.fill('Bug'); // same label, different case: not added twice
    await input.press('Enter');
    await input.fill('urgent');
    await input.press('Enter');
    await expect(card(grace, 'Ship the beta').getByTestId('label')).toHaveText(['bug', 'urgent']);

    await modal.getByRole('button', { name: 'Remove label bug' }).click();
    await expect(card(grace, 'Ship the beta').getByTestId('label')).toHaveText(['urgent']);
  });

  await test.step('assignees come from the board members and show as avatars', async () => {
    await modal.getByLabel('Grace Hopper').check();
    await expect(card(grace, 'Ship the beta').getByTestId('assignee')).toHaveAttribute('title', 'Grace Hopper');
    await modal.getByLabel('Ada Lovelace').check();
    await expect(card(ada, 'Ship the beta').getByTestId('assignee')).toHaveCount(2);
    await modal.getByLabel('Ada Lovelace').uncheck();
    await expect(card(grace, 'Ship the beta').getByTestId('assignee')).toHaveCount(1);
  });

  await test.step('Grace sees the values in her own copy of the card', async () => {
    await card(grace, 'Ship the beta').click();
    const theirs = grace.getByRole('dialog', { name: 'Card details' });
    await expect(theirs.getByLabel('Grace Hopper')).toBeChecked();
    await expect(theirs.getByRole('button', { name: 'Remove label urgent' })).toBeVisible();
  });

  await ctxA.close();
  await ctxB.close();
});

test('a viewer sees due date, assignees and labels but cannot change them', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage();
  const vic = await ctxB.newPage();

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(`Fields RO ${Date.now()}`);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;
  await inviteViaApi(ada, E2E.webA, path, 'grace@example.test', 'viewer');
  await addCard(ada, 'To do', 'Read only');
  await card(ada, 'Read only').click();
  await ada.getByRole('dialog', { name: 'Card details' }).getByLabel('Due date').fill(isoDay(5));
  await expect(card(ada, 'Read only').getByTestId('due')).toBeVisible();

  await signInAs(vic, E2E.webB, 'Grace Hopper');
  await vic.goto(`${E2E.webB}${path}`);
  await expect(card(vic, 'Read only').getByTestId('due')).toBeVisible();
  await card(vic, 'Read only').click();
  const modal = vic.getByRole('dialog', { name: 'Card details' });
  await expect(modal.getByLabel('Due date')).toBeDisabled();
  await expect(modal.getByLabel('Add label')).toHaveCount(0);
  await expect(modal.getByLabel('Ada Lovelace')).toBeDisabled();

  await ctxA.close();
  await ctxB.close();
});
